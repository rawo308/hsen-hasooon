require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool, types } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const isVercel = process.env.VERCEL === '1';
const isProduction = isVercel || process.env.NODE_ENV === 'production';
const databaseUrl = process.env.DATABASE_URL;
const schemaPath = path.join(__dirname, 'schema.sql');
const hasDatabaseCredentials = databaseUrl && !databaseUrl.includes('USERNAME:PASSWORD@HOST:PORT/DATABASE');
const pgConnectionString = databaseUrl?.replace(/([?&])sslmode=require(&?)/, (match, prefix, trailing) => prefix === '?' && trailing ? '?' : '');

// NUMERIC arrives as a string by default, which would turn every total into
// string concatenation on the way out.
types.setTypeParser(types.builtins.NUMERIC, (value) => (value === null ? null : Number(value)));
// DATE would otherwise be turned into a Date, and reading it back through UTC
// shifts the calendar day for any timezone that is not UTC -- Gabon is UTC+1. An
// expense date is a calendar day, not an instant, so keep the text as sent.
types.setTypeParser(types.builtins.DATE, (value) => value);

// Credentials default to the store's fixed login but can be overridden per environment
// (set AUTH_USERNAME / AUTH_PASSWORD / SESSION_SECRET in Vercel to rotate without a deploy).
const AUTH_USERNAME = process.env.AUTH_USERNAME || 'H&H_ADMIN';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'f8_iG3$s$$';
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
app.use(express.json({ limit: '1mb' }));

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

// Registered ahead of the schema-init middleware below: when the database is
// unreachable that middleware throws, and health is the one route that has to
// keep answering precisely then.
// Says enough to tell a missing environment variable from an unreachable server,
// which is the difference between a dashboard problem and a database problem.
// The host is named; the credentials never are.
function databaseTarget() {
  if (!databaseUrl) return null;
  try {
    const parsed = new URL(databaseUrl);
    return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
  } catch {
    return 'unparseable';
  }
}

app.get('/api/health', async (request, response) => {
  if (!pool) {
    return response.status(503).json({
      ok: false,
      database: 'not-configured',
      reason: !databaseUrl
        ? 'DATABASE_URL is not set in this environment.'
        : 'DATABASE_URL is still the example placeholder.',
      target: databaseTarget()
    });
  }

  try {
    await pool.query('SELECT 1');
    return response.json({ ok: true, database: 'connected', target: databaseTarget() });
  } catch (error) {
    console.error('Database health check failed:', error.message);
    return response.status(503).json({
      ok: false,
      database: 'unavailable',
      reason: error.message,
      target: databaseTarget()
    });
  }
});

app.use('/api', async (request, response, next) => {
  try {
    await initialize();
    next();
  } catch (error) {
    next(error);
  }
});

// Rejects a request that reached a data route without a database rather than
// letting it fail deeper with a confusing message.
function requireDatabase(request, response, next) {
  if (!pool) return response.status(503).json({ error: 'La base de données n’est pas configurée.' });
  return next();
}

async function inTransaction(run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Thrown by the handlers below to turn a rule violation into a 4xx rather than
// a 500, while still rolling the transaction back.
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wraps a handler so a rejected promise reaches the error middleware instead of
// hanging the request.
const route = (handler) => (request, response, next) => handler(request, response).catch(next);

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

function requiredText(value, label, { max = 200 } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new RequestError(400, `${label} est obligatoire.`);
  if (text.length > max) throw new RequestError(400, `${label} dépasse ${max} caractères.`);
  return text;
}

function optionalText(value, { max = 2000 } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) throw new RequestError(400, `Ce texte dépasse ${max} caractères.`);
  return text;
}

function positiveAmount(value, label) {
  const amount = money(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new RequestError(400, `${label} doit être supérieur à 0.`);
  return amount;
}

function nonNegativeAmount(value, label) {
  const amount = money(value);
  if (!Number.isFinite(Number(value)) || amount < 0) throw new RequestError(400, `${label} ne peut pas être négatif.`);
  return amount;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || !Number.isInteger(number)) {
    throw new RequestError(400, `${label} doit être un entier positif ou nul.`);
  }
  return number;
}

// --- row mappers -----------------------------------------------------------
// The browser's vocabulary is camelCase; these keep the column names out of it.

const toProduct = (row) => ({
  id: row.id,
  name: row.name,
  sellingPrice: Number(row.selling_price),
  stock: row.stock,
  lowStockThreshold: row.low_stock_threshold,
  description: row.description
});

