require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const isVercel = process.env.VERCEL === '1';
const isProduction = isVercel || process.env.NODE_ENV === 'production';
const databaseUrl = process.env.DATABASE_URL;
const schemaPath = path.join(__dirname, 'schema.sql');
const hasDatabaseCredentials = databaseUrl && !databaseUrl.includes('USERNAME:PASSWORD@HOST:PORT/DATABASE');
const pgConnectionString = databaseUrl?.replace(/([?&])sslmode=require(&?)/, (match, prefix, trailing) => prefix === '?' && trailing ? '?' : '');

// Credentials default to the store's fixed login but can be overridden per environment
// (set AUTH_USERNAME / AUTH_PASSWORD / SESSION_SECRET in Vercel to rotate without a deploy).
const AUTH_USERNAME = process.env.AUTH_USERNAME || 'STAR_ADMIN';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'fu3498_ee$';
const SESSION_COOKIE = 'star_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// Derived from the credentials so every serverless instance signs identically without shared storage.
const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update(`star-session::${AUTH_USERNAME}::${AUTH_PASSWORD}`).digest('hex');

if (!hasDatabaseCredentials) {
  console.warn('DATABASE_URL is not configured. Add the Aiven PostgreSQL URL to .env.');
}

const pool = hasDatabaseCredentials
  ? new Pool({
      connectionString: pgConnectionString,
      ssl: process.env.DB_SSL === 'false'
        ? false
        // Set DB_CA_CERT to the Aiven CA certificate to enable full verification.
        : process.env.DB_CA_CERT
          ? { ca: process.env.DB_CA_CERT }
          : { rejectUnauthorized: false }
    })
  : null;

// --- session helpers -------------------------------------------------------

function matches(candidate, expected) {
  const a = crypto.createHash('sha256').update(String(candidate)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function signSession(expiresAt) {
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(String(expiresAt)).digest('hex');
  return `${expiresAt}.${signature}`;
}

function isValidSession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [expiresAt, signature] = token.split('.');
  if (!/^\d+$/.test(expiresAt) || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(expiresAt).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return false;
  return Number(expiresAt) > Date.now();
}

function readCookie(request, name) {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function setSessionCookie(response, token, maxAgeMs) {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (isProduction) attributes.push('Secure');
  response.setHeader('Set-Cookie', attributes.join('; '));
}

function requireAuth(request, response, next) {
  if (isValidSession(readCookie(request, SESSION_COOKIE))) return next();
  return response.status(401).json({ error: 'Authentification requise.' });
}

// Throttles password guessing. Per-instance only, which is enough to stop scripted attempts.
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function tooManyAttempts(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailure(key) {
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
}

// --- middleware ------------------------------------------------------------

app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

// Only the browser assets are public. Serving __dirname would also expose
// server.js, schema.sql and package.json.
const sendAsset = (file) => (request, response) => response.sendFile(path.join(__dirname, file));
app.get('/', sendAsset('index.html'));
app.get('/index.html', sendAsset('index.html'));
app.get('/app.js', sendAsset('app.js'));
app.get('/styles.css', sendAsset('styles.css'));
app.use('/pics', express.static(path.join(__dirname, 'pics')));
app.get(['/debts', '/debts/*'], sendAsset('index.html'));
app.get(['/clients', '/clients/*'], sendAsset('index.html'));

// --- auth routes -----------------------------------------------------------

app.get('/api/session', (request, response) => {
  response.json({ authenticated: isValidSession(readCookie(request, SESSION_COOKIE)) });
});

app.post('/api/login', (request, response) => {
  const key = request.ip || 'unknown';
  if (tooManyAttempts(key)) {
    return response.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  }

  const { username, password } = request.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    recordFailure(key);
    return response.status(400).json({ error: 'Identifiant et mot de passe requis.' });
  }

  if (!matches(username, AUTH_USERNAME) || !matches(password, AUTH_PASSWORD)) {
    recordFailure(key);
    return response.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
  }

  loginAttempts.delete(key);
  setSessionCookie(response, signSession(Date.now() + SESSION_TTL_MS), SESSION_TTL_MS);
  return response.json({ ok: true });
});

app.post('/api/logout', (request, response) => {
  setSessionCookie(response, '', 0);
  return response.json({ ok: true });
});

// --- database --------------------------------------------------------------

// Creates the tables if they are missing. The relational tables are a legacy mirror:
// nothing reads from them, so they are no longer rebuilt on every request.
async function ensureSchema() {
  if (!pool) return;
  await pool.query(fs.readFileSync(schemaPath, 'utf8'));
}

let initializationPromise;

function initialize() {
  if (!initializationPromise) {
    initializationPromise = ensureSchema().catch((error) => {
      initializationPromise = undefined;
      throw error;
    });
  }
  return initializationPromise;
}

app.use('/api', async (request, response, next) => {
  try {
    await initialize();
    next();
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', async (request, response) => {
  if (!pool) return response.status(503).json({ ok: false, database: 'not-configured' });

  try {
    await pool.query('SELECT 1');
    return response.json({ ok: true, database: 'connected' });
  } catch (error) {
    console.error('Database health check failed:', error.message);
    return response.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.get('/api/state', requireAuth, async (request, response) => {
  if (!pool) return response.status(503).json({ error: 'Database is not configured.' });

  try {
    const result = await pool.query('SELECT state, updated_at FROM app_state WHERE id = 1');
    if (!result.rows.length) return response.status(404).json({ error: 'State has not been seeded yet.' });
    return response.json({ state: result.rows[0].state, updatedAt: result.rows[0].updated_at });
  } catch (error) {
    console.error('State read failed:', error.message);
    return response.status(500).json({ error: 'Could not read application state.' });
  }
});

app.put('/api/state', requireAuth, async (request, response) => {
  if (!pool) return response.status(503).json({ error: 'Database is not configured.' });

  if (!request.body || typeof request.body !== 'object' || !request.body.state) {
    return response.status(400).json({ error: 'A state object is required.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO app_state (id, state, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
       RETURNING updated_at`,
      [JSON.stringify(request.body.state)]
    );
    return response.json({ ok: true, updatedAt: result.rows[0].updated_at });
  } catch (error) {
    console.error('State write failed:', error.message);
    return response.status(500).json({ error: 'Could not save application state.' });
  }
});

app.use('/api', (request, response) => response.status(404).json({ error: 'Not found.' }));

app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  if (error?.type === 'entity.too.large') {
    console.error('Payload rejected: too large.');
    return response.status(413).json({ error: 'Les données dépassent la taille maximale autorisée.' });
  }
  console.error('Unhandled error:', error?.message);
  return response.status(500).json({ error: 'Erreur interne du serveur.' });
});

async function start() {
  try {
    await initialize();
    app.listen(port, () => console.log(`STAR server running at http://localhost:${port}`));
  } catch (error) {
    console.error('Server startup failed:', error.message);
    process.exitCode = 1;
  }
}

if (!isVercel) start();

module.exports = app;