const toExpense = (row) => ({
  id: row.id,
  type: row.type,
  amount: Number(row.amount),
  // A DATE column comes back as a Date at UTC midnight; the app wants the plain
  // YYYY-MM-DD it submitted.
  date: row.expense_date instanceof Date ? row.expense_date.toISOString().slice(0, 10) : String(row.expense_date),
  note: row.note,
  createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
});

const toSettings = (row) => ({
  storeName: row?.store_name ?? '',
  storePhone: row?.store_phone ?? '',
  storeAddress: row?.store_address ?? '',
  storeEmail: row?.store_email ?? '',
  receiptFooter: row?.receipt_footer ?? '',
  countryOfOrigin: row?.country_of_origin ?? ''
});

function invoiceStatus(totalAmount, amountPaid) {
  if (totalAmount - amountPaid <= 0) return 'Payée';
  return amountPaid > 0 ? 'Partiellement payée' : 'Impayée';
}

// Only a sale carries a tender and a status; the other four types are movements
// of stock, so they stop at the common fields below.
const CUSTOMER_TYPES = new Set(['sale', 'return']);

function toSale(row) {
  const totalAmount = Number(row.total_amount);
  const amountPaid = row.type !== 'sale'
    ? 0
    : row.payment_method === 'cash' ? totalAmount : Number(row.paid || 0);

  const sale = {
    id: row.id,
    type: row.type,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    customerId: row.customer_id,
    totalAmount,
    discount: Number(row.discount || 0),
    discountPercent: Number(row.discount_percent || 0),
    items: (row.items || []).map((item) => ({
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      subtotal: Number(item.subtotal)
    }))
  };

  if (row.type === 'return') {
    sale.cashRefund = Number(row.cash_refund || 0);
    sale.debtCredit = Math.max(0, money(totalAmount - sale.cashRefund));
    return sale;
  }
  if (row.type === 'purchase') {
    sale.supplier = row.supplier || '';
    return sale;
  }
  if (row.type === 'waste') {
    sale.reason = row.reason || '';
    return sale;
  }
  if (row.type === 'adjustment') return sale;

  sale.paymentMethod = row.payment_method;
  sale.paymentType = row.payment_type;
  sale.amountPaid = amountPaid;
  sale.debtAmount = Math.max(0, money(totalAmount - amountPaid));
  sale.status = invoiceStatus(totalAmount, amountPaid);
  return sale;
}

// --- read queries ----------------------------------------------------------

const SALE_COLUMNS = `
  s.id, s.type, s.created_at, s.customer_id, s.payment_method, s.payment_type,
  s.total_amount, s.discount, s.discount_percent, s.supplier, s.reason, s.cash_refund, p.paid,
  COALESCE((
    SELECT json_agg(json_build_object(
             'productId', i.product_id, 'productName', i.product_name,
             'quantity', i.quantity, 'unitPrice', i.unit_price, 'subtotal', i.subtotal
           ) ORDER BY i.id)
    FROM sale_items i WHERE i.sale_id = s.id
  ), '[]'::json) AS items`;

async function readSales(client, where = '', params = []) {
  const { rows } = await client.query(
    `SELECT ${SALE_COLUMNS}
     FROM sales s
     LEFT JOIN sale_payments p ON p.sale_id = s.id
     ${where}
     ORDER BY s.created_at DESC`,
    params
  );
  return rows.map(toSale);
}

async function readSale(client, id) {
  const [sale] = await readSales(client, 'WHERE s.id = $1', [id]);
  return sale || null;
}

async function readCustomers(client, where = '', params = []) {
  const { rows } = await client.query(
    `SELECT c.id, c.name, c.phone, c.address,
            t.total_purchased, t.total_paid, t.balance,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id', d.id, 'type', d.type, 'amount', d.amount,
                       'date', d.transaction_date, 'saleId', d.sale_id,
                       'returnSaleId', d.return_sale_id
                     ) ORDER BY d.transaction_date, d.id)
              FROM debt_transactions d WHERE d.customer_id = c.id
            ), '[]'::json) AS debt_history
     FROM customers c
     LEFT JOIN customer_totals t ON t.customer_id = c.id
     ${where}
     ORDER BY c.name`,
    params
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    totalPurchased: Number(row.total_purchased || 0),
    totalPaid: Number(row.total_paid || 0),
    balance: Number(row.balance || 0),
    debtHistory: (row.debt_history || []).map((entry) => ({
      id: entry.id,
      type: entry.type,
      amount: Number(entry.amount),
      date: entry.date,
      saleId: entry.saleId,
      // Set when this credit came from a return rather than from money paid, so
      // a refund is not read back as cash received.
      returnSaleId: entry.returnSaleId ?? null
    }))
  }));
}

async function readCustomer(client, id) {
  const [customer] = await readCustomers(client, 'WHERE c.id = $1', [id]);
  return customer || null;
}

async function readProducts(client, where = '', params = []) {
  const { rows } = await client.query(
    `SELECT id, name, selling_price, stock, low_stock_threshold, description
     FROM products ${where} ORDER BY name`,
    params
  );
  return rows.map(toProduct);
}

async function readExpenses(client) {
  const { rows } = await client.query(
    'SELECT id, type, amount, expense_date, note, created_at, updated_at FROM expenses ORDER BY expense_date DESC, created_at DESC'
  );
  return rows.map(toExpense);
}

async function readSettings(client) {
  const { rows } = await client.query('SELECT * FROM store_settings WHERE id = 1');
  return toSettings(rows[0]);
}

// --- health & hydration ----------------------------------------------------

// The one read the app makes on load: everything it renders, in a single round
// trip. Every mutation below returns just the records it touched.
app.get('/api/state', requireAuth, requireDatabase, route(async (request, response) => {
  const client = await pool.connect();
  try {
    const [settings, products, customers, sales, expenses] = await Promise.all([
      readSettings(client),
      readProducts(client),
      readCustomers(client),
      readSales(client),
      readExpenses(client)
    ]);
    response.json({ state: { settings, products, customers, sales, expenses } });
  } finally {
    client.release();
  }
}));

// --- settings --------------------------------------------------------------

app.get('/api/settings', requireAuth, requireDatabase, route(async (request, response) => {
  response.json({ settings: await readSettings(pool) });
}));

app.put('/api/settings', requireAuth, requireDatabase, route(async (request, response) => {
  const body = request.body || {};
  const { rows } = await pool.query(
    `UPDATE store_settings
     SET store_name = $1, store_phone = $2, store_address = $3, store_email = $4,
         receipt_footer = $5, country_of_origin = $6, updated_at = NOW()
     WHERE id = 1 RETURNING *`,
    [
      optionalText(body.storeName, { max: 200 }),
      optionalText(body.storePhone, { max: 50 }),
      optionalText(body.storeAddress, { max: 300 }),
      optionalText(body.storeEmail, { max: 200 }),
      optionalText(body.receiptFooter, { max: 500 }),
      optionalText(body.countryOfOrigin, { max: 200 })
    ]
  );
  response.json({ settings: toSettings(rows[0]) });
}));

// --- products --------------------------------------------------------------

// LOWER(TRIM(name)) is uniquely indexed, so a clash surfaces as 23505. Catching
// it here turns a 500 into the sentence the operator needs.
function rejectDuplicateProduct(error) {
  if (error?.code === '23505' && /products_name_unique/.test(error.constraint || '')) {
    throw new RequestError(409, 'Un produit portant ce nom existe déjà.');
  }
  throw error;
}

function productPayload(body) {
  return {
    name: requiredText(body?.name, 'Le nom du produit'),
    sellingPrice: nonNegativeAmount(body?.sellingPrice, 'Le prix de vente'),
    lowStockThreshold: nonNegativeInteger(body?.lowStockThreshold ?? 10, 'Le seuil de stock bas'),
    description: optionalText(body?.description)
  };
}

app.get('/api/products', requireAuth, requireDatabase, route(async (request, response) => {
  response.json({ products: await readProducts(pool) });
}));

app.post('/api/products', requireAuth, requireDatabase, route(async (request, response) => {
  const payload = productPayload(request.body);
  const stock = nonNegativeInteger(request.body?.stock ?? 0, 'Le stock de départ');
  const { rows } = await pool.query(
    `INSERT INTO products (id, name, selling_price, stock, low_stock_threshold, description)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [newId('prod'), payload.name, payload.sellingPrice, stock, payload.lowStockThreshold, payload.description]
  ).catch(rejectDuplicateProduct);
  response.status(201).json({ product: toProduct(rows[0]) });
}));

app.put('/api/products/:id', requireAuth, requireDatabase, route(async (request, response) => {
  const payload = productPayload(request.body);
  // Stock is deliberately not settable here: it moves through sales, returns and
  // the stock endpoint below, never through an edit of the product's details.
  const { rows } = await pool.query(
    `UPDATE products SET name = $2, selling_price = $3, low_stock_threshold = $4, description = $5, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [request.params.id, payload.name, payload.sellingPrice, payload.lowStockThreshold, payload.description]
  ).catch(rejectDuplicateProduct);
  if (!rows.length) throw new RequestError(404, 'Produit introuvable.');
  response.json({ product: toProduct(rows[0]) });
}));

// The manual correction, for a recount or a crate found at the back. Send the
// counted quantity as `target` and the server works out the difference against
// the locked row, so two people counting at once cannot both apply their delta.
// `amount` is still accepted as a signed difference.
app.post('/api/products/:id/stock', requireAuth, requireDatabase, route(async (request, response) => {
  const body = request.body || {};
  const hasTarget = body.target !== undefined && body.target !== null && body.target !== '';
  const target = hasTarget ? nonNegativeInteger(body.target, 'Le stock compté') : null;
  const note = optionalText(body.note, { max: 200 });

  const result = await inTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [request.params.id]);
    if (!rows.length) throw new RequestError(404, 'Produit introuvable.');
    const before = rows[0];

    const delta = hasTarget ? target - before.stock : Math.trunc(Number(body.amount));
    if (!Number.isFinite(delta) || !Number.isInteger(delta) || delta === 0) {
      throw new RequestError(400, hasTarget
        ? 'Le stock compté est déjà celui enregistré.'
        : 'La quantité doit être un entier différent de 0.');
    }
    if (before.stock + delta < 0) {
      throw new RequestError(409, `Le stock ne peut pas descendre sous 0 (${before.stock} actuellement).`);
    }

    const { rows: updated } = await client.query(
      'UPDATE products SET stock = stock + $2, updated_at = NOW() WHERE id = $1 RETURNING *',
      [before.id, delta]
    );

    // Valued at zero: no money changed hands, only the count on the shelf.
    const type = delta > 0 ? 'adjustment' : 'adjustment_out';
    const saleId = newId(TRANSACTION_TYPES[type].idPrefix);
    await client.query(
      `INSERT INTO sales (id, type, created_at, total_amount, reason) VALUES ($1, $2, NOW(), 0, $3)`,
      [saleId, type, note]
    );
    await client.query(
      `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal)
       VALUES ($1, $2, $3, $4, 0, 0)`,
      [saleId, before.id, before.name, Math.abs(delta)]
    );

    return { product: toProduct(updated[0]), sale: await readSale(client, saleId), delta };
  });

  response.json(result);
}));

app.delete('/api/products/:id', requireAuth, requireDatabase, route(async (request, response) => {
  // sale_items.product_id is ON DELETE SET NULL, so past receipts keep their
  // product_name and stay readable.
  const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1', [request.params.id]);
  if (!rowCount) throw new RequestError(404, 'Produit introuvable.');
  response.json({ ok: true });
}));

// --- customers -------------------------------------------------------------

function customerPayload(body) {
  return {
    name: requiredText(body?.name, 'Le nom du client'),
    phone: requiredText(body?.phone, 'Le téléphone du client', { max: 50 }),
    address: optionalText(body?.address, { max: 300 })
  };
}

app.get('/api/customers', requireAuth, requireDatabase, route(async (request, response) => {
  response.json({ customers: await readCustomers(pool) });
}));

app.post('/api/customers', requireAuth, requireDatabase, route(async (request, response) => {
  const payload = customerPayload(request.body);
  const id = newId('cust');
  await pool.query('INSERT INTO customers (id, name, phone, address) VALUES ($1, $2, $3, $4)', [
    id,
    payload.name,
    payload.phone,
    payload.address
  ]);
  response.status(201).json({ customer: await readCustomer(pool, id) });
}));

app.put('/api/customers/:id', requireAuth, requireDatabase, route(async (request, response) => {
  const payload = customerPayload(request.body);
  const { rowCount } = await pool.query(
    'UPDATE customers SET name = $2, phone = $3, address = $4, updated_at = NOW() WHERE id = $1',
    [request.params.id, payload.name, payload.phone, payload.address]
  );
  if (!rowCount) throw new RequestError(404, 'Client introuvable.');
  response.json({ customer: await readCustomer(pool, request.params.id) });
}));

app.delete('/api/customers/:id', requireAuth, requireDatabase, route(async (request, response) => {
  const { rows } = await pool.query('SELECT balance FROM customer_totals WHERE customer_id = $1', [request.params.id]);
  if (!rows.length) throw new RequestError(404, 'Client introuvable.');
  if (Number(rows[0].balance) > 0) throw new RequestError(409, 'Ce client a encore une dette impayée.');
  // Their sales stay, with customer_id set to NULL, so the revenue history holds.
  await pool.query('DELETE FROM customers WHERE id = $1', [request.params.id]);
  response.json({ ok: true });
}));

// --- sales & returns -------------------------------------------------------

// How each transaction type behaves. Keeping it as data rather than a chain of
// ifs is what stops the handler below from turning into a thicket as the
// vocabulary grows.
//
//   stock       what one unit on a line does to products.stock
//   lockStock   take FOR UPDATE and refuse to go past what is on the shelf
//   priceSource where a line's unit price comes from
//   idPrefix    prefix for the generated transaction id
const TRANSACTION_TYPES = {
  sale:       { stock: -1, lockStock: true,  priceSource: 'catalogue', idPrefix: 'sale' },
  return:     { stock: +1, lockStock: false, priceSource: 'catalogue', idPrefix: 'return' },
  // The only type where the browser's price is the truth: it is what the shop
  // actually paid, and nothing in the catalogue knows it.
  purchase:   { stock: +1, lockStock: false, priceSource: 'client',    idPrefix: 'purchase' },
  // Written off at selling price, so the figure is the revenue lost.
  waste:      { stock: -1, lockStock: true,  priceSource: 'catalogue', idPrefix: 'waste' },
  adjustment: { stock: +1, lockStock: false, priceSource: 'zero',      idPrefix: 'adjust' },
  // A recount can find fewer units as easily as more, so the correction goes both
  // ways. Downward locks the row and cannot push stock below zero.
  adjustment_out: { stock: -1, lockStock: true, priceSource: 'zero',    idPrefix: 'adjust' }
};

const WASTE_REASONS = ['Pourriture', 'Casse', 'Invendu', 'Vol', 'Autre'];

// Prices and stock are read inside the transaction, so the total is the store's
// own and two registers cannot oversell the same unit.
async function priceItems(client, rawItems, { lockStock, priceSource = 'catalogue' }) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new RequestError(400, 'Le panier est vide.');
  if (rawItems.length > 200) throw new RequestError(400, 'Le panier contient trop de lignes.');

  const quantities = new Map();
  const clientPrices = new Map();
  for (const item of rawItems) {
    const productId = requiredText(item?.productId, 'Le produit', { max: 100 });
    const quantity = nonNegativeInteger(item?.quantity, 'La quantité');
    if (!quantity) throw new RequestError(400, 'La quantité doit être supérieure à 0.');
    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
    if (priceSource === 'client') {
      // Two lines for the same product merge, so the last price given wins.
      clientPrices.set(productId, nonNegativeAmount(item?.unitPrice, 'Le prix d’achat'));
    }
  }

  const ids = [...quantities.keys()];
  const { rows } = await client.query(
    `SELECT id, name, selling_price, stock FROM products WHERE id = ANY($1::text[])${lockStock ? ' FOR UPDATE' : ''}`,
    [ids]
  );
  const byId = new Map(rows.map((row) => [row.id, row]));

  return ids.map((productId) => {
    const product = byId.get(productId);
    if (!product) throw new RequestError(400, 'Un produit du panier n’existe plus.');
    const quantity = quantities.get(productId);
    if (lockStock && quantity > product.stock) {
      throw new RequestError(409, `Stock insuffisant pour ${product.name} (${product.stock} restant).`);
    }
    const unitPrice = priceSource === 'client'
      ? clientPrices.get(productId)
      : priceSource === 'zero' ? 0 : Number(product.selling_price);
    return { productId, productName: product.name, quantity, unitPrice, subtotal: money(unitPrice * quantity) };
  });
}

// Pays `amount` off a customer's unpaid invoices, oldest first, as ordinary
// payment rows. Written this way so sale_payments and customer_totals need no
// special case for a refund -- to them it is simply money received.
//
// Two callers, distinguished only by what they pass:
//   a return   -- returnSaleId set, so the credits die with the return
//   a payment  -- the customer handing over money against their whole balance
//
// Returns `left`, what could not be absorbed (for a return, the part that has to
// leave the till in cash), and `applied`, the invoices it touched.
async function creditCustomerDebt(client, { customerId, amount, returnSaleId = null, idPrefix = 'credit' }) {
  const { rows } = await client.query(
    `SELECT s.id, (s.total_amount - COALESCE(p.paid, 0))::numeric AS outstanding
     FROM sales s
     LEFT JOIN sale_payments p ON p.sale_id = s.id
     WHERE s.customer_id = $1 AND s.type = 'sale' AND s.payment_method = 'debt'
       AND s.total_amount - COALESCE(p.paid, 0) > 0
     ORDER BY s.created_at, s.id
     FOR UPDATE OF s`,
    [customerId]
  );

  const applied = [];
  let left = amount;
  for (const invoice of rows) {
    if (left <= 0) break;
    const part = money(Math.min(left, Number(invoice.outstanding)));
    if (part <= 0) continue;
    await client.query(
      `INSERT INTO debt_transactions (id, customer_id, sale_id, return_sale_id, type, amount, transaction_date)
       VALUES ($1, $2, $3, $4, 'payment', $5, NOW())`,
      [newId(idPrefix), customerId, invoice.id, returnSaleId, part]
    );
    applied.push({ saleId: invoice.id, amount: part });
    left = money(left - part);
  }
  return { left, applied };
}

app.get('/api/sales', requireAuth, requireDatabase, route(async (request, response) => {
  response.json({ sales: await readSales(pool) });
}));

app.post('/api/sales', requireAuth, requireDatabase, route(async (request, response) => {
  const body = request.body || {};
  const type = Object.prototype.hasOwnProperty.call(TRANSACTION_TYPES, body.type) ? body.type : 'sale';
  const rules = TRANSACTION_TYPES[type];
  // A supplier delivery and a write-off have no customer, whatever was sent.
  const customerId = CUSTOMER_TYPES.has(type) && typeof body.customerId === 'string' && body.customerId
    ? body.customerId
    : null;

  const result = await inTransaction(async (client) => {
    if (customerId) {
      const { rowCount } = await client.query('SELECT 1 FROM customers WHERE id = $1', [customerId]);
      if (!rowCount) throw new RequestError(400, 'Client introuvable.');
    }

    const items = await priceItems(client, body.items, rules);
    const subtotal = money(items.reduce((sum, item) => sum + item.subtotal, 0));

    // Only a sale is discountable; nothing else is being negotiated.
    const discountPercent = type === 'sale' ? Number(body.discountPercent || 0) : 0;
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      throw new RequestError(400, 'La remise doit être comprise entre 0 et 100 %.');
    }
    const discount = money(subtotal * discountPercent / 100);
    const totalAmount = money(subtotal - discount);

    let paymentMethod = null;
    let paymentType = null;
    let deposit = 0;
    let supplier = '';
    let reason = '';

    if (type === 'sale') {
      const tender = body.paymentType;
      if (!['cash', 'partial', 'debt'].includes(tender)) throw new RequestError(400, 'Mode de paiement invalide.');
      if (tender !== 'cash' && !customerId) throw new RequestError(400, 'Une vente à crédit exige un client.');

      paymentType = tender;
      paymentMethod = tender === 'cash' ? 'cash' : 'debt';

      if (tender === 'partial') {
        deposit = positiveAmount(body.partialAmount, 'L’acompte');
        if (deposit >= totalAmount) throw new RequestError(400, 'L’acompte doit être inférieur au total.');
      }
    }

    if (type === 'purchase') supplier = optionalText(body.supplier, { max: 200 });

    if (type === 'waste') {
      reason = optionalText(body.reason, { max: 100 }) || 'Autre';
      if (!WASTE_REASONS.includes(reason)) throw new RequestError(400, 'Motif de perte invalide.');
    }

    const saleId = newId(rules.idPrefix);
    await client.query(
      `INSERT INTO sales (id, type, created_at, customer_id, payment_method, payment_type,
                          total_amount, discount, discount_percent, supplier, reason)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10)`,
      [saleId, type, customerId, paymentMethod, paymentType, totalAmount, discount, discountPercent, supplier, reason]
    );

    for (const item of items) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [saleId, item.productId, item.productName, item.quantity, item.unitPrice, item.subtotal]
      );
      await client.query('UPDATE products SET stock = stock + $2, updated_at = NOW() WHERE id = $1', [
        item.productId,
        rules.stock * item.quantity
      ]);
    }

    if (paymentMethod === 'debt') {
      await client.query(
        `INSERT INTO debt_transactions (id, customer_id, sale_id, type, amount, transaction_date)
         VALUES ($1, $2, $3, 'sale', $4, NOW())`,
        [newId('ledger'), customerId, saleId, totalAmount]
      );
      if (deposit > 0) {
        await client.query(
          `INSERT INTO debt_transactions (id, customer_id, sale_id, type, amount, transaction_date)
           VALUES ($1, $2, $3, 'payment', $4, NOW())`,
          [newId('payment'), customerId, saleId, deposit]
        );
      }
    }

    // The refund: what the customer still owes is written off first, and only
    // the remainder is money out of the till. A walk-in return is all cash.
    if (type === 'return') {
      const cashRefund = customerId
        ? (await creditCustomerDebt(client, { customerId, amount: totalAmount, returnSaleId: saleId })).left
        : totalAmount;
      await client.query('UPDATE sales SET cash_refund = $2 WHERE id = $1', [saleId, cashRefund]);
    }

    return {
      sale: await readSale(client, saleId),
      products: await readProducts(client, 'WHERE id = ANY($1::text[])', [items.map((item) => item.productId)]),
      customer: customerId ? await readCustomer(client, customerId) : null
    };
  });

  response.status(201).json(result);
}));

app.delete('/api/sales/:id', requireAuth, requireDatabase, route(async (request, response) => {
  const result = await inTransaction(async (client) => {
    const { rows } = await client.query('SELECT id, type, customer_id FROM sales WHERE id = $1 FOR UPDATE', [
      request.params.id
    ]);
    if (!rows.length) throw new RequestError(404, 'Transaction introuvable.');
    const sale = rows[0];

    const { rows: items } = await client.query(
      'SELECT product_id, quantity FROM sale_items WHERE sale_id = $1 AND product_id IS NOT NULL',
      [sale.id]
    );

    // Undo what the transaction did to stock, whichever way it moved it.
    const direction = -(TRANSACTION_TYPES[sale.type]?.stock ?? -1);
    for (const item of items) {
      await client.query(
        `UPDATE products SET stock = GREATEST(0, stock + $2), updated_at = NOW() WHERE id = $1`,
        [item.product_id, direction * item.quantity]
      );
    }

    // sale_items and debt_transactions are ON DELETE CASCADE, so the ledger
    // entries for this invoice go with it -- and for a return, the credits it
    // wrote against other invoices go too, via debt_transactions.return_sale_id.
    await client.query('DELETE FROM sales WHERE id = $1', [sale.id]);

    return {
      type: sale.type,
      products: items.length
        ? await readProducts(client, 'WHERE id = ANY($1::text[])', [items.map((item) => item.product_id)])
        : [],
      customer: sale.customer_id ? await readCustomer(client, sale.customer_id) : null
    };
  });

  response.json(result);
}));

// Records money received against one invoice. The ledger entry is the write;
// the invoice's paid amount and status are read back from it.
app.post('/api/sales/:id/payments', requireAuth, requireDatabase, route(async (request, response) => {
  const amount = positiveAmount(request.body?.amount, 'Le montant du paiement');

  const result = await inTransaction(async (client) => {
    // Locked on its own first: FOR UPDATE cannot reach through the join to the
    // aggregate view, and the lock is what serialises two tills paying the same
    // invoice at once.
    const { rows } = await client.query(
      'SELECT id, type, customer_id, payment_method, total_amount FROM sales WHERE id = $1 FOR UPDATE',
      [request.params.id]
    );
    if (!rows.length) throw new RequestError(404, 'Facture introuvable.');
    const sale = rows[0];

    if (sale.type !== 'sale' || sale.payment_method !== 'debt') {
      throw new RequestError(400, 'Cette transaction n’est pas une facture à crédit.');
    }
    if (!sale.customer_id) throw new RequestError(400, 'Cette facture n’a pas de client.');

    const { rows: paidRows } = await client.query('SELECT paid FROM sale_payments WHERE sale_id = $1', [sale.id]);
    const remaining = money(Number(sale.total_amount) - Number(paidRows[0]?.paid || 0));
    if (remaining <= 0) throw new RequestError(409, 'Cette facture est déjà réglée.');
    if (amount > remaining) throw new RequestError(400, `Le paiement dépasse le solde restant (${remaining}).`);

    await client.query(
      `INSERT INTO debt_transactions (id, customer_id, sale_id, type, amount, transaction_date)
       VALUES ($1, $2, $3, 'payment', $4, NOW())`,
      [newId('payment'), sale.customer_id, sale.id, amount]
    );

    return { sale: await readSale(client, sale.id), customer: await readCustomer(client, sale.customer_id) };
  });

  response.status(201).json(result);
}));

// Records money received against a customer's whole balance rather than one
// invoice: the amount is spread over their unpaid invoices oldest first, which is
// the order a shop settles a running tab in. Each slice is still an ordinary
// payment row against a specific invoice, so nothing downstream -- sale_payments,
// customer_totals, the reports -- needs to know this route exists.
app.post('/api/customers/:id/payments', requireAuth, requireDatabase, route(async (request, response) => {
  const amount = positiveAmount(request.body?.amount, 'Le montant du paiement');

  const result = await inTransaction(async (client) => {
    // The customer row is the lock for their whole balance: it is what stops two
    // tills from each reading the same outstanding total and both paying it off.
    const { rows } = await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [request.params.id]);
    if (!rows.length) throw new RequestError(404, 'Client introuvable.');
    const customerId = rows[0].id;

    const { rows: totals } = await client.query(
      'SELECT balance FROM customer_totals WHERE customer_id = $1',
      [customerId]
    );
    const outstanding = money(Number(totals[0]?.balance || 0));
    if (outstanding <= 0) throw new RequestError(409, 'Ce client n’a aucune dette en cours.');
    if (amount > outstanding) {
      throw new RequestError(400, `Le paiement dépasse la dette du client (${outstanding}).`);
    }

    const { left, applied } = await creditCustomerDebt(client, { customerId, amount, idPrefix: 'payment' });
    // customer_totals.balance and the invoices creditCustomerDebt() walks are the
    // same set, so this cannot normally fire. It is here because the alternative
    // to failing is answering 201 for money that was never written down: if the
    // two ever drift apart, the payment rolls back rather than partly vanishing.
    if (left > 0) {
      throw new RequestError(409, 'Une partie du paiement n’a pas pu être imputée. Rechargez la page et réessayez.');
    }

    return {
      customer: await readCustomer(client, customerId),
      sales: applied.length
        ? await readSales(client, 'WHERE s.id = ANY($1::text[])', [applied.map((entry) => entry.saleId)])
        : [],
      applied
    };
  });

  response.status(201).json(result);
}));

// --- expenses --------------------------------------------------------------

function expensePayload(body) {
  const date = typeof body?.date === 'string' ? body.date.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RequestError(400, 'La date est obligatoire.');
  return {
    type: requiredText(body?.type, 'Le type de dépense', { max: 100 }),
    amount: positiveAmount(body?.amount, 'Le montant'),
    date,
    note: optionalText(body?.note, { max: 500 })
  };
}

app.get('/api/expenses', requireAuth, requireDatabase, route(async (request, response) => {
  response.json({ expenses: await readExpenses(pool) });
}));

app.post('/api/expenses', requireAuth, requireDatabase, route(async (request, response) => {
  const payload = expensePayload(request.body);
  const { rows } = await pool.query(
    `INSERT INTO expenses (id, type, amount, expense_date, note) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [newId('exp'), payload.type, payload.amount, payload.date, payload.note]
  );
  response.status(201).json({ expense: toExpense(rows[0]) });
}));

app.put('/api/expenses/:id', requireAuth, requireDatabase, route(async (request, response) => {
  const payload = expensePayload(request.body);
  const { rows } = await pool.query(
    `UPDATE expenses SET type = $2, amount = $3, expense_date = $4, note = $5, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [request.params.id, payload.type, payload.amount, payload.date, payload.note]
  );
  if (!rows.length) throw new RequestError(404, 'Dépense introuvable.');
  response.json({ expense: toExpense(rows[0]) });
}));

app.delete('/api/expenses/:id', requireAuth, requireDatabase, route(async (request, response) => {
  const { rowCount } = await pool.query('DELETE FROM expenses WHERE id = $1', [request.params.id]);
  if (!rowCount) throw new RequestError(404, 'Dépense introuvable.');
  response.json({ ok: true });
}));

// --- errors ----------------------------------------------------------------

app.use('/api', (request, response) => response.status(404).json({ error: 'Not found.' }));

app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);

  if (error instanceof RequestError) {
    return response.status(error.status).json({ error: error.message });
  }
  if (error?.type === 'entity.too.large') {
    console.error('Payload rejected: too large.');
    return response.status(413).json({ error: 'Les données dépassent la taille maximale autorisée.' });
  }
  // A stock CHECK that a concurrent write pushed below zero.
  if (error?.code === '23514' && /stock/.test(error.constraint || '')) {
    return response.status(409).json({ error: 'Stock insuffisant pour cette opération.' });
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
