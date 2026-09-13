const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';

const emptyState = {
  settings: {
    storeName: 'H.H Fruit',
    storePhone: '',
    storeAddress: '',
    storeEmail: '',
    receiptFooter: '',
    countryOfOrigin: ''
  },
  products: [],
  customers: [],
  sales: [],
  expenses: []
};

const state = structuredClone(emptyState);
let cart = [];
let selectedCustomerProfile = null;
let selectedCustomerInvoiceId = null;
let selectedDebtCustomerId = null;
let selectedDebtInvoiceId = null;
let selectedPosCustomerId = null;
let editingProductId = null;
let editingCustomerId = null;
let customerPurchaseRange = '30d';
let customerPurchaseCustomRange = { start: '', end: '' };
let customerPurchaseSummaryFilter = { mode: 'all', start: '', end: '' };
let customerTransactionHistoryFilter = { mode: 'all', start: '', end: '' };
let saleDiscountPercent = 0;
// 'sale' keeps the original checkout untouched; 'return' records an independent
// Retour transaction that puts stock back.
let posMode = 'sale';

function setSaveStatus(status, message) {
  const element = document.getElementById('save-status');
  if (!element) return;
  element.className = `save-status save-status-${status}`;
  element.textContent = message || (status === 'saving' ? 'Enregistrement…' : 'Enregistré');
  element.hidden = false;
  if (status === 'saved') {
    clearTimeout(setSaveStatus.timer);
    setSaveStatus.timer = setTimeout(() => { element.hidden = true; }, 1800);
  }
}

// --- server API ------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// One place for the request shape and the error shape, so no caller has to
// reason about response codes. A status of 0 means the server was unreachable.
async function api(path, method = 'GET', body = null) {
  let response;
  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    throw new ApiError(0, 'connexion au serveur impossible.');
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, payload.error || `erreur ${response.status}.`);
  return payload;
}

function upsert(collection, record) {
  const index = collection.findIndex((entry) => entry.id === record.id);
  if (index === -1) collection.push(record);
  else collection[index] = record;
}

// A write only returns the records it touched. Folding them back in keeps the
// browser's copy identical to the database without a second round trip, and
// without the browser ever recomputing a balance the database already derived.
function applyPatch(payload) {
  if (payload.settings) state.settings = payload.settings;
  if (payload.product) upsert(state.products, payload.product);
  if (payload.customer) upsert(state.customers, payload.customer);
  if (payload.sale) upsert(state.sales, payload.sale);
  if (payload.expense) upsert(state.expenses, payload.expense);
  (payload.products || []).forEach((product) => upsert(state.products, product));
}

// Every write goes through here. Resolves null when nothing was written, so a
// caller must never tell the operator an action succeeded without checking.
async function mutate(path, method, body = null, applyLocal = null) {
  setSaveStatus('saving');
  try {
    const payload = await api(path, method, body);
    if (applyLocal) applyLocal(payload);
    applyPatch(payload);
    renderAll();
    setSaveStatus('saved');
    return payload;
  } catch (error) {
    if (error.status === 401) {
      showLogin('Session expirée. Reconnectez-vous pour enregistrer.');
      setSaveStatus('error', 'Non enregistré : session expirée.');
    } else {
      setSaveStatus('error', `Non enregistré : ${error.message}`);
    }
    return null;
  }
}

// The one read the app makes on load.
async function hydrate() {
  try {
    const payload = await api('/state');
    hideLogin();
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, payload.state);
    ensureStateShape();
    renderAll();
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }
    setSaveStatus('error', error.status === 0
      ? 'Connexion au serveur impossible.'
      : 'Chargement des données impossible.');
  } finally {
    setAppLoading(false);
  }
}

// --- authentication --------------------------------------------------------

function setAppLoading(isLoading) {
  document.body.classList.toggle('is-loading', Boolean(isLoading));
}

function showLogin(message) {
  const overlay = document.getElementById('login-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  document.body.classList.add('is-locked');
  setAppLoading(false);
  const error = document.getElementById('login-error');
  if (error) {
    error.textContent = message || '';
    error.hidden = !message;
  }
  document.getElementById('login-username')?.focus();
}

function hideLogin() {
  const overlay = document.getElementById('login-overlay');
  if (!overlay) return;
  overlay.hidden = true;
  document.body.classList.remove('is-locked');
}

async function handleLogin(event) {
  event.preventDefault();
  const button = document.getElementById('login-submit');
  const error = document.getElementById('login-error');
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  if (button) { button.disabled = true; button.textContent = 'Connexion…'; }

  try {
    const response = await fetch(`${API_BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username, password })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (error) {
        error.textContent = payload.error || 'Connexion impossible.';
        error.hidden = false;
      }
      return;
    }

    document.getElementById('login-password').value = '';
    hideLogin();
    setAppLoading(true);
    await hydrate();
  } catch (requestError) {
    if (error) {
      error.textContent = 'Serveur injoignable.';
      error.hidden = false;
    }
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Se connecter'; }
  }
}

async function handleLogout() {
  try {
    await fetch(`${API_BASE}/api/logout`, { method: 'POST', credentials: 'same-origin' });
  } catch (error) {
    // Clearing the local view matters more than the round trip succeeding.
  }
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, structuredClone(emptyState));
  renderAll();
  showLogin();
}

function formatMoney(value) {
  const amount = new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 0
  }).format(Number(value || 0));
  return `${amount} F CFA`;
}

function currencyStringToNumber(value) {
  return Number(value || 0);
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function plural(count, word, suffix = 's') {
  return `${count} ${word}${Math.abs(count) > 1 ? suffix : ''}`;
}

function showMessage(elementId, text, type = 'info') {
  const target = document.getElementById(elementId);
  if (!target) return;
  target.textContent = text;
  target.className = 'message-box';
  if (type) target.classList.add(type);
}

function getCustomerById(customerId) {
  return state.customers.find((customer) => customer.id === customerId) || null;
}

function getCustomerPurchaseStart(range) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (range === 'today' ? 0 : range === '7d' ? 6 : 29));
  return start;
}

function getCustomerPurchaseRangeBounds(range) {
  if (range === 'custom') {
    const startValue = customerPurchaseCustomRange.start;
    const endValue = customerPurchaseCustomRange.end;
    if (!startValue || !endValue) {
      return { start: null, end: null };
    }
    const start = getStartOfDay(new Date(startValue));
    const end = new Date(endValue);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }
  const start = getCustomerPurchaseStart(range);
  const end = new Date();
  return { start, end };
}

function getCustomerPurchasesForRange(customerId, range) {
  const { start, end } = getCustomerPurchaseRangeBounds(range);
  if (!start || !end) return [];
  return state.sales
    .filter((sale) => sale.customerId === customerId && isCustomerSale(sale))
    .filter((sale) => {
      const date = new Date(sale.createdAt);
      return date >= start && date <= end;
    });
}

function getDateFilterMode(startValue, endValue) {
  if (!startValue && !endValue) return 'all';
  if (startValue && endValue && startValue !== endValue) return 'range';
  return 'day';
}

function matchesDateRangeFilter(createdAt, filter) {
  if (!filter || filter.mode === 'all') return true;
  const date = new Date(createdAt);
  if (!date || Number.isNaN(date.getTime())) return false;
  const start = filter.start ? getStartOfDay(new Date(filter.start)) : null;
  const end = filter.end ? new Date(filter.end) : null;
  if (end) end.setHours(23, 59, 59, 999);
  if (filter.mode === 'day') {
    const day = getStartOfDay(new Date(filter.start || filter.end));
    return getStartOfDay(date).getTime() === day.getTime();
  }
  if (start && end) return date >= start && date <= end;
  if (start) return date >= start;
  if (end) return date <= end;
  return true;
}

function getCustomerPurchaseTotalForFilter(customerId, filter) {
  return state.sales
    .filter((sale) => sale.customerId === customerId && isCustomerSale(sale))
    .filter((sale) => matchesDateRangeFilter(sale.createdAt, filter))
    .reduce((sum, sale) => sum + Number(sale.totalAmount || 0), 0);
}

function getCustomerTransactionHistoryForFilter(customerId, filter) {
  return [...state.sales.filter((sale) => sale.customerId === customerId)]
    .filter((sale) => matchesDateRangeFilter(sale.createdAt, filter))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getDateFilterSummary(filter) {
  if (!filter || filter.mode === 'all') return 'Toute la période';
  if (filter.mode === 'day') {
    const value = filter.start || filter.end;
    return value ? new Date(value).toLocaleDateString('fr-FR') : 'Jour sélectionné';
  }
  if (filter.start && filter.end) {
    return `${new Date(filter.start).toLocaleDateString('fr-FR')} → ${new Date(filter.end).toLocaleDateString('fr-FR')}`;
  }
  if (filter.start) return `Depuis ${new Date(filter.start).toLocaleDateString('fr-FR')}`;
  if (filter.end) return `Jusqu’au ${new Date(filter.end).toLocaleDateString('fr-FR')}`;
  return 'Période sélectionnée';
}

function getProductById(productId) {
  return state.products.find((product) => product.id === productId) || null;
}

// Transactions recorded before returns existed carry no type, so anything that
// is not explicitly a return is a sale.
// The five kinds of row in state.sales. Anything unrecognised is read as a sale,
// which is what a row written before the ledger grew these types would be.
const TRANSACTION_TYPES = ['sale', 'return', 'purchase', 'waste', 'adjustment'];

function getTransactionType(transaction) {
  return TRANSACTION_TYPES.includes(transaction?.type) ? transaction.type : 'sale';
}

function isReturn(transaction) {
  return getTransactionType(transaction) === 'return';
}

// A customer-facing sale, as opposed to a supplier delivery, a write-off or a
// stock correction. Revenue, invoices and customer history all mean this.
function isCustomerSale(transaction) {
  return getTransactionType(transaction) === 'sale';
}

// hydrate drops every key before assigning, so a collection the server did not
// send would otherwise be undefined mid-render.
function ensureStateShape() {
  if (!state.settings || typeof state.settings !== 'object') state.settings = structuredClone(emptyState.settings);
  if (!Array.isArray(state.products)) state.products = [];
  if (!Array.isArray(state.customers)) state.customers = [];
  if (!Array.isArray(state.sales)) state.sales = [];
  if (!Array.isArray(state.expenses)) state.expenses = [];
  state.customers.forEach((customer) => {
    if (!Array.isArray(customer.debtHistory)) customer.debtHistory = [];
  });
}

function getInvoicePaidAmount(sale) {
  return Math.min(Number(sale?.totalAmount || 0), Math.max(0, Number(sale?.amountPaid || 0)));
}

function getInvoiceRemainingAmount(sale) {
  return Math.max(0, Number(sale?.totalAmount || 0) - getInvoicePaidAmount(sale));
}

function getInvoiceStatus(sale) {
  const remaining = getInvoiceRemainingAmount(sale);
  if (remaining <= 0) return 'Payée';
  return getInvoicePaidAmount(sale) > 0 ? 'Partiellement payée' : 'Impayée';
}

// Date the debt on a sale reached zero, based on its last recorded payment (null if still owed or never had a payment logged).
function getInvoiceSettlementDate(customer, sale) {
  if (!customer || getInvoiceRemainingAmount(sale) > 0) return null;
  const payments = (customer.debtHistory || [])
    .filter((entry) => entry.type === 'payment' && entry.saleId === sale.id)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  return payments.length ? payments[0].date : null;
}

// Label + settlement date for the customer invoice history: distinguishes cash/credit-paid-at-once invoices from debt settled later.
function getInvoiceHistoryLabel(customer, sale) {
  if (sale.paymentMethod !== 'debt') return { label: 'Espèces', settledAt: null };
  const settledAt = getInvoiceSettlementDate(customer, sale);
  if (settledAt) return { label: 'Dette réglée', settledAt };
  return { label: getInvoiceStatus(sale), settledAt: null };
}

function getCustomerCreditInvoices(customerId, outstandingOnly = false) {
  return state.sales
    .filter((sale) => sale.customerId === customerId && isCustomerSale(sale) && sale.paymentMethod === 'debt')
    .filter((sale) => !outstandingOnly || getInvoiceRemainingAmount(sale) > 0)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Customer balances, invoice paid amounts and statuses used to be recomputed here
// on every load and every save. The database derives them now (customer_totals /
// sale_payments), so the browser only ever displays what the server sent.

function getAvailableStock(product) {
  return product?.stock || 0;
}

function getLowStockThreshold(product) {
  const threshold = Number(product?.lowStockThreshold);
  return Number.isFinite(threshold) && threshold >= 0 ? threshold : 10;
}

function getStartOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getCartItemKey(productId) {
  return productId;
}

function getCartTotal() {
  return cart.reduce((total, item) => total + item.quantity * item.unitPrice, 0);
}

function getOutstandingDebtList() {
  return state.customers
    .filter((customer) => customer.balance > 0)
    .sort((a, b) => b.balance - a.balance);
}

function renderNav() {
  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.addEventListener('click', () => {
      // Clients is the one tab with a URL of its own, so it goes through the
      // router; the rest are plain panel swaps.
      if (button.dataset.tab === 'customers') return navigateClient('/clients');
      setActiveTab(button.dataset.tab);
    });
  });
}

// Everything that distinguishes the register's three modes. Held as data so the
// wording, the constraints and the hidden blocks cannot drift apart, and so a
// fourth mode is a new entry rather than another branch in five functions.
//
//   stockLimited  can the cart hold more units than are on the shelf
//   wantsCustomer is the customer picker shown
const POS_MODES = {
  sale: {
    stockLimited: true,
    wantsCustomer: true,
    pageTitle: 'Nouvelle vente',
    pageSubtitle: 'Choisissez les produits, vérifiez la commande et encaissez.',
    statusPill: 'Prêt à vendre',
    cartKicker: 'Encaissement',
    cartTitle: 'Vente en cours',
    catalogHint: 'Cliquez sur Ajouter pour créer la vente',
    totalLabel: 'Total',
    submitLabel: 'Finaliser la vente',
    customerTitle: 'Client et paiement',
    switchMessage: 'Mode Vente actif.'
  },
  return: {
    stockLimited: false,
    wantsCustomer: true,
    pageTitle: 'Nouveau retour',
    pageSubtitle: 'Choisissez les produits retournés, vérifiez les quantités et validez le retour.',
    statusPill: 'Mode retour',
    cartKicker: 'Retour',
    cartTitle: 'Retour en cours',
    catalogHint: 'Cliquez sur Ajouter pour enregistrer le retour',
    totalLabel: 'Total du retour',
    submitLabel: 'Finaliser le retour',
    customerTitle: 'Client (facultatif)',
    switchMessage: 'Mode Retour actif. Le stock sera réapprovisionné et le montant remboursé.'
  },
  waste: {
    stockLimited: true,
    wantsCustomer: false,
    pageTitle: 'Nouvelle perte',
    pageSubtitle: 'Choisissez les produits perdus, indiquez le motif et enregistrez la perte.',
    statusPill: 'Mode perte',
    cartKicker: 'Perte',
    cartTitle: 'Perte en cours',
    catalogHint: 'Cliquez sur Ajouter pour déclarer la perte',
    totalLabel: 'Valeur de la perte',
    submitLabel: 'Enregistrer la perte',
    customerTitle: '',
    switchMessage: 'Mode Perte actif. Les produits seront retirés du stock.'
  }
};

function isReturnMode() {
  return posMode === 'return';
}

function isWasteMode() {
  return posMode === 'waste';
}

// True when the cart may not exceed what is on the shelf. A return is the one
// mode that may, since the units are coming back in.
function isStockLimitedMode() {
  return POS_MODES[posMode].stockLimited;
}

// Switches the register between Vente, Retour and Perte. The cart, catalogue and
// customer picker are shared; only the constraints and wording change.
function setPosMode(mode) {
  const nextMode = Object.prototype.hasOwnProperty.call(POS_MODES, mode) ? mode : 'sale';
  if (nextMode === posMode) return;
  posMode = nextMode;

  // A return may hold more units than are in stock; a sale or a write-off may
  // not. Clamp on the way into a limited mode so an oversized cart can never
  // oversell.
  let adjusted = false;
  if (isStockLimitedMode()) {
    cart = cart.filter((item) => {
      const available = getAvailableStock(getProductById(item.productId));
      if (available < 1) { adjusted = true; return false; }
      if (item.quantity > available) { item.quantity = available; adjusted = true; }
      return true;
    });
  }

  applyPosMode();
  renderPosProducts();
  renderCart();
  showMessage(
    'pos-message',
    adjusted
      ? 'Les quantités ont été ajustées au stock disponible.'
      : POS_MODES[posMode].switchMessage,
    adjusted ? 'error' : 'info'
  );
}

// Every piece of per-mode wording and styling lives here so the modes can never
// drift apart.
function applyPosMode() {
  const mode = POS_MODES[posMode];
  const returning = isReturnMode();
  const wasting = isWasteMode();

  ['cart-area', 'pos'].forEach((id) => {
    const element = document.getElementById(id);
    element?.classList.toggle('is-return-mode', returning);
    element?.classList.toggle('is-waste-mode', wasting);
  });
  document.querySelectorAll('[data-pos-mode]').forEach((button) => {
    const active = button.dataset.posMode === posMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  const text = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  text('pos-page-title', mode.pageTitle);
  text('pos-page-subtitle', mode.pageSubtitle);
  text('pos-status-pill', mode.statusPill);
  text('cart-kicker', mode.cartKicker);
  text('cart-title', mode.cartTitle);
  text('pos-catalog-hint', mode.catalogHint);
  text('total-label', mode.totalLabel);
  text('complete-sale-btn', mode.submitLabel);
  if (mode.customerTitle) text('pos-customer-section-title', mode.customerTitle);

  // Payment and discount belong to a sale alone; the customer block to anything
  // with a customer; the notes to the mode that needs explaining.
  document.getElementById('pos-payment-fields')?.classList.toggle('hidden', posMode !== 'sale');
  document.getElementById('sale-discount-field')?.classList.toggle('hidden', posMode !== 'sale');
  document.getElementById('checkout-discount-row')?.classList.toggle('hidden', posMode !== 'sale');
  document.getElementById('pos-customer-block')?.classList.toggle('hidden', !mode.wantsCustomer);
  document.getElementById('pos-return-note')?.classList.toggle('hidden', !returning);
  document.getElementById('pos-waste-fields')?.classList.toggle('hidden', !wasting);
  if (posMode !== 'sale') document.getElementById('partial-payment-field')?.classList.add('hidden');
}

function renderPosProducts() {
  const searchValue = document.getElementById('pos-product-search')?.value?.toLowerCase() || '';
  const list = state.products.filter((product) => product.name.toLowerCase().includes(searchValue));

  const container = document.getElementById('pos-product-list');
  // A returned product can be out of stock, so return mode never disables Ajouter.
  const limited = isStockLimitedMode();
  container.innerHTML = list.map((product) => `
    <div class="catalog-item">
      <div class="meta">
        <strong>${product.name}</strong>
        <small>${getAvailableStock(product)} en stock · ${formatMoney(product.sellingPrice)}</small>
      </div>
      <button class="add-btn primary-btn" data-add-product="${product.id}" ${limited && getAvailableStock(product) < 1 ? 'disabled' : ''}>Ajouter</button>
    </div>
  `).join('');

  container.querySelectorAll('[data-add-product]').forEach((button) => {
    button.addEventListener('click', () => addToCart(button.dataset.addProduct));
  });
}

function addToCart(productId) {
  const product = getProductById(productId);
  if (!product) return;
  const itemKey = getCartItemKey(productId);
  const existing = cart.find((item) => item.key === itemKey);
  // Stock only limits what can be sold; a return puts units back.
  if (isStockLimitedMode() && getAvailableStock(product) <= (existing?.quantity || 0)) return;

  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      key: itemKey,
      productId,
      productName: product.name,
      quantity: 1,
      unitPrice: product.sellingPrice
    });
  }

  renderCart();
}

const EMPTY_CART_MESSAGES = {
  sale: '<div class="empty-cart"><span class="empty-cart-icon">+</span><strong>Votre vente est vide</strong><p>Ajoutez des produits au catalogue pour commencer.</p></div>',
  return: '<div class="empty-cart"><span class="empty-cart-icon">&#8630;</span><strong>Votre retour est vide</strong><p>Ajoutez les produits retournés pour commencer.</p></div>',
  waste: '<div class="empty-cart"><span class="empty-cart-icon">&#9888;</span><strong>Aucune perte enregistrée</strong><p>Ajoutez les produits perdus pour commencer.</p></div>'
};

function renderCart() {
  const cartContainer = document.getElementById('cart-items');
  const cartCount = document.getElementById('cart-count');
  const totalItems = cart.reduce((total, item) => total + item.quantity, 0);
  cartCount.textContent = plural(totalItems, 'article');
  if (!cart.length) {
    cartContainer.innerHTML = EMPTY_CART_MESSAGES[posMode];
    document.getElementById('subtotal-value').textContent = formatMoney(0);
    document.getElementById('checkout-discount-value').textContent = formatMoney(0);
    document.getElementById('total-value').textContent = formatMoney(0);
    return;
  }

  cartContainer.innerHTML = cart.map((item) => `
    <div class="cart-row">
      <div class="cart-product-name">
        <strong>${item.productName}</strong>
      </div>
      <button class="link-btn cart-remove-btn" data-cart-remove="${item.key}">Retirer</button>
      <label class="cart-quantity-field">
        <span>Quantité</span>
        <input data-cart-qty="${item.key}" type="number" min="1" value="${item.quantity}" />
      </label>
      <div class="price-box">
        <label for="cart-price-${item.key}">Prix unitaire (F CFA)</label>
        <input id="cart-price-${item.key}" data-cart-price="${item.key}" type="number" step="0.01" min="0" value="${item.unitPrice}" />
      </div>
      <div class="cart-line-total">
        <span>Total de la ligne</span>
        <strong>${formatMoney(item.quantity * item.unitPrice)}</strong>
      </div>
    </div>
  `).join('');

  cartContainer.querySelectorAll('[data-cart-qty]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const item = cart.find((entry) => entry.key === input.dataset.cartQty);
      if (!item) return;
      const product = getProductById(item.productId);
      const requested = Math.max(1, Math.floor(Number(event.target.value) || 1));
      item.quantity = isStockLimitedMode() ? Math.min(requested, getAvailableStock(product)) : requested;
      renderCart();
    });
  });

  cartContainer.querySelectorAll('[data-cart-price]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const item = cart.find((entry) => entry.key === input.dataset.cartPrice);
      if (!item) return;
      item.unitPrice = Number(event.target.value) || 0;
      renderCart();
    });
  });

  cartContainer.querySelectorAll('[data-cart-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      cart = cart.filter((entry) => entry.key !== button.dataset.cartRemove);
      renderCart();
    });
  });

  const subtotal = getCartTotal();
  // Nothing is negotiated on a return or a write-off, so only a sale discounts.
  const discountPercent = posMode === 'sale' ? saleDiscountPercent : 0;
  const discount = subtotal * discountPercent / 100;
  document.getElementById('subtotal-value').textContent = formatMoney(subtotal);
  document.getElementById('checkout-discount-value').textContent = discount > 0 ? `-${formatMoney(discount)}` : formatMoney(0);
  document.getElementById('total-value').textContent = formatMoney(subtotal - discount);
}

function renderCustomerSelects() {
  renderPosCustomerField();

  const debtCustomerSelect = document.getElementById('payment-customer-select');
  if (!debtCustomerSelect) return;
  debtCustomerSelect.innerHTML = state.customers.filter((customer) => getCustomerCreditInvoices(customer.id, true).length).map((customer) => `
    <option value="${customer.id}">${customer.name} - ${formatMoney(customer.balance)}</option>
  `).join('');
  renderPaymentInvoiceSelect();
}

function renderPaymentInvoiceSelect() {
  const customerId = document.getElementById('payment-customer-select')?.value;
  const invoiceSelect = document.getElementById('payment-invoice-select');
  if (!invoiceSelect) return;
  const invoices = customerId ? getCustomerCreditInvoices(customerId, true) : [];
  invoiceSelect.innerHTML = invoices.length
    ? invoices.map((invoice) => `
        <option value="${invoice.id}">Facture n°${invoice.id.slice(-4)} · ${getInvoiceStatus(invoice)} · ${formatMoney(getInvoiceRemainingAmount(invoice))} restant(s)</option>
      `).join('')
    : '<option value="">Aucune facture impayée</option>';
  renderPaymentInvoiceSummary();
}

function renderPaymentInvoiceSummary() {
  const invoiceId = document.getElementById('payment-invoice-select')?.value;
  const invoice = state.sales.find((sale) => sale.id === invoiceId);
  const summary = document.getElementById('payment-invoice-summary');
  if (!summary) return;
  summary.innerHTML = invoice
    ? `<div><span>Total de la facture</span><strong>${formatMoney(invoice.totalAmount)}</strong></div>
       <div><span>Montant payé</span><strong>${formatMoney(getInvoicePaidAmount(invoice))}</strong></div>
       <div><span>Reste à payer</span><strong>${formatMoney(getInvoiceRemainingAmount(invoice))}</strong></div>`
    : '<p class="empty-state">Sélectionnez un client ayant une facture impayée.</p>';
}

function renderPosCustomerField() {
  if (selectedPosCustomerId && !getCustomerById(selectedPosCustomerId)) selectedPosCustomerId = null;

  const input = document.getElementById('pos-customer-search');
  const suggestions = document.getElementById('pos-customer-suggestions');
  const query = input.value.toLowerCase().trim();

  if (selectedPosCustomerId) {
    suggestions.innerHTML = '';
    suggestions.classList.add('hidden');
    return;
  }

  const matches = query
    ? state.customers.filter((customer) => `${customer.name} ${customer.phone}`.toLowerCase().includes(query)).slice(0, 6)
    : [];

  if (!matches.length) {
    suggestions.innerHTML = '';
    suggestions.classList.add('hidden');
    return;
  }

  suggestions.innerHTML = matches.map((customer) => `
    <button type="button" class="history-suggestion" data-pos-customer="${customer.id}">
      <strong>${customer.name}</strong>
      <small>${customer.phone}</small>
    </button>
  `).join('');
  suggestions.classList.remove('hidden');

  suggestions.querySelectorAll('[data-pos-customer]').forEach((button) => {
    button.addEventListener('click', () => {
      const customer = getCustomerById(button.dataset.posCustomer);
      selectedPosCustomerId = customer.id;
      input.value = `${customer.name} (${customer.phone})`;
      suggestions.classList.add('hidden');
    });
  });
}

function renderProductsList() {
  const searchValue = document.getElementById('product-search')?.value?.toLowerCase() || '';
  const productList = state.products.filter((product) => product.name.toLowerCase().includes(searchValue));

  const listEl = document.getElementById('product-list');
  const totalUnits = state.products.reduce((sum, product) => sum + product.stock, 0);
  const summary = document.getElementById('products-summary');
  if (summary) summary.textContent = `${plural(productList.length, 'produit')} · ${plural(totalUnits, 'unité')} en stock`;

  // A table rather than a stack of cards: the same five facts in a third of the
  // height, so a catalogue of twenty is readable without scrolling.
  listEl.innerHTML = productList.length
    ? `
      <div class="table-wrap">
        <table class="product-table">
          <thead>
            <tr>
              <th>Produit</th>
              <th class="product-num">Stock</th>
              <th class="product-num">Prix</th>
              <th>État</th>
              <th class="row-actions-head" aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            ${productList.map((product) => {
    const stock = product.stock;
    const threshold = getLowStockThreshold(product);
    const stockState = stock === 0 ? 'out' : stock <= threshold ? 'low' : 'healthy';
    return `
              <tr>
                <td>
                  <strong>${escapeHtml(product.name)}</strong>
                  ${product.description ? `<small class="product-row-description">${escapeHtml(product.description)}</small>` : ''}
                </td>
                <td class="product-num"><strong>${stock}</strong></td>
                <td class="product-num">${formatMoney(product.sellingPrice)}</td>
                <td><span class="stock-status ${stockState}">${stockState === 'out' ? 'Rupture' : stockState === 'low' ? 'Stock faible' : 'En stock'}</span></td>
                <td class="row-actions">
                  <button class="link-btn" data-edit-product="${product.id}">Modifier</button>
                  <button class="link-btn danger-link" data-delete-product="${product.id}">Supprimer</button>
                </td>
              </tr>`;
  }).join('')}
          </tbody>
        </table>
      </div>`
    : `
      <div class="empty-state-block">
        <strong>Aucun produit trouvé</strong>
        <p>Essayez une autre recherche, ou ajoutez un produit au catalogue.</p>
        <button type="button" class="secondary-btn" data-empty-add-product>Ajouter un produit</button>
      </div>`;

  listEl.querySelectorAll('[data-edit-product]').forEach((button) => {
    button.addEventListener('click', () => beginEditProduct(button.dataset.editProduct));
  });
  listEl.querySelectorAll('[data-delete-product]').forEach((button) => {
    button.addEventListener('click', () => deleteProduct(button.dataset.deleteProduct));
  });
  listEl.querySelector('[data-empty-add-product]')?.addEventListener('click', focusProductEditor);
}

async function deleteProduct(productId) {
  const product = getProductById(productId);
  if (!product) return;
  const confirmed = window.confirm(`Supprimer ${product.name} ? Le produit sera retiré du catalogue, mais l’historique des ventes sera conservé.`);
  if (!confirmed) return;

  const saved = await mutate(`/products/${productId}`, 'DELETE', null, () => {
    state.products = state.products.filter((entry) => entry.id !== productId);
    cart = cart.filter((item) => item.productId !== productId);
  });
  if (saved !== null && editingProductId === productId) cancelProductEdit();
}

function focusProductEditor() {
  cancelProductEdit();
  document.getElementById('product-editor-modal')?.classList.remove('hidden');
  document.getElementById('product-name')?.focus();
}

function beginEditProduct(productId) {
  const product = getProductById(productId);
  if (!product) return;
  editingProductId = productId;
  document.getElementById('product-editor-modal')?.classList.remove('hidden');
  document.getElementById('product-editor-panel').classList.add('is-editing');
  document.getElementById('editor-mark').textContent = '\u270e';
  document.getElementById('product-form-title').textContent = 'Modifier le produit';
  document.getElementById('product-submit-btn').textContent = 'Enregistrer les modifications';
  document.getElementById('product-name').value = product.name;
  document.getElementById('product-low-stock-threshold').value = getLowStockThreshold(product);
  document.getElementById('product-price').value = product.sellingPrice;
  document.getElementById('inventory-section-hint').textContent = 'Ajoutez le stock nouvellement reçu.';
  document.getElementById('product-stock-add-row').classList.add('hidden');
  document.getElementById('product-stock-addition').value = '';
  document.getElementById('product-current-stock').textContent = product.stock;
  document.getElementById('product-description').value = product.description || '';
  document.getElementById('product-stock-label').classList.add('hidden');
  document.getElementById('product-stock').required = false;
  document.getElementById('product-stock-management').classList.remove('hidden');
  document.getElementById('cancel-product-edit').classList.remove('hidden');
}

function cancelProductEdit() {
  editingProductId = null;
  document.getElementById('product-form').reset();
  document.getElementById('product-editor-panel').classList.remove('is-editing');
  document.getElementById('editor-mark').textContent = '+';
  document.getElementById('inventory-section-hint').textContent = 'Suivez les unités séparément des informations du produit.';
  document.getElementById('product-stock-label').classList.remove('hidden');
  document.getElementById('product-stock-management').classList.add('hidden');
  document.getElementById('product-stock-add-row').classList.add('hidden');
  document.getElementById('product-stock').required = true;
  document.getElementById('product-form-title').textContent = 'Ajouter un produit';
  document.getElementById('product-submit-btn').textContent = 'Enregistrer le produit';
  document.getElementById('cancel-product-edit').classList.add('hidden');
  document.getElementById('product-editor-modal')?.classList.add('hidden');
}

function toggleAddStockRow() {
  document.getElementById('product-stock-add-row').classList.toggle('hidden');
}

function cancelAddStock() {
  document.getElementById('product-stock-add-row').classList.add('hidden');
  document.getElementById('product-stock-addition').value = '';
}

async function addStockToProduct() {
  if (!editingProductId) return;
  const amount = Number(document.getElementById('product-stock-addition').value);
  const product = getProductById(editingProductId);
  if (!product || !amount || amount < 1) return;
  const saved = await mutate(`/products/${editingProductId}/stock`, 'POST', { amount });
  if (saved === null) return;
  document.getElementById('product-current-stock').textContent = saved.product.stock;
  document.getElementById('product-stock-addition').value = '';
  document.getElementById('product-stock-add-row').classList.add('hidden');
}

function renderCustomersList() {
  const searchValue = document.getElementById('customer-search')?.value?.toLowerCase() || '';
  const list = state.customers.filter((customer) => `${customer.name} ${customer.phone}`.toLowerCase().includes(searchValue));
  const listEl = document.getElementById('customer-list');
  listEl.innerHTML = list.map((customer) => `
    <div class="customer-row">
      <div class="customer-meta">
        <strong>${customer.name}</strong>
        <small>${customer.phone}</small>
        ${customer.address ? `<small class="subtle">${customer.address}</small>` : ''}
      </div>
      <div class="customer-balance ${customer.balance > 0 ? 'owed' : ''}">
        <strong>${formatMoney(customer.balance)}</strong>
        <small>${customer.balance > 0 ? 'Dette restante' : 'Solde réglé'}</small>
      </div>
      <div class="customer-actions">
        <button class="secondary-btn compact-btn" data-select-customer="${customer.id}">Voir</button>
        <button class="link-btn muted" data-edit-customer="${customer.id}">Modifier</button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('[data-select-customer]').forEach((button) => {
    button.addEventListener('click', () => {
      customerHistoryDateFilter = '';
      selectedCustomerInvoiceId = null;
      showCustomerProfile(button.dataset.selectCustomer);
    });
  });

  listEl.querySelectorAll('[data-edit-customer]').forEach((button) => {
    button.addEventListener('click', () => beginEditCustomer(button.dataset.editCustomer));
  });
}

// Mirrors focusProductEditor: reset to the "add" state, then reveal the modal.
function openCustomerEditor() {
  cancelCustomerEdit();
  document.getElementById('customer-editor-modal')?.classList.remove('hidden');
  document.getElementById('customer-name')?.focus();
}

function beginEditCustomer(customerId) {
  const customer = getCustomerById(customerId);
  if (!customer) return;
  editingCustomerId = customerId;
  document.getElementById('customer-editor-modal')?.classList.remove('hidden');
  document.getElementById('customer-form-title').textContent = 'Modifier le client';
  document.getElementById('customer-name').value = customer.name;
  document.getElementById('customer-phone').value = customer.phone;
  document.getElementById('customer-address').value = customer.address || '';
  document.getElementById('cancel-customer-edit').classList.remove('hidden');
}

function cancelCustomerEdit() {
  editingCustomerId = null;
  document.getElementById('customer-form').reset();
  document.getElementById('customer-form-title').textContent = 'Ajouter un client';
  document.getElementById('cancel-customer-edit').classList.add('hidden');
  document.getElementById('customer-editor-modal')?.classList.add('hidden');
}

function showCustomerProfile(customerId) {
  const customer = getCustomerById(customerId);
  if (!customer) return;
  selectedCustomerProfile = customer;
  const allSalesForCustomer = [...state.sales.filter((sale) => sale.customerId === customer.id)].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const rangedPurchases = getCustomerPurchasesForRange(customer.id, customerPurchaseRange);
  const rangedPurchaseTotal = rangedPurchases.reduce((sum, sale) => sum + Number(sale.totalAmount || 0), 0);
  const salesForCustomer = customerHistoryDateFilter
    ? allSalesForCustomer.filter((sale) => matchesDateRangeFilter(sale.createdAt, { mode: 'day', start: customerHistoryDateFilter, end: customerHistoryDateFilter }))
    : allSalesForCustomer;

  const selectedSale = selectedCustomerInvoiceId
    ? salesForCustomer.find((sale) => sale.id === selectedCustomerInvoiceId) || null
    : null;

  const customPurchaseRangeHtml = customerPurchaseRange === 'custom' ? `
    <div class="customer-period-custom inline-custom-range">
      <label>Du <input type="date" id="customer-purchase-start" value="${customerPurchaseCustomRange.start || ''}" /></label>
      <label>Au <input type="date" id="customer-purchase-end" value="${customerPurchaseCustomRange.end || ''}" /></label>
    </div>
  ` : '';

  const purchaseHistoryHtml = salesForCustomer.length
    ? salesForCustomer.map((sale) => {
      const { label, settledAt } = getInvoiceHistoryLabel(customer, sale);
      return `
        <button class="purchase-row ${selectedSale && selectedSale.id === sale.id ? 'active' : ''}" data-open-sale="${sale.id}">
          <div class="purchase-row-info">
            <strong>Facture n°${sale.id.slice(-4)}</strong>
            <small>${new Date(sale.createdAt).toLocaleString('fr-FR')} · ${plural(sale.items.length, 'article')}</small>
          </div>
          <div class="purchase-row-amount">
            <strong>${formatMoney(sale.totalAmount)}</strong>
            <span class="mini-pill ${sale.paymentMethod === 'debt' ? 'warning' : 'success'}">${label}</span>
            ${settledAt ? `<small class="purchase-row-settled">Réglée le ${new Date(settledAt).toLocaleDateString('fr-FR')}</small>` : ''}
          </div>
          <span class="purchase-arrow">›</span>
        </button>
      `;
    }).join('')
    : `<p class="empty-state">${customerHistoryDateFilter ? 'Aucun achat à cette date.' : 'Aucun achat pour le moment.'}</p>`;

  const selectedSaleHistory = selectedSale ? getInvoiceHistoryLabel(customer, selectedSale) : null;

  const invoiceHtml = selectedSale
    ? `
      <div class="invoice-sheet">
        <div class="invoice-topbar">
          <div>
            <p class="eyebrow muted">Facture</p>
            <h4>Facture n°${selectedSale.id.slice(-4)}</h4>
          </div>
          <button class="link-btn" data-back-to-history>Retour</button>
        </div>

        <div class="invoice-meta">
          <div><span>Client</span><strong>${customer.name}</strong></div>
          <div><span>Téléphone</span><strong>${customer.phone}</strong></div>
          <div><span>Date</span><strong>${new Date(selectedSale.createdAt).toLocaleString('fr-FR')}</strong></div>
        </div>

        <table class="invoice-table">
          <thead>
            <tr>
              <th>Produit</th>
              <th>Qté</th>
              <th>Prix</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            ${selectedSale.items.map((item) => `
              <tr>
                <td>${item.productName}</td>
                <td>${item.quantity}</td>
                <td>${formatMoney(item.unitPrice)}</td>
                <td>${formatMoney(item.subtotal)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div class="invoice-totals">
          <div><span>Sous-total</span><strong>${formatMoney(Number(selectedSale.totalAmount || 0) + Number(selectedSale.discount || 0))}</strong></div>
          ${selectedSale.discountPercent > 0 ? `<div><span>Remise (${selectedSale.discountPercent} %)</span><strong>-${formatMoney(selectedSale.discount)}</strong></div>` : ''}
          <div><span>Montant payé</span><strong>${formatMoney(getInvoicePaidAmount(selectedSale))}</strong></div>
          <div><span>Reste à payer</span><strong>${formatMoney(getInvoiceRemainingAmount(selectedSale))}</strong></div>
          ${selectedSale.paymentMethod === 'debt' ? `<div><span>Statut</span><strong>${selectedSaleHistory.label}</strong></div>` : ''}
          ${selectedSaleHistory.settledAt ? `<div><span>Réglée le</span><strong>${new Date(selectedSaleHistory.settledAt).toLocaleDateString('fr-FR')}</strong></div>` : ''}
          <div><span>Paiement</span><strong>${selectedSale.paymentMethod === 'debt' ? (selectedSale.paymentType === 'partial' ? 'Paiement partiel' : 'Crédit') : 'Espèces'}</strong></div>
        </div>
      </div>
    `
    : '<div class="empty-invoice"><p class="empty-state">Sélectionnez un achat pour afficher les détails de la facture.</p></div>';

  const historyHtml = customer.debtHistory.length
    ? customer.debtHistory.map((entry) => `
        <div class="timeline-item">
          <div>
            <strong>${entry.type === 'sale' ? 'Vente à crédit' : 'Paiement reçu'}</strong>
            <small>${new Date(entry.date).toLocaleString('fr-FR')}${entry.saleId ? ` · Facture n°${entry.saleId.slice(-4)}` : ''}</small>
          </div>
          <strong class="${entry.type === 'sale' ? 'credit' : 'payment'}">${entry.type === 'sale' ? '+' : '-'}${formatMoney(entry.amount)}</strong>
        </div>
      `).join('')
    : '<p class="empty-state">Aucune activité de dette ou de paiement pour le moment.</p>';

  document.getElementById('customer-profile').innerHTML = `
    <div class="profile-header">
      <div>
        <p class="eyebrow muted">Client</p>
        <h3>${customer.name}</h3>
        <span class="subtle">${customer.phone}</span>
        ${customer.address ? `<span class="subtle">${customer.address}</span>` : ''}
      </div>
      <div class="balance-box">
        <span>Total dû</span>
        <strong>${formatMoney(customer.balance)}</strong>
      </div>
      <button type="button" class="secondary-btn compact-btn" data-edit-profile-customer="${customer.id}">Modifier le client</button>
    </div>

    <div class="profile-grid">
      <div class="profile-panel">
        <h4>Vue d’ensemble</h4>
        <div class="mini-grid">
          <div>
            <span>Dette actuelle</span>
            <strong>${formatMoney(customer.balance)}</strong>
          </div>
          <div>
            <span>Total des achats</span>
            <strong>${formatMoney(customer.totalPurchased)}</strong>
          </div>
        </div>
      </div>

      <div class="profile-panel">
        <h4>Achats</h4>
        <label class="purchase-range-control"><span>Période</span><select id="customer-purchase-range"><option value="today" ${customerPurchaseRange === 'today' ? 'selected' : ''}>Aujourd’hui</option><option value="7d" ${customerPurchaseRange === '7d' ? 'selected' : ''}>7 derniers jours</option><option value="30d" ${customerPurchaseRange === '30d' ? 'selected' : ''}>30 derniers jours</option><option value="custom" ${customerPurchaseRange === 'custom' ? 'selected' : ''}>Personnalisé</option></select></label>
        ${customPurchaseRangeHtml}
        <strong class="purchase-range-total">${formatMoney(rangedPurchaseTotal)}</strong>
        <small>${plural(rangedPurchases.length, 'achat')} sur la période</small>
      </div>

      <div class="profile-panel">
        <h4>Paiements</h4>
        <p>${formatMoney(customer.totalPaid)}</p>
      </div>
    </div>

    <div class="profile-sections">
      <div class="profile-section">
        <div class="profile-section-heading-row">
          <h4>Historique des achats</h4>
          <div class="history-date-filter">
            <input type="date" id="customer-history-date" value="${customerHistoryDateFilter}" aria-label="Filtrer les achats par date" />
            ${customerHistoryDateFilter ? '<button type="button" class="link-btn muted" id="clear-customer-history-date">Effacer</button>' : ''}
          </div>
        </div>
        <div class="purchase-list">${purchaseHistoryHtml}</div>
      </div>

      <div class="profile-section">
        <h4>Détails de la facture</h4>
        ${invoiceHtml}
      </div>
    </div>

    <div class="profile-section debt-history-section">
      <h4>Historique des dettes et paiements</h4>
      ${historyHtml}
    </div>
  `;

  document.querySelectorAll('[data-open-sale]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedCustomerInvoiceId = button.dataset.openSale;
      showCustomerProfile(customer.id);
    });
  });

  const backButton = document.querySelector('[data-back-to-history]');
  if (backButton) {
    backButton.addEventListener('click', () => {
      selectedCustomerInvoiceId = null;
      showCustomerProfile(customer.id);
    });
  }

  document.querySelector('[data-edit-profile-customer]')?.addEventListener('click', () => {
    beginEditCustomer(customer.id);
    document.getElementById('customer-form-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.getElementById('customer-history-date')?.addEventListener('change', (event) => {
    customerHistoryDateFilter = event.target.value;
    selectedCustomerInvoiceId = null;
    showCustomerProfile(customer.id);
  });

  document.getElementById('customer-purchase-range')?.addEventListener('change', (event) => {
    customerPurchaseRange = event.target.value;
    if (customerPurchaseRange !== 'custom') {
      customerPurchaseCustomRange = { start: '', end: '' };
    }
    showCustomerProfile(customer.id);
  });

  if (customerPurchaseRange === 'custom') {
    document.getElementById('customer-purchase-start')?.addEventListener('change', (event) => {
      customerPurchaseCustomRange.start = event.target.value;
      showCustomerProfile(customer.id);
    });
    document.getElementById('customer-purchase-end')?.addEventListener('change', (event) => {
      customerPurchaseCustomRange.end = event.target.value;
      showCustomerProfile(customer.id);
    });
  }

  document.getElementById('clear-customer-history-date')?.addEventListener('click', () => {
    customerHistoryDateFilter = '';
    selectedCustomerInvoiceId = null;
    showCustomerProfile(customer.id);
  });
}

function setActiveTab(tabId) {
  document.querySelectorAll('.nav-btn').forEach((nav) => nav.classList.toggle('active', nav.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === tabId));
}

// /debts/* is the retired Dettes clients route; it resolves here now.
function isCustomerPath() {
  const path = window.location.pathname;
  return path.startsWith('/clients') || path.startsWith('/debts');
}

function navigateClient(path) {
  window.history.pushState({}, '', path);
  setActiveTab('customers');
  renderClientRoute();
}

function getClientRoute() {
  const parts = window.location.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  // /debts was its own page until the debtor list became a filter here. Old links
  // and bookmarks still resolve, they just land on the customer instead.
  if (parts[0] !== 'clients' && parts[0] !== 'debts') return { page: 'customers' };
  if (parts.length === 1) return { page: 'customers' };
  if (parts.length >= 4 && parts[2] === 'invoices') return { page: 'invoice', customerId: parts[1], invoiceId: parts[3] };
  return { page: 'customer', customerId: parts[1] };
}

function renderClientRoute() {
  const container = document.getElementById('client-route-view');
  if (!container) return;
  const route = getClientRoute();
  if (route.page === 'customers') return renderClientsPage(container);
  const customer = getCustomerById(route.customerId);
  if (!customer) return navigateClient('/clients');
  if (route.page === 'invoice') return renderClientInvoicePage(container, customer, route.invoiceId);
  renderClientProfilePage(container, customer);
}

// 'debtors' is what the separate Dettes clients page used to be.
let clientListScope = 'all';

function renderClientsPage(container) {
  const debtors = getOutstandingDebtList().length;
  container.innerHTML = `
    <div class="ledger-page">
      <div class="ledger-page-header"><div><p class="section-kicker">Clients</p><h3>Liste des clients</h3></div><button type="button" class="primary-btn compact-btn" data-add-client>+ Ajouter un client</button></div>
      <div class="ledger-scope" role="group" aria-label="Filtrer les clients">
        <button type="button" class="scope-btn${clientListScope === 'all' ? ' active' : ''}" data-client-scope="all" aria-pressed="${clientListScope === 'all'}">Tous <span>${state.customers.length}</span></button>
        <button type="button" class="scope-btn${clientListScope === 'debtors' ? ' active' : ''}" data-client-scope="debtors" aria-pressed="${clientListScope === 'debtors'}">Débiteurs <span>${debtors}</span></button>
      </div>
      <label class="ledger-search"><span>Rechercher un client ou un téléphone</span><input id="customer-search" type="search" placeholder="Rechercher un client ou un téléphone" /></label>
      <div id="customer-list" class="ledger-table ledger-customer-list" translate="no"></div>
    </div>
  `;
  const search = container.querySelector('#customer-search');
  search.addEventListener('input', () => renderClientRows(container.querySelector('#customer-list'), search.value));
  container.querySelector('[data-add-client]').addEventListener('click', openCustomerEditor);
  container.querySelectorAll('[data-client-scope]').forEach((button) => {
    button.addEventListener('click', () => {
      clientListScope = button.dataset.clientScope;
      renderClientsPage(container);
    });
  });
  renderClientRows(container.querySelector('#customer-list'), '');
}

function renderClientRows(listEl, searchValue) {
  const query = searchValue.toLowerCase().trim();
  const source = clientListScope === 'debtors' ? getOutstandingDebtList() : state.customers;
  const clients = source.filter((customer) => `${customer.name} ${customer.phone}`.toLowerCase().includes(query));
  listEl.innerHTML = clients.length ? clients.map((customer) => `
    <button type="button" class="ledger-row customer-ledger-row" data-client-id="${customer.id}">
      <span class="ledger-primary"><strong>${customer.name}</strong><small>${customer.phone}</small></span>
      <span class="ledger-money ${Number(customer.balance) > 0 ? "" : "ledger-money-settled"}"><strong>${formatMoney(customer.balance)}</strong><small>Total dû</small></span>
      <span class="ledger-count"><strong>${getCustomerCreditInvoices(customer.id, true).length}</strong><small>${getCustomerCreditInvoices(customer.id, true).length > 1 ? 'factures impayées' : 'facture impayée'}</small></span>
      <span class="ledger-arrow">›</span>
    </button>
  `).join('') : `<p class="empty-state">${clientListScope === 'debtors' ? 'Aucun client avec une dette restante.' : 'Aucun client trouvé.'}</p>`;
  listEl.querySelectorAll('[data-client-id]').forEach((button) => button.addEventListener('click', () => navigateClient(`/clients/${encodeURIComponent(button.dataset.clientId)}`)));
}

function renderClientProfilePage(container, customer) {
  const purchaseSummaryTotal = getCustomerPurchaseTotalForFilter(customer.id, customerPurchaseSummaryFilter);
  const transactionHistoryRows = getCustomerTransactionHistoryForFilter(customer.id, customerTransactionHistoryFilter);
  const purchaseFilterLabel = getDateFilterSummary(customerPurchaseSummaryFilter);
  const historyFilterLabel = getDateFilterSummary(customerTransactionHistoryFilter);

  const purchaseSummaryPicker = `
    <div class="compact-date-popover hidden" data-purchase-summary-picker>
      <div class="compact-date-picker-grid">
        <label>Du<input type="date" data-purchase-summary-start value="${customerPurchaseSummaryFilter.start || ''}" /></label>
        <label>Au<input type="date" data-purchase-summary-end value="${customerPurchaseSummaryFilter.end || ''}" /></label>
      </div>
      <div class="compact-date-picker-actions">
        <button type="button" class="primary-btn compact-btn" data-apply-purchase-summary>Appliquer</button>
        <button type="button" class="link-btn muted" data-clear-purchase-summary>Effacer</button>
      </div>
    </div>
  `;

  const historyPicker = `
    <div class="compact-date-popover hidden" data-history-picker>
      <div class="compact-date-picker-grid">
        <label>Du<input type="date" data-history-start value="${customerTransactionHistoryFilter.start || ''}" /></label>
        <label>Au<input type="date" data-history-end value="${customerTransactionHistoryFilter.end || ''}" /></label>
      </div>
      <div class="compact-date-picker-actions">
        <button type="button" class="primary-btn compact-btn" data-apply-history>Appliquer</button>
        <button type="button" class="link-btn muted" data-clear-history>Effacer</button>
      </div>
    </div>
  `;

  container.innerHTML = `
    <div class="ledger-page">
      <div class="ledger-page-header"><button type="button" class="ledger-back-btn" data-client-back>← Clients</button></div>
      <div class="ledger-entity-header">
        <div><p class="section-kicker">Profil client</p><h3>${customer.name}</h3><span class="subtle">${customer.phone}</span></div>
        <div class="ledger-entity-stats">
          <div class="customer-summary-card">
            <div class="customer-summary-header">
              <span>Total acheté</span>
              <button type="button" class="calendar-icon-btn" data-purchase-summary-toggle aria-label="Choisir une période pour le total acheté">📅</button>
            </div>
            ${purchaseSummaryPicker}
            <strong class="customer-summary-total">${formatMoney(purchaseSummaryTotal)}</strong>
          </div>
        </div>
      </div>
      <div class="ledger-section-heading">
        <h4>Historique des transactions</h4>
        <div class="ledger-history-filter-wrap">
          <button type="button" class="calendar-icon-btn" data-history-toggle aria-label="Choisir une période pour l’historique des transactions">📅</button>
          ${historyPicker}
          <span>${plural(transactionHistoryRows.length, 'transaction')}</span>
        </div>
      </div>
      <div class="ledger-table ledger-invoice-list">
        ${transactionHistoryRows.length ? transactionHistoryRows.map((invoice) => isReturn(invoice)
    ? `<button type="button" class="ledger-row invoice-ledger-row ledger-return-row" data-client-invoice-id="${invoice.id}"><span><strong>Retour n°${invoice.id.slice(-4)}</strong><small>${new Date(invoice.createdAt).toLocaleDateString('fr-FR')}</small></span><span><strong>${formatMoney(invoice.totalAmount)}</strong><small>Total du retour</small></span><span><strong>${invoice.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)}</strong><small>Article(s)</small></span><span class="ledger-remaining"><strong>&mdash;</strong><small>Reste à payer</small></span><span><b class="ledger-status ledger-status-return">Retour</b></span><span class="ledger-arrow">›</span></button>`
    : `<button type="button" class="ledger-row invoice-ledger-row" data-client-invoice-id="${invoice.id}"><span><strong>Facture n°${invoice.id.slice(-4)}</strong><small>${new Date(invoice.createdAt).toLocaleDateString('fr-FR')}</small></span><span><strong>${formatMoney(invoice.totalAmount)}</strong><small>Total</small></span><span><strong>${formatMoney(getInvoicePaidAmount(invoice))}</strong><small>Payé</small></span><span class="ledger-remaining"><strong>${formatMoney(getInvoiceRemainingAmount(invoice))}</strong><small>Reste à payer</small></span><span><b class="ledger-status ${getInvoiceRemainingAmount(invoice) <= 0 ? 'ledger-status-paid' : ''}">${getInvoiceStatus(invoice)}</b></span><span class="ledger-arrow">›</span></button>`
  ).join('') : '<p class="empty-state">Aucune transaction pour ce client.</p>'}
      </div>
    </div>
  `;

  container.querySelector('[data-client-back]')?.addEventListener('click', () => navigateClient('/clients'));
  container.querySelector('[data-purchase-summary-toggle]')?.addEventListener('click', () => {
    container.querySelector('[data-purchase-summary-picker]')?.classList.toggle('hidden');
  });
  container.querySelector('[data-history-toggle]')?.addEventListener('click', () => {
    container.querySelector('[data-history-picker]')?.classList.toggle('hidden');
  });
  container.querySelector('[data-apply-purchase-summary]')?.addEventListener('click', () => {
    const start = container.querySelector('[data-purchase-summary-start]')?.value || '';
    const end = container.querySelector('[data-purchase-summary-end]')?.value || '';
    customerPurchaseSummaryFilter = {
      mode: getDateFilterMode(start, end),
      start,
      end
    };
    container.querySelector('[data-purchase-summary-picker]')?.classList.add('hidden');
    renderClientProfilePage(container, customer);
  });
  container.querySelector('[data-clear-purchase-summary]')?.addEventListener('click', () => {
    customerPurchaseSummaryFilter = { mode: 'all', start: '', end: '' };
    container.querySelector('[data-purchase-summary-picker]')?.classList.add('hidden');
    renderClientProfilePage(container, customer);
  });
  container.querySelector('[data-apply-history]')?.addEventListener('click', () => {
    const start = container.querySelector('[data-history-start]')?.value || '';
    const end = container.querySelector('[data-history-end]')?.value || '';
    customerTransactionHistoryFilter = {
      mode: getDateFilterMode(start, end),
      start,
      end
    };
    container.querySelector('[data-history-picker]')?.classList.add('hidden');
    renderClientProfilePage(container, customer);
  });
  container.querySelector('[data-clear-history]')?.addEventListener('click', () => {
    customerTransactionHistoryFilter = { mode: 'all', start: '', end: '' };
    container.querySelector('[data-history-picker]')?.classList.add('hidden');
    renderClientProfilePage(container, customer);
  });
  container.querySelectorAll('[data-client-invoice-id]').forEach((button) => button.addEventListener('click', () => navigateClient(`/clients/${encodeURIComponent(customer.id)}/invoices/${encodeURIComponent(button.dataset.clientInvoiceId)}`)));
}

function renderClientInvoicePage(container, customer, invoiceId) {
  const invoice = state.sales.find((sale) => sale.id === invoiceId && sale.customerId === customer.id);
  if (!invoice) return navigateClient(`/clients/${encodeURIComponent(customer.id)}`);

  // A return is not an invoice: there is nothing paid, owed or settled on it.
  if (isReturn(invoice)) {
    container.innerHTML = `
      <div class="ledger-page ledger-invoice-page ledger-return-page">
        <div class="ledger-page-header"><button type="button" class="ledger-back-btn" data-client-back>← Profil de ${customer.name}</button></div>
        <div class="ledger-entity-header"><div><p class="section-kicker">Détails du retour</p><h3>Retour n°${invoice.id.slice(-4)}</h3><span class="subtle">${new Date(invoice.createdAt).toLocaleString('fr-FR')} · ${customer.name} · ${customer.phone}</span></div><b class="ledger-status ledger-status-return">Retour</b></div>
        <table class="ledger-detail-items"><thead><tr><th>Produit</th><th>Quantité</th><th>Prix unitaire</th><th>Total</th></tr></thead><tbody>${invoice.items.map((item) => `<tr><td>${item.productName}</td><td>${item.quantity}</td><td>${formatMoney(item.unitPrice)}</td><td>${formatMoney(item.subtotal)}</td></tr>`).join('')}</tbody></table>
        <div class="ledger-financial-summary"><div><span>Total du retour</span><strong>${formatMoney(invoice.totalAmount)}</strong></div><div><span>Articles retournés</span><strong>${invoice.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)}</strong></div></div>
        <p class="ledger-view-only-note">Ce retour est une transaction indépendante. Il ne modifie aucune facture ni aucun solde client.</p>
      </div>
    `;
    container.querySelector('[data-client-back]')?.addEventListener('click', () => navigateClient(`/clients/${encodeURIComponent(customer.id)}`));
    return;
  }

  const payments = customer.debtHistory.filter((entry) => entry.type === 'payment' && entry.saleId === invoice.id).sort((a, b) => new Date(b.date) - new Date(a.date));
  container.innerHTML = `
    <div class="ledger-page ledger-invoice-page">
      <div class="ledger-page-header"><button type="button" class="ledger-back-btn" data-client-back>← Profil de ${customer.name}</button></div>
      <div class="ledger-entity-header"><div><p class="section-kicker">Détails de la facture</p><h3>Facture n°${invoice.id.slice(-4)}</h3><span class="subtle">${new Date(invoice.createdAt).toLocaleString('fr-FR')} · ${customer.name} · ${customer.phone}</span></div><b class="ledger-status ${getInvoiceRemainingAmount(invoice) <= 0 ? 'ledger-status-paid' : ''}">${getInvoiceStatus(invoice)}</b></div>
      <table class="ledger-detail-items"><thead><tr><th>Produit</th><th>Quantité</th><th>Prix unitaire</th><th>Total</th></tr></thead><tbody>${invoice.items.map((item) => `<tr><td>${item.productName}</td><td>${item.quantity}</td><td>${formatMoney(item.unitPrice)}</td><td>${formatMoney(item.subtotal)}</td></tr>`).join('')}</tbody></table>
      <div class="ledger-financial-summary">${invoice.discountPercent > 0 ? `<div><span>Remise (${invoice.discountPercent} %)</span><strong>-${formatMoney(invoice.discount)}</strong></div>` : ''}<div><span>Total de la facture</span><strong>${formatMoney(invoice.totalAmount)}</strong></div><div><span>Total payé</span><strong>${formatMoney(getInvoicePaidAmount(invoice))}</strong></div><div><span>Reste à payer</span><strong>${formatMoney(getInvoiceRemainingAmount(invoice))}</strong></div></div>
      <div class="ledger-payment-history"><h4>Historique des paiements</h4>${payments.length ? payments.map((payment) => `<div><span>${new Date(payment.date).toLocaleString('fr-FR')}</span><strong>${formatMoney(payment.amount)}</strong></div>`).join('') : '<p class="empty-state">Aucun paiement enregistré pour cette facture.</p>'}</div>
      <p class="ledger-view-only-note">Consultation uniquement. Les paiements se gèrent depuis la section Dettes clients.</p>
    </div>
  `;
  container.querySelector('[data-client-back]')?.addEventListener('click', () => navigateClient(`/clients/${encodeURIComponent(customer.id)}`));
}

// The business identity printed on every invoice. It is the legal header from
// the pre-printed pads, so it belongs to the company rather than to a setting;
// anything the store settings do fill in still wins over these.
const INVOICE_BUSINESS = {
  legalName: 'ETS HH',
  poBox: 'B.P. 285',
  phone: '066.90.69.69',
  city: 'Port-Gentil',
  country: 'GABON',
  region: 'Gabon',
  site: 'Gabon - Port Gentil',
  thanks: 'Merci pour votre confiance !',
  strapline: 'DES FRUITS FRAIS TOUTE L’ANNÉE'
};

const INVOICE_TERMS = [
  'Dans le cas où le paiement intégral n’interviendrait pas à la date prévue par les parties, le vendeur se réserve le droit de reprendre la chose livrée et de résoudre le contrat.',
  'Nos marchandises ne sont ni reprises ni échangées passé un délai de 48 heures.'
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

const INVOICE_CURRENCY = 'F CFA';
const invoiceAmountFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const invoiceQuantityFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Cells carry bare numbers; the currency is named once, in the column header.
const invoiceAmount = (value) => invoiceAmountFormat.format(Number(value || 0));
// Line cells stay bare so the columns stay narrow -- the unit is named in their
// headers. The figures someone reads on their own, the banded totals, carry it.
const invoiceAmountWithUnit = (value) => `${invoiceAmount(value)} ${INVOICE_CURRENCY}`;

// The catalogue has no SKU column, so a line's reference is the tail of the
// product's own id: stable, unique, and it survives a rename.
function invoiceReference(item) {
  const id = item.productId || '';
  return id ? id.slice(-4).toUpperCase() : '—';
}

function openReceipt(saleId) {
  const sale = state.sales.find((entry) => entry.id === saleId);
  if (!sale) return;

  const settings = state.settings || {};
  const customer = getCustomerById(sale.customerId);
  const returning = isReturn(sale);

  const subtotal = sale.items.reduce((sum, item) => sum + (item.subtotal ?? item.quantity * item.unitPrice), 0);
  const discount = Number(sale.discount || 0);
  const discountPercent = Number(sale.discountPercent || 0);
  const settled = returning ? 0 : getInvoicePaidAmount(sale);
  const netToPay = returning ? 0 : getInvoiceRemainingAmount(sale);

  const paymentLabel = returning
    ? 'Retour de marchandise'
    : sale.paymentMethod === 'debt'
      ? (sale.paymentType === 'partial' ? 'Paiement partiel' : 'Crédit')
      : 'Espèces';

  const invoiceNumber = `${returning ? 'RET' : 'INV'}-${sale.id.slice(-6).toUpperCase()}`;
  const saleDate = new Date(sale.createdAt);
  const shortDate = saleDate.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const timeLabel = saleDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  const storeName = settings.storeName || 'H.H Fruit';
  const phone = settings.storePhone || INVOICE_BUSINESS.phone;
  const site = settings.storeAddress || INVOICE_BUSINESS.site;
  const thanks = settings.receiptFooter || INVOICE_BUSINESS.thanks;

  const itemRows = sale.items.map((item) => {
    const lineTotal = item.subtotal ?? item.quantity * item.unitPrice;
    return `
          <tr>
            <td class="inv-cell-ref">${escapeHtml(invoiceReference(item))}</td>
            <td class="inv-cell-name">${escapeHtml(item.productName || 'Article')}</td>
            <td class="inv-cell-num">${invoiceQuantityFormat.format(Number(item.quantity || 0))}</td>
            <td class="inv-cell-num">${invoiceAmount(item.unitPrice)}</td>
            <td class="inv-cell-num inv-cell-amount">${invoiceAmount(lineTotal)}</td>
          </tr>`;
  }).join('');

  // A return has no tender, so the payment lines become the returned amount.
  const totalsRows = returning
    ? `
          <div class="inv-total-line"><span>TOTAL HT</span><strong>${invoiceAmount(subtotal)}</strong></div>
          <div class="inv-total-line"><span>TOTAL REMISE</span><strong>${invoiceAmount(discount)}</strong></div>
          <div class="inv-total-line inv-total-ttc"><span>TOTAL TTC</span><strong>${invoiceAmountWithUnit(sale.totalAmount)}</strong></div>
          <div class="inv-total-line inv-total-net"><span>MONTANT DU RETOUR</span><strong>${invoiceAmountWithUnit(sale.totalAmount)}</strong></div>`
    : `
          <div class="inv-total-line"><span>TOTAL HT</span><strong>${invoiceAmount(subtotal)}</strong></div>
          <div class="inv-total-line"><span>TOTAL REMISE${discountPercent > 0 ? ` (${invoiceAmount(discountPercent)} %)` : ''}</span><strong>${invoiceAmount(discount)}</strong></div>
          <div class="inv-total-line inv-total-ttc"><span>TOTAL TTC</span><strong>${invoiceAmountWithUnit(sale.totalAmount)}</strong></div>
          <div class="inv-total-line"><span>RÈGLEMENT</span><strong>${invoiceAmount(settled)}</strong></div>
          <div class="inv-total-line inv-total-net"><span>NET À PAYER</span><strong>${invoiceAmountWithUnit(netToPay)}</strong></div>`;

  document.getElementById('receipt-content').innerHTML = `
    <div class="invoice-document${returning ? ' invoice-return-document' : ''}">
      <p class="inv-legal-line">
        <strong>${escapeHtml(INVOICE_BUSINESS.legalName)}</strong>
        <span>${escapeHtml(INVOICE_BUSINESS.poBox)}</span>
        <span>TÉL. : ${escapeHtml(phone)}</span>
        <span>${escapeHtml(INVOICE_BUSINESS.city)} ${escapeHtml(INVOICE_BUSINESS.country)}</span>
      </p>

      <header class="inv-head">
        <div class="inv-brand">
          <img src="/pics/logo.png" alt="Logo ${escapeHtml(storeName)}" />
        </div>

        <div class="inv-place">
          <span class="inv-pin" aria-hidden="true"></span>
          <div>
            <strong>${escapeHtml(INVOICE_BUSINESS.region)}</strong>
            <strong>${escapeHtml(INVOICE_BUSINESS.city)}</strong>
          </div>
        </div>

        <div class="inv-client">
          <div class="inv-client-row">
            <span>CODE CLIENT :</span>
            <b>${customer ? escapeHtml(customer.id.slice(-6).toUpperCase()) : ''}</b>
          </div>
          <div class="inv-client-row">
            <span>CLIENT :</span>
            <b>${customer ? escapeHtml(customer.name) : 'Client de passage'}</b>
          </div>
          <div class="inv-client-row">
            <span>SITE :</span>
            <b>${escapeHtml(site)}</b>
          </div>
        </div>
      </header>

      ${returning ? '<p class="invoice-return-banner">RETOUR</p>' : ''}

      <div class="inv-meta">
        <div><span>DATE</span><strong>${escapeHtml(shortDate)}</strong></div>
        <div><span>${returning ? 'N° RETOUR' : 'N° FACTURE'}</span><strong>${escapeHtml(invoiceNumber)}</strong></div>
        <div><span>HEURE</span><strong>${escapeHtml(timeLabel)}</strong></div>
      </div>

      <table class="inv-table">
        <thead>
          <tr>
            <th class="inv-cell-ref">RÉFÉRENCE</th>
            <th class="inv-cell-name">DÉSIGNATION</th>
            <th class="inv-cell-num">QTÉ</th>
            <th class="inv-cell-num">PRIX U. TTC<small>${INVOICE_CURRENCY}</small></th>
            <th class="inv-cell-num">MONTANT<small>${INVOICE_CURRENCY}</small></th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <section class="inv-summary">
        <div class="inv-thanks">
          <strong>Merci</strong>
          <span>${escapeHtml(thanks.replace(/^Merci\s*/i, '')) || 'pour votre confiance !'}</span>
        </div>
        <div class="inv-totals">${totalsRows}</div>
      </section>

      <section class="inv-closing">
        <table class="inv-tax">
          <thead>
            <tr><th>CODE</th><th>BASE<small>${INVOICE_CURRENCY}</small></th><th>TAUX</th><th>MONTANT<small>${INVOICE_CURRENCY}</small></th></tr>
          </thead>
          <tbody>
            <tr><td>Total</td><td>0</td><td>0</td><td>0</td></tr>
          </tbody>
        </table>

        <div class="inv-settlement">
          <div><span>Échéance :</span><strong>${escapeHtml(shortDate)}</strong></div>
          <div><span>Mode de règlement :</span><strong>${escapeHtml(paymentLabel)}</strong></div>
        </div>

        <div class="inv-terms">
          ${INVOICE_TERMS.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}
        </div>
      </section>

      <footer class="inv-strapline">
        <span class="inv-strapline-mark" aria-hidden="true"></span>
        <span>${escapeHtml(INVOICE_BUSINESS.strapline)}</span>
      </footer>
    </div>
  `;

  const printButton = document.getElementById('print-receipt-btn');
  if (printButton) printButton.textContent = returning ? 'Imprimer le reçu' : 'Imprimer la facture';
  document.getElementById('receipt-modal').classList.remove('hidden');
}

function closeReceipt() {
  document.getElementById('receipt-modal').classList.add('hidden');
}

let pendingDeleteSaleId = null;

function openDeleteSaleConfirmation(saleId) {
  const sale = state.sales.find((entry) => entry.id === saleId);
  if (!sale) return;
  const customer = getCustomerById(sale.customerId);
  pendingDeleteSaleId = saleId;
  const who = customer ? customer.name : 'le client de passage';
  document.getElementById('delete-sale-title').textContent = isReturn(sale) ? 'Supprimer ce retour ?' : 'Supprimer cette vente ?';
  document.getElementById('delete-sale-text').textContent = isReturn(sale)
    ? `Le retour de ${formatMoney(sale.totalAmount)} pour ${who} sera supprimé et les unités réapprovisionnées seront retirées du stock.`
    : `La vente de ${formatMoney(sale.totalAmount)} pour ${who} sera supprimée. Le stock, les totaux du client, les dettes et les recettes seront rétablis.`;
  document.getElementById('delete-sale-modal').classList.remove('hidden');
}

function closeDeleteSaleConfirmation() {
  pendingDeleteSaleId = null;
  document.getElementById('delete-sale-modal').classList.add('hidden');
}

async function confirmDeleteSale() {
  if (!pendingDeleteSaleId) return;
  const saleIndex = state.sales.findIndex((sale) => sale.id === pendingDeleteSaleId);
  if (saleIndex < 0) return;

  const sale = state.sales[saleIndex];
  const returning = isReturn(sale);
  const saved = await mutate(`/sales/${sale.id}`, 'DELETE', null, () => {
    state.sales = state.sales.filter((entry) => entry.id !== sale.id);
  });
  if (saved === null) return;
  closeDeleteSaleConfirmation();
  closeReceipt();
  showMessage('pos-message', returning ? 'Retour supprimé et stock rétabli.' : 'Vente supprimée et écritures rétablies.', 'success');
}

async function handleProductSubmit(event) {
  event.preventDefault();
  const payload = {
    name: document.getElementById('product-name').value.trim(),
    sellingPrice: Number(document.getElementById('product-price').value),
    description: document.getElementById('product-description').value.trim(),
    lowStockThreshold: Math.max(0, Number(document.getElementById('product-low-stock-threshold').value) || 0)
  };
  const startingStock = Number(document.getElementById('product-stock').value);

  if (!payload.name || payload.sellingPrice < 0) {
    return;
  }

  if (!editingProductId && startingStock < 0) return;
  const saved = editingProductId
    ? await mutate(`/products/${editingProductId}`, 'PUT', payload)
    : await mutate('/products', 'POST', { ...payload, stock: startingStock });
  if (saved === null) return;
  cancelProductEdit();
}

async function handleCustomerSubmit(event) {
  event.preventDefault();
  const payload = {
    name: document.getElementById('customer-name').value.trim(),
    phone: document.getElementById('customer-phone').value.trim(),
    address: document.getElementById('customer-address').value.trim()
  };

  if (!payload.name || !payload.phone) return;

  const saved = editingCustomerId
    ? await mutate(`/customers/${editingCustomerId}`, 'PUT', payload)
    : await mutate('/customers', 'POST', payload);
  if (saved === null) return;
  cancelCustomerEdit();
}

function toggleNewCustomerFields() {
  const fields = document.getElementById('new-customer-fields');
  const isHidden = fields.classList.toggle('hidden');
  if (!isHidden) document.getElementById('new-customer-name').focus();
}

async function addCustomerFromPos() {
  const name = document.getElementById('new-customer-name').value.trim();
  const phone = document.getElementById('new-customer-phone').value.trim();
  const address = document.getElementById('new-customer-address').value.trim();

  if (!name || !phone) {
    showMessage('pos-message', 'Le nom et le téléphone du client sont obligatoires.', 'error');
    return;
  }

  const saved = await mutate('/customers', 'POST', { name, phone, address });
  if (saved === null) return;
  selectedPosCustomerId = saved.customer.id;
  document.getElementById('pos-customer-search').value = `${saved.customer.name} (${saved.customer.phone})`;
  document.getElementById('new-customer-name').value = '';
  document.getElementById('new-customer-phone').value = '';
  document.getElementById('new-customer-address').value = '';
  document.getElementById('new-customer-fields').classList.add('hidden');
  showMessage('pos-message', 'Client créé avec succès.', 'success');
}

let pendingPayment = null;
let pendingSale = null;
let isCompletingTransaction = false;

function updatePosPaymentFields() {
  const method = document.getElementById('payment-method-select').value;
  const field = document.getElementById('partial-payment-field');
  const input = document.getElementById('partial-payment-amount');
  const total = getCartTotal();
  field.classList.toggle('hidden', method !== 'partial');
  input.required = method === 'partial';
  input.max = total > 0 ? total - 0.01 : '';
  if (method !== 'partial') input.value = '';
}

function openPaymentConfirmation() {
  const customerId = document.getElementById('payment-customer-select').value;
  const invoiceId = document.getElementById('payment-invoice-select').value;
  const amount = Number(document.getElementById('payment-amount').value);

  if (!customerId || !invoiceId || !amount || amount <= 0) {
    showMessage('payment-message', 'Sélectionnez une facture et saisissez un montant valide.', 'error');
    return;
  }

  const customer = getCustomerById(customerId);
  const invoice = state.sales.find((sale) => sale.id === invoiceId && sale.customerId === customerId);
  if (!customer || !invoice || amount > getInvoiceRemainingAmount(invoice)) {
    showMessage('payment-message', 'Le paiement ne peut pas dépasser le reste à payer de la facture.', 'error');
    return;
  }

  pendingPayment = { customerId, invoiceId, amount, customerName: customer.name, invoiceNumber: invoice.id.slice(-4) };
  document.getElementById('payment-confirm-text').textContent = `Enregistrer ${formatMoney(amount)} sur la facture n°${invoice.id.slice(-4)} de ${customer.name} ?`;
  document.getElementById('payment-confirm-modal').classList.remove('hidden');
}

function closePaymentConfirmation() {
  pendingPayment = null;
  document.getElementById('payment-confirm-modal').classList.add('hidden');
}

function recordPayment(event) {
  event.preventDefault();
  openPaymentConfirmation();
}

async function confirmPaymentRecord() {
  if (!pendingPayment) return;

  const customer = getCustomerById(pendingPayment.customerId);
  const invoice = state.sales.find((sale) => sale.id === pendingPayment.invoiceId && sale.customerId === pendingPayment.customerId);
  if (!customer || !invoice) return;

  if (pendingPayment.amount > getInvoiceRemainingAmount(invoice)) return;
  const paymentAmount = pendingPayment.amount;
  const invoiceNumber = pendingPayment.invoiceNumber;
  const saved = await mutate(`/sales/${invoice.id}/payments`, 'POST', { amount: paymentAmount });
  if (saved === null) return;
  document.getElementById('payment-form').reset();
  closePaymentConfirmation();
  showMessage('payment-message', `Paiement de ${formatMoney(paymentAmount)} enregistré sur la facture n°${invoiceNumber}.`, 'success');
}

const EMPTY_CART_ERRORS = {
  sale: 'Ajoutez au moins un produit à la vente.',
  return: 'Ajoutez au moins un produit au retour.',
  waste: 'Ajoutez au moins un produit à la perte.'
};

function completeSale() {
  const returning = isReturnMode();

  if (!cart.length) {
    showMessage('pos-message', EMPTY_CART_ERRORS[posMode], 'error');
    return;
  }
  if (cart.some((item) => !Number.isFinite(item.quantity) || item.quantity < 1)) {
    showMessage('pos-message', 'Chaque quantité doit être supérieure à 0.', 'error');
    return;
  }

  const customerId = selectedPosCustomerId;
  const totalAmount = getCartTotal();

  // A write-off has no counterparty and no tender: products leave the shelf and
  // the shop absorbs their selling value as the loss.
  if (isWasteMode()) {
    const reason = document.getElementById('waste-reason')?.value || 'Autre';
    pendingSale = { type: 'waste', reason, totalAmount, items: structuredClone(cart) };
    document.getElementById('sale-confirm-title').textContent = 'Enregistrer cette perte ?';
    document.getElementById('sale-confirm-text').textContent =
      `${formatMoney(totalAmount)} · ${plural(cart.length, 'article')} · Motif : ${reason} · Retiré du stock`;
    document.getElementById('sale-confirm-modal').classList.remove('hidden');
    return;
  }

  // A return is not a payment: the refund settles the customer's debt first and
  // only the remainder leaves the till, so the client stays optional.
  if (returning) {
    pendingSale = { type: 'return', customerId: customerId || null, totalAmount, items: structuredClone(cart) };
    const customer = customerId ? getCustomerById(customerId) : null;
    document.getElementById('sale-confirm-title').textContent = 'Finaliser ce retour ?';
    document.getElementById('sale-confirm-text').textContent =
      `${formatMoney(totalAmount)} · ${plural(cart.length, 'article')} · Retour · ${customer ? customer.name : 'Client de passage'}`;
    document.getElementById('sale-confirm-modal').classList.remove('hidden');
    return;
  }

  const paymentMethod = document.getElementById('payment-method-select').value;
  const partialAmount = Number(document.getElementById('partial-payment-amount')?.value || 0);

  if (paymentMethod !== 'cash' && !customerId) {
    showMessage('pos-message', 'Un client est obligatoire pour une vente à crédit.', 'error');
    return;
  }
  if (paymentMethod === 'partial' && (!partialAmount || partialAmount <= 0 || partialAmount >= totalAmount)) {
    showMessage('pos-message', 'Saisissez un montant inférieur au total de la facture.', 'error');
    return;
  }

  pendingSale = { type: 'sale', customerId: customerId || null, paymentMethod, partialAmount, totalAmount, items: structuredClone(cart) };
  const paymentLabel = paymentMethod === 'cash' ? 'Vente comptant' : paymentMethod === 'partial' ? `Paiement partiel · ${formatMoney(partialAmount)} payé maintenant` : 'Vente à crédit';
  document.getElementById('sale-confirm-title').textContent = 'Finaliser cette vente ?';
  document.getElementById('sale-confirm-text').textContent = `${formatMoney(totalAmount)} · ${plural(cart.length, 'article')} · ${paymentLabel}`;
  document.getElementById('sale-confirm-modal').classList.remove('hidden');
}

function closeSaleConfirmation() {
  pendingSale = null;
  document.getElementById('sale-confirm-modal').classList.add('hidden');
}

async function confirmSale() {
  // pendingSale is cleared synchronously below, before the first await, so a
  // second click during the save cannot record the transaction twice.
  if (!pendingSale || isCompletingTransaction) return;
  isCompletingTransaction = true;
  document.getElementById('confirm-sale-btn').disabled = true;

  try {
    if (pendingSale.type === 'return') await confirmReturn();
    else if (pendingSale.type === 'waste') await confirmWaste();
    else await confirmSaleTransaction();
  } finally {
    isCompletingTransaction = false;
    document.getElementById('confirm-sale-btn').disabled = false;
  }
}

// Resets the register after any completed transaction.
function clearPos() {
  cart = [];
  saleDiscountPercent = 0;
  selectedPosCustomerId = null;
  const search = document.getElementById('pos-customer-search');
  if (search) search.value = '';
  const discount = document.getElementById('sale-discount-percent');
  if (discount) discount.value = '';
  closeSaleConfirmation();
}

// An independent Retour transaction: it never links to the original invoice.
// The money is settled against whatever the customer still owes, and the server
// says how much of it had to come out of the till.
async function confirmReturn() {
  const { customerId, items } = pendingSale;
  const saved = await mutate('/sales', 'POST', {
    type: 'return',
    customerId,
    items: items.map((item) => ({ productId: item.productId, quantity: item.quantity }))
  });
  if (saved === null) return;

  clearPos();
  const credited = Number(saved.sale?.debtCredit || 0);
  const cashed = Number(saved.sale?.cashRefund || 0);
  const settlement = credited > 0 && cashed > 0
    ? `${formatMoney(credited)} déduits de la dette, ${formatMoney(cashed)} rendus en espèces.`
    : credited > 0
      ? `${formatMoney(credited)} déduits de la dette du client.`
      : `${formatMoney(cashed)} rendus en espèces.`;
  showMessage('pos-message', `Retour enregistré. Le stock a été réapprovisionné. ${settlement}`, 'success');
  openReceipt(saved.sale.id);
}

// A write-off. There is no counterparty and nothing to hand over, so it produces
// no receipt -- only the stock movement and the recorded loss.
async function confirmWaste() {
  const { reason, items } = pendingSale;
  const saved = await mutate('/sales', 'POST', {
    type: 'waste',
    reason,
    items: items.map((item) => ({ productId: item.productId, quantity: item.quantity }))
  });
  if (saved === null) return;

  clearPos();
  showMessage(
    'pos-message',
    `Perte enregistrée : ${formatMoney(saved.sale.totalAmount)}. Les produits ont été retirés du stock.`,
    'success'
  );
}

async function confirmSaleTransaction() {
  const { customerId, paymentMethod, partialAmount, items } = pendingSale;
  const saved = await mutate('/sales', 'POST', {
    type: 'sale',
    customerId,
    paymentType: paymentMethod,
    partialAmount: paymentMethod === 'partial' ? partialAmount : 0,
    discountPercent: saleDiscountPercent,
    items: items.map((item) => ({ productId: item.productId, quantity: item.quantity }))
  });
  if (saved === null) return;

  clearPos();
  showMessage('pos-message', 'Vente finalisée avec succès.', 'success');
  openReceipt(saved.sale.id);
}

// --- Achats -----------------------------------------------------------------
// Supplier intake. Deliberately its own cart rather than a fourth mode of the
// register: the till is the one screen the shop runs on all day, and widening it
// to carry buying prices as well as selling prices would put that at risk for no
// gain the user can see. The ~40 lines of cart code below are the price of that.

let purchaseCart = [];
let isSavingPurchase = false;

function getPurchaseTotal() {
  return purchaseCart.reduce((total, item) => total + item.quantity * item.unitPrice, 0);
}

function renderPurchaseProducts() {
  const container = document.getElementById('purchase-product-list');
  if (!container) return;
  const search = document.getElementById('purchase-product-search')?.value?.toLowerCase() || '';
  const list = state.products.filter((product) => product.name.toLowerCase().includes(search));

  // Nothing is ever out of stock for buying, so no button is ever disabled.
  container.innerHTML = list.length
    ? list.map((product) => `
    <div class="catalog-item">
      <div class="meta">
        <strong>${escapeHtml(product.name)}</strong>
        <small>${product.stock} en stock · vente ${formatMoney(product.sellingPrice)}</small>
      </div>
      <button class="add-btn primary-btn" data-add-purchase="${product.id}">Ajouter</button>
    </div>
  `).join('')
    : '<div class="empty-cart"><strong>Aucun produit</strong><p>Créez d’abord un produit dans le catalogue.</p></div>';

  container.querySelectorAll('[data-add-purchase]').forEach((button) => {
    button.addEventListener('click', () => addToPurchase(button.dataset.addPurchase));
  });
}

function addToPurchase(productId) {
  const product = getProductById(productId);
  if (!product) return;
  const existing = purchaseCart.find((item) => item.productId === productId);
  if (existing) existing.quantity += 1;
  // Seeded from the selling price only as a starting point: it is the one number
  // we have, and the buyer overwrites it with what was actually paid.
  else purchaseCart.push({ productId, productName: product.name, quantity: 1, unitPrice: product.sellingPrice });
  renderPurchaseCart();
}

function renderPurchaseCart() {
  const container = document.getElementById('purchase-cart-items');
  if (!container) return;
  const count = document.getElementById('purchase-count');
  const units = purchaseCart.reduce((total, item) => total + item.quantity, 0);
  if (count) count.textContent = plural(units, 'article');

  if (!purchaseCart.length) {
    container.innerHTML = '<div class="empty-cart"><span class="empty-cart-icon">&#8595;</span><strong>Aucun achat en cours</strong><p>Ajoutez les produits reçus du fournisseur.</p></div>';
    document.getElementById('purchase-total-value').textContent = formatMoney(0);
    return;
  }

  container.innerHTML = purchaseCart.map((item) => `
    <div class="cart-row">
      <div class="cart-product-name">
        <strong>${escapeHtml(item.productName)}</strong>
      </div>
      <button class="link-btn cart-remove-btn" data-purchase-remove="${item.productId}">Retirer</button>
      <label class="cart-quantity-field">
        <span>Quantité</span>
        <input data-purchase-qty="${item.productId}" type="number" min="1" step="1" value="${item.quantity}" />
      </label>
      <div class="price-box">
        <label for="purchase-price-${item.productId}">Prix d’achat (F CFA)</label>
        <input id="purchase-price-${item.productId}" data-purchase-price="${item.productId}" type="number" step="0.01" min="0" value="${item.unitPrice}" />
      </div>
      <div class="cart-line-total">
        <span>Total de la ligne</span>
        <strong>${formatMoney(item.quantity * item.unitPrice)}</strong>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-purchase-qty]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const item = purchaseCart.find((entry) => entry.productId === input.dataset.purchaseQty);
      if (!item) return;
      item.quantity = Math.max(1, Math.floor(Number(event.target.value) || 1));
      renderPurchaseCart();
    });
  });

  container.querySelectorAll('[data-purchase-price]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const item = purchaseCart.find((entry) => entry.productId === input.dataset.purchasePrice);
      if (!item) return;
      item.unitPrice = Math.max(0, Number(event.target.value) || 0);
      renderPurchaseCart();
    });
  });

  container.querySelectorAll('[data-purchase-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      purchaseCart = purchaseCart.filter((entry) => entry.productId !== button.dataset.purchaseRemove);
      renderPurchaseCart();
    });
  });

  document.getElementById('purchase-total-value').textContent = formatMoney(getPurchaseTotal());
}

function renderPurchases() {
  renderPurchaseProducts();
  renderPurchaseCart();
}

async function completePurchase() {
  if (isSavingPurchase) return;
  if (!purchaseCart.length) {
    showMessage('purchase-message', 'Ajoutez au moins un produit à l’achat.', 'error');
    return;
  }

  isSavingPurchase = true;
  const button = document.getElementById('complete-purchase-btn');
  if (button) button.disabled = true;

  try {
    // Unlike a sale, the unit price is sent: it is what the shop paid, and
    // nothing in the catalogue knows it.
    const saved = await mutate('/sales', 'POST', {
      type: 'purchase',
      supplier: document.getElementById('purchase-supplier')?.value?.trim() || '',
      items: purchaseCart.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice
      }))
    });
    if (saved === null) return;

    purchaseCart = [];
    const supplierField = document.getElementById('purchase-supplier');
    if (supplierField) supplierField.value = '';
    renderPurchases();
    showMessage(
      'purchase-message',
      `Achat enregistré : ${formatMoney(saved.sale.totalAmount)}. Le stock a été mis à jour.`,
      'success'
    );
  } finally {
    isSavingPurchase = false;
    if (button) button.disabled = false;
  }
}

function setStockScope(scope) {
  const next = scope === 'purchases' ? 'purchases' : 'catalogue';
  document.querySelectorAll('[data-stock-scope]').forEach((button) => {
    const active = button.dataset.stockScope === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.getElementById('stock-catalogue')?.classList.toggle('hidden', next !== 'catalogue');
  document.getElementById('stock-purchases')?.classList.toggle('hidden', next !== 'purchases');
  // The "+" in the page header creates a product, which only makes sense on the
  // catalogue side.
  document.getElementById('add-product-btn')?.classList.toggle('hidden', next !== 'catalogue');
}

function setupPurchaseListeners() {
  document.querySelectorAll('[data-stock-scope]').forEach((button) => {
    button.addEventListener('click', () => setStockScope(button.dataset.stockScope));
  });
  document.getElementById('purchase-product-search')?.addEventListener('input', renderPurchaseProducts);
  document.getElementById('complete-purchase-btn')?.addEventListener('click', completePurchase);
}

// --- Rapports ---------------------------------------------------------------
// Everything that moved in a day or a period, on one timeline: sales, purchases,
// returns, write-offs, stock corrections and expenses.
//
// Computed in the browser from `state`, because /api/state already ships every
// transaction on load and the dashboard, the history and the expenses page all
// filter the same way. That holds for a few thousand transactions; past that this
// wants to become a server-side aggregate over a date range.

// Label, sign against the till, and which side of the stock ledger each type sits
// on. `cash` is what the type does to money actually in the drawer.
const REPORT_TYPES = {
  sale:       { label: 'Vente',      stock: 'out', chip: 'sale' },
  purchase:   { label: 'Achat',      stock: 'in',  chip: 'purchase' },
  return:     { label: 'Retour',     stock: 'in',  chip: 'return' },
  waste:      { label: 'Perte',      stock: 'out', chip: 'waste' },
  adjustment: { label: 'Ajustement', stock: 'in',  chip: 'adjustment' },
  expense:    { label: 'Dépense',    stock: null,  chip: 'expense' }
};

// Which transaction types each filter chip lets through. 'money' is the cash view:
// only the types that move money in or out of the till.
const REPORT_CATEGORIES = {
  all:        ['sale', 'purchase', 'return', 'waste', 'adjustment', 'expense'],
  money:      ['sale', 'purchase', 'return', 'expense'],
  sale:       ['sale'],
  purchase:   ['purchase'],
  return:     ['return'],
  waste:      ['waste'],
  expense:    ['expense'],
  adjustment: ['adjustment']
};

let reportFilters = { mode: 'day', day: '', start: '', end: '', category: 'all', customerId: '' };

// The date filter this page is currently describing, in the shape the shared
// matchesDateRangeFilter() helper expects.
function getReportFilter() {
  if (reportFilters.mode === 'day') {
    const day = reportFilters.day || toDateInputValue(new Date());
    return { mode: 'day', start: day, end: day };
  }
  return getDateFilterMode(reportFilters.start, reportFilters.end) === 'all'
    ? { mode: 'all', start: '', end: '' }
    : { mode: getDateFilterMode(reportFilters.start, reportFilters.end), start: reportFilters.start, end: reportFilters.end };
}

// An expense carries a plain calendar day rather than a timestamp, so it is
// compared as one: midday keeps it inside its own day in every timezone.
function expenseWithinFilter(expense, filter) {
  return matchesDateRangeFilter(`${expense.date}T12:00:00`, filter);
}

// What the Détail column names: the counterparty for a sale, the supplier for a
// delivery, and for the types that have neither, what actually happened.
function reportRowParty(type, sale, customer) {
  if (type === 'purchase') return sale.supplier || 'Fournisseur non précisé';
  if (type === 'waste') return sale.reason || 'Autre';
  if (type === 'adjustment') return 'Correction de stock';
  return customer ? customer.name : 'Client de passage';
}

// Every movement in the period, newest first, as one shape regardless of source.
function getReportRows() {
  const filter = getReportFilter();
  const allowed = new Set(REPORT_CATEGORIES[reportFilters.category] || REPORT_CATEGORIES.all);

  const rows = [];

  for (const sale of state.sales) {
    const type = getTransactionType(sale);
    if (!REPORT_TYPES[type] || !allowed.has(type)) continue;
    if (!matchesDateRangeFilter(sale.createdAt, filter)) continue;
    // Narrowing to one customer is a question about trade with them, so the
    // movements that have no customer drop out rather than showing as noise.
    if (reportFilters.customerId && sale.customerId !== reportFilters.customerId) continue;

    const customer = sale.customerId ? getCustomerById(sale.customerId) : null;
    rows.push({
      id: sale.id,
      type,
      at: sale.createdAt,
      party: reportRowParty(type, sale, customer),
      detail: type === 'adjustment' && sale.reason ? sale.reason : '',
      units: sale.items.reduce((total, item) => total + Number(item.quantity || 0), 0),
      amount: Number(sale.totalAmount || 0),
      sale
    });
  }

  if (allowed.has('expense') && !reportFilters.customerId) {
    for (const expense of state.expenses) {
      if (!expenseWithinFilter(expense, filter)) continue;
      rows.push({
        id: expense.id,
        type: 'expense',
        at: `${expense.date}T12:00:00`,
        party: expense.type,
        detail: expense.note || '',
        units: 0,
        amount: Number(expense.amount || 0)
      });
    }
  }

  return rows.sort((a, b) => new Date(b.at) - new Date(a.at));
}

// Debt payments are their own money event: they are cash arriving later for a
// sale that was booked earlier, so they are counted on the day they were paid.
function getReportPayments(filter) {
  const payments = [];
  for (const customer of state.customers) {
    for (const entry of customer.debtHistory || []) {
      if (entry.type !== 'payment') continue;
      if (!matchesDateRangeFilter(entry.date, filter)) continue;
      payments.push({
        customer,
        amount: Number(entry.amount || 0),
        date: entry.date,
        saleId: entry.saleId,
        returnSaleId: entry.returnSaleId || null
      });
    }
  }
  return payments;
}

function summariseReport(rows) {
  const filter = getReportFilter();
  const totalFor = (type) => rows.filter((row) => row.type === type).reduce((sum, row) => sum + row.amount, 0);
  const unitsFor = (type) => rows.filter((row) => row.type === type).reduce((sum, row) => sum + row.units, 0);

  // Cash in has exactly two sources, and they must not overlap. A cash sale
  // writes no ledger entry, so it is counted from the invoice. Everything else --
  // a deposit on a credit sale, a debt settled weeks later -- is a ledger entry
  // dated when the money actually arrived, and is counted there.
  const saleCash = rows
    .filter((row) => row.type === 'sale' && row.sale?.paymentMethod === 'cash')
    .reduce((sum, row) => sum + row.amount, 0);
  // A credit written off by a return looks like a payment in the ledger but no
  // money changed hands, so it is excluded.
  const debtPaid = getReportPayments(filter)
    .filter((payment) => !payment.returnSaleId)
    .reduce((sum, payment) => sum + payment.amount, 0);

  // Cash out: bought stock, paid expenses, and the part of a refund that left the
  // drawer rather than being written off a customer's debt.
  const refundCash = rows
    .filter((row) => row.type === 'return')
    .reduce((sum, row) => sum + Number(row.sale?.cashRefund || 0), 0);

  const cashIn = saleCash + debtPaid;
  const cashOut = totalFor('purchase') + totalFor('expense') + refundCash;

  return {
    cashIn,
    cashOut,
    net: cashIn - cashOut,
    salesValue: totalFor('sale'),
    purchaseValue: totalFor('purchase'),
    returnValue: totalFor('return'),
    wasteValue: totalFor('waste'),
    expenseValue: totalFor('expense'),
    unitsSold: unitsFor('sale'),
    unitsBought: unitsFor('purchase'),
    unitsReturned: unitsFor('return'),
    unitsWasted: unitsFor('waste'),
    unitsAdjusted: unitsFor('adjustment'),
    count: rows.length,
    // Not period figures: these are the state of the shop right now, carried over
    // from the dashboard this page replaced.
    owedNow: state.customers.reduce((sum, customer) => sum + Number(customer.balance || 0), 0),
    lowStockNow: state.products.filter((product) => product.stock <= getLowStockThreshold(product)).length
  };
}

function reportPeriodLabel() {
  const filter = getReportFilter();
  if (filter.mode === 'day') {
    return new Date(`${filter.start}T12:00:00`).toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
  }
  return getDateFilterSummary(filter);
}

function reportTiles(summary) {
  const money = [
    ['Encaissé', formatMoney(summary.cashIn), 'Ventes réglées et dettes payées'],
    ['Décaissé', formatMoney(summary.cashOut), 'Achats, dépenses et remboursements'],
    ['Solde net', formatMoney(summary.net), summary.net >= 0 ? 'Excédent sur la période' : 'Déficit sur la période'],
    ['Total dû', formatMoney(summary.owedNow), 'Dettes clients en cours, toutes périodes'],
    ['Stock faible', summary.lowStockNow, summary.lowStockNow ? 'Produits à réapprovisionner' : 'Stock suffisant partout']
  ];
  const stock = [
    ['Vendus', summary.unitsSold, formatMoney(summary.salesValue)],
    ['Achetés', summary.unitsBought, formatMoney(summary.purchaseValue)],
    ['Retournés', summary.unitsReturned, formatMoney(summary.returnValue)],
    ['Perdus', summary.unitsWasted, formatMoney(summary.wasteValue)],
    ['Ajustés', summary.unitsAdjusted, 'Corrections manuelles']
  ];

  return `
    <div class="report-tiles">
      ${money.map(([label, value, hint]) => `
        <div class="report-tile">
          <span class="report-tile-label">${label}</span>
          <strong class="report-tile-value">${value}</strong>
          <small>${hint}</small>
        </div>`).join('')}
    </div>

    <div class="report-tiles report-tiles-stock">
      ${stock.map(([label, units, hint]) => `
        <div class="report-tile report-tile-compact">
          <span class="report-tile-label">${label}</span>
          <strong class="report-tile-value">${units}</strong>
          <small>${hint}</small>
        </div>`).join('')}
    </div>`;
}

// The payment pill the retired Historique page showed. Only a sale has a tender.
function reportSettlement(row) {
  if (row.type !== 'sale') return '<span class="subtle">—</span>';
  const credit = row.sale?.paymentMethod === 'debt';
  const label = credit ? (row.sale?.paymentType === 'partial' ? getInvoiceStatus(row.sale) : 'Crédit') : 'Espèces';
  return `<span class="mini-pill ${credit ? 'warning' : 'success'}">${label}</span>`;
}

// Which row actions a movement offers. A purchase or a correction has no invoice
// to show, and an expense is edited rather than reprinted.
function reportRowActions(row) {
  if (row.type === 'sale' || row.type === 'return') {
    return `<button class="link-btn" data-report-view="${row.id}">Voir</button>
            <button class="link-btn danger-link" data-report-delete="${row.id}">Supprimer</button>`;
  }
  if (row.type === 'expense') {
    return `<button class="link-btn" data-report-edit-expense="${row.id}">Modifier</button>
            <button class="link-btn danger-link" data-report-delete-expense="${row.id}">Supprimer</button>`;
  }
  if (row.type === 'purchase' || row.type === 'waste') {
    return `<button class="link-btn danger-link" data-report-delete="${row.id}">Supprimer</button>`;
  }
  return '';
}

function reportTable(rows) {
  if (!rows.length) {
    return `
      <div class="card">
        <div class="empty-state-block">
          <strong>Aucun mouvement sur cette période</strong>
          <p>Changez la date ou la catégorie pour voir d’autres transactions.</p>
        </div>
      </div>`;
  }

  return `
    <div class="card">
      <div class="table-wrap report-table-wrap">
        <table class="report-table">
          <thead>
            <tr>
              <th>Date</th><th>Type</th><th>Détail</th><th>Règlement</th>
              <th class="report-num">Articles</th><th class="report-num">Montant</th>
              <th class="row-actions-head" aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => {
    const meta = REPORT_TYPES[row.type];
    const when = new Date(row.at);
    const stamp = row.type === 'expense'
      ? when.toLocaleDateString('fr-FR')
      : `${when.toLocaleDateString('fr-FR')} ${when.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    return `
              <tr class="report-row report-row-${meta.chip}">
                <td>${stamp}</td>
                <td><span class="mini-pill report-pill-${meta.chip}">${meta.label}</span></td>
                <td>${escapeHtml(row.party)}${row.detail ? `<small class="report-detail">${escapeHtml(row.detail)}</small>` : ''}</td>
                <td>${reportSettlement(row)}</td>
                <td class="report-num">${row.units || '—'}</td>
                <td class="report-num">${formatMoney(row.amount)}</td>
                <td class="row-actions">${reportRowActions(row)}</td>
              </tr>`;
  }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderReports() {
  const container = document.getElementById('report-view');
  if (!container) return;

  const rows = getReportRows();
  const summary = summariseReport(rows);

  container.innerHTML = `
    <p class="report-period">${escapeHtml(reportPeriodLabel())} · ${plural(summary.count, 'mouvement')}</p>
    ${reportTiles(summary)}
    ${reportTable(rows)}`;

  const bind = (attribute, handler) => container.querySelectorAll(`[${attribute}]`).forEach((button) => {
    button.addEventListener('click', () => handler(button.getAttribute(attribute)));
  });
  bind('data-report-view', openReceipt);
  bind('data-report-delete', openDeleteSaleConfirmation);
  bind('data-report-edit-expense', openExpenseEditor);
  bind('data-report-delete-expense', openExpenseDeleteConfirmation);
}

// The customer typeahead the retired Historique page carried. Picking a customer
// narrows the report to their trade; clearing the box widens it again.
function renderReportCustomerSuggestions() {
  const input = document.getElementById('report-customer');
  const list = document.getElementById('report-customer-suggestions');
  if (!input || !list) return;

  const query = input.value.toLowerCase().trim();
  if (!query) {
    list.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  const matches = state.customers
    .filter((customer) => `${customer.name} ${customer.phone}`.toLowerCase().includes(query))
    .slice(0, 6);

  list.innerHTML = matches.length
    ? matches.map((customer) => `<button type="button" data-report-customer="${customer.id}"><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.phone)}</small></button>`).join('')
    : '<p class="suggestion-empty">Aucun client trouvé.</p>';
  list.classList.remove('hidden');

  list.querySelectorAll('[data-report-customer]').forEach((button) => {
    button.addEventListener('click', () => {
      const customer = getCustomerById(button.dataset.reportCustomer);
      reportFilters.customerId = customer.id;
      input.value = `${customer.name} (${customer.phone})`;
      list.classList.add('hidden');
      renderReports();
    });
  });
}

function setReportMode(mode) {
  const next = mode === 'range' ? 'range' : 'day';
  if (next === reportFilters.mode) return;
  reportFilters.mode = next;

  document.querySelectorAll('[data-report-mode]').forEach((button) => {
    const active = button.dataset.reportMode === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.getElementById('report-day-field')?.classList.toggle('hidden', next !== 'day');
  document.getElementById('report-start-field')?.classList.toggle('hidden', next !== 'range');
  document.getElementById('report-end-field')?.classList.toggle('hidden', next !== 'range');
  renderReports();
}

function setReportCategory(category) {
  reportFilters.category = REPORT_CATEGORIES[category] ? category : 'all';
  document.querySelectorAll('[data-report-category]').forEach((button) => {
    const active = button.dataset.reportCategory === reportFilters.category;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  renderReports();
}

// The printable sheet's markup: the same letterhead as the invoice, the period
// it covers, the totals and the movements behind them.
function buildReportSheet() {
  const rows = getReportRows();
  const summary = summariseReport(rows);
  const categoryLabel = document.querySelector(`[data-report-category="${reportFilters.category}"]`)?.textContent || 'Tout';

  const lines = [
    ['Encaissé', formatMoney(summary.cashIn)],
    ['Décaissé', formatMoney(summary.cashOut)],
    ['Solde net', formatMoney(summary.net)],
    ['Ventes', `${summary.unitsSold} art. · ${formatMoney(summary.salesValue)}`],
    ['Achats', `${summary.unitsBought} art. · ${formatMoney(summary.purchaseValue)}`],
    ['Retours', `${summary.unitsReturned} art. · ${formatMoney(summary.returnValue)}`],
    ['Pertes', `${summary.unitsWasted} art. · ${formatMoney(summary.wasteValue)}`],
    ['Dépenses', formatMoney(summary.expenseValue)]
  ];

  return `
    <div class="invoice-document report-document">
      <p class="inv-legal-line">
        <strong>${escapeHtml(INVOICE_BUSINESS.legalName)}</strong>
        <span>${escapeHtml(INVOICE_BUSINESS.poBox)}</span>
        <span>TÉL. : ${escapeHtml(state.settings?.storePhone || INVOICE_BUSINESS.phone)}</span>
        <span>${escapeHtml(INVOICE_BUSINESS.city)} ${escapeHtml(INVOICE_BUSINESS.country)}</span>
      </p>

      <header class="report-print-head">
        <div>
          <p class="eyebrow">Rapport interne</p>
          <h2>Mouvements de la période</h2>
        </div>
        <div class="report-print-meta">
          <div><span>PÉRIODE</span><strong>${escapeHtml(reportPeriodLabel())}</strong></div>
          <div><span>CATÉGORIE</span><strong>${escapeHtml(categoryLabel)}</strong></div>
          <div><span>ÉDITÉ LE</span><strong>${new Date().toLocaleDateString('fr-FR')}</strong></div>
        </div>
      </header>

      <div class="report-print-summary">
        ${lines.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('')}
      </div>

      ${reportTable(rows)}

      <footer class="inv-strapline">
        <span class="inv-strapline-mark" aria-hidden="true"></span>
        <span>${escapeHtml(INVOICE_BUSINESS.strapline)}</span>
      </footer>
    </div>`;
}

// Hands the sheet to the browser's print dialogue, the same route the invoice
// takes; "Enregistrer au format PDF" in that dialogue is the export.
function exportReportPdf() {
  const sheet = document.getElementById('report-print-sheet');
  if (!sheet) return;

  sheet.innerHTML = buildReportSheet();
  sheet.classList.add('is-printing');

  // Torn down on afterprint rather than straight after print(), because print()
  // does not block everywhere. The timer is the fallback for the browsers that
  // never fire the event, so the sheet cannot be left on screen either way.
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    window.removeEventListener('afterprint', cleanup);
    sheet.classList.remove('is-printing');
    sheet.innerHTML = '';
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(cleanup, 3000);

  window.print();
}

function setupReportListeners() {
  const day = document.getElementById('report-day');
  if (day) {
    day.value = toDateInputValue(new Date());
    reportFilters.day = day.value;
    day.addEventListener('change', (event) => { reportFilters.day = event.target.value; renderReports(); });
  }
  document.getElementById('report-start')?.addEventListener('change', (event) => {
    reportFilters.start = event.target.value;
    renderReports();
  });
  document.getElementById('report-end')?.addEventListener('change', (event) => {
    reportFilters.end = event.target.value;
    renderReports();
  });
  document.querySelectorAll('[data-report-mode]').forEach((button) => {
    button.addEventListener('click', () => setReportMode(button.dataset.reportMode));
  });
  document.querySelectorAll('[data-report-category]').forEach((button) => {
    button.addEventListener('click', () => setReportCategory(button.dataset.reportCategory));
  });
  document.getElementById('export-report-btn')?.addEventListener('click', exportReportPdf);

  const customer = document.getElementById('report-customer');
  customer?.addEventListener('input', () => {
    // Typing over a chosen customer clears the selection, so the box never shows
    // one name while the table is filtered by another.
    if (reportFilters.customerId) {
      reportFilters.customerId = '';
      renderReports();
    }
    renderReportCustomerSuggestions();
  });
}

// --- Dépenses ---------------------------------------------------------------
// Expenses are a self-contained ledger. Nothing here reads sales, customers,
// debts or stock, and nothing outside here reads state.expenses, so the two
// sides can never affect each other's totals.

// 'Produits gaspillés' used to live here. Waste is a stock movement now -- the
// Perte mode of the register -- so it is no longer a money-only expense line.
const EXPENSE_TYPES = [
  'Salaires',
  'Réparation / Maintenance',
  'Amélioration / Mise à niveau',
  'Autre'
];

let editingExpenseId = null;
let viewingExpenseId = null;
let pendingDeleteExpenseId = null;

// Dates are stored as the YYYY-MM-DD the date input produces, so comparisons are
// plain string comparisons and no timezone can shift a day.
function toDateInputValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatExpenseDate(value) {
  if (!value) return '';
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('fr-FR');
}

function getExpenseById(expenseId) {
  return state.expenses.find((expense) => expense.id === expenseId) || null;
}

// The single source of truth for both the list and the total, so the summary can
// never disagree with the rows on screen.
// One modal for both create and edit: passing an id prefills it and makes the
// submit update that record instead of appending a new one.
function openExpenseEditor(expenseId) {
  const expense = expenseId ? getExpenseById(expenseId) : null;
  editingExpenseId = expense ? expense.id : null;

  document.getElementById('expense-form').reset();
  showMessage('expense-form-message', '', '');
  document.getElementById('expense-form-title').textContent = expense ? 'Modifier la dépense' : 'Nouvelle dépense';
  document.getElementById('expense-type').value = expense ? (expense.type || 'Autre') : EXPENSE_TYPES[0];
  document.getElementById('expense-amount').value = expense ? expense.amount : '';
  document.getElementById('expense-date').value = expense ? (expense.date || toDateInputValue(new Date())) : toDateInputValue(new Date());
  document.getElementById('expense-note').value = expense ? (expense.note || '') : '';

  closeExpenseDetails();
  document.getElementById('expense-editor-modal').classList.remove('hidden');
  document.getElementById('expense-amount').focus();
}

function closeExpenseEditor() {
  editingExpenseId = null;
  document.getElementById('expense-form').reset();
  showMessage('expense-form-message', '', '');
  document.getElementById('expense-editor-modal').classList.add('hidden');
}

async function handleExpenseSubmit(event) {
  event.preventDefault();
  const type = document.getElementById('expense-type').value;
  const amount = Number(document.getElementById('expense-amount').value);
  const date = document.getElementById('expense-date').value;
  const note = document.getElementById('expense-note').value.trim();

  if (!EXPENSE_TYPES.includes(type)) {
    showMessage('expense-form-message', 'Sélectionnez un type de dépense.', 'error');
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    showMessage('expense-form-message', 'Le montant doit être supérieur à 0.', 'error');
    return;
  }
  if (!date) {
    showMessage('expense-form-message', 'La date est obligatoire.', 'error');
    return;
  }

  const saved = editingExpenseId
    ? await mutate(`/expenses/${editingExpenseId}`, 'PUT', { type, amount, date, note })
    : await mutate('/expenses', 'POST', { type, amount, date, note });
  if (saved === null) return;
  closeExpenseEditor();
}

function openExpenseDetails(expenseId) {
  const expense = getExpenseById(expenseId);
  if (!expense) return;
  viewingExpenseId = expense.id;
  document.getElementById('expense-details-title').textContent = expense.type || 'Autre';
  document.getElementById('expense-details-body').innerHTML = `
    <div class="expense-detail-row"><span>Date</span><strong>${formatExpenseDate(expense.date)}</strong></div>
    <div class="expense-detail-row"><span>Type de dépense</span><strong>${expense.type || 'Autre'}</strong></div>
    <div class="expense-detail-row"><span>Montant</span><strong>${formatMoney(expense.amount)}</strong></div>
    <div class="expense-detail-row expense-detail-note"><span>Note</span><strong>${expense.note ? expense.note : '<span class="subtle">Aucune note</span>'}</strong></div>
  `;
  document.getElementById('expense-details-modal').classList.remove('hidden');
}

function closeExpenseDetails() {
  viewingExpenseId = null;
  document.getElementById('expense-details-modal').classList.add('hidden');
}

function openExpenseDeleteConfirmation(expenseId) {
  const expense = getExpenseById(expenseId);
  if (!expense) return;
  pendingDeleteExpenseId = expense.id;
  document.getElementById('expense-delete-text').textContent =
    `Voulez-vous vraiment supprimer cette dépense ? ${expense.type || 'Autre'} · ${formatMoney(expense.amount)} · ${formatExpenseDate(expense.date)}`;
  document.getElementById('expense-delete-modal').classList.remove('hidden');
}

function closeExpenseDeleteConfirmation() {
  pendingDeleteExpenseId = null;
  document.getElementById('expense-delete-modal').classList.add('hidden');
}

async function confirmExpenseDelete() {
  if (!pendingDeleteExpenseId) return;
  const expenseId = pendingDeleteExpenseId;
  const saved = await mutate(`/expenses/${expenseId}`, 'DELETE', null, () => {
    state.expenses = state.expenses.filter((expense) => expense.id !== expenseId);
  });
  if (saved === null) return;
  closeExpenseDeleteConfirmation();
  closeExpenseDetails();
}

function setupExpenseListeners() {
  document.getElementById('add-expense-btn').addEventListener('click', () => openExpenseEditor(null));
  document.getElementById('expense-form').addEventListener('submit', handleExpenseSubmit);
  document.getElementById('cancel-expense-edit').addEventListener('click', closeExpenseEditor);
  document.getElementById('close-expense-editor').addEventListener('click', closeExpenseEditor);
  document.getElementById('expense-editor-modal').addEventListener('click', (event) => {
    if (event.target.id === 'expense-editor-modal') closeExpenseEditor();
  });

  document.getElementById('close-expense-details').addEventListener('click', closeExpenseDetails);
  document.getElementById('edit-expense-from-details').addEventListener('click', () => openExpenseEditor(viewingExpenseId));
  document.getElementById('expense-details-modal').addEventListener('click', (event) => {
    if (event.target.id === 'expense-details-modal') closeExpenseDetails();
  });

  document.getElementById('cancel-expense-delete').addEventListener('click', closeExpenseDeleteConfirmation);
  document.getElementById('confirm-expense-delete').addEventListener('click', confirmExpenseDelete);
  document.getElementById('expense-delete-modal').addEventListener('click', (event) => {
    if (event.target.id === 'expense-delete-modal') closeExpenseDeleteConfirmation();
  });

}

function renderAll() {
  applyPosMode();
  renderPosProducts();
  renderCart();
  renderCustomerSelects();
  renderProductsList();
  renderClientRoute();
  renderPurchases();
  renderReports();
  if (selectedCustomerProfile) {
    showCustomerProfile(selectedCustomerProfile.id);
  }
}

function setupEventListeners() {
  document.getElementById('pos-product-search').addEventListener('input', renderPosProducts);
  document.getElementById('pos-customer-search').addEventListener('input', () => {
    selectedPosCustomerId = null;
    renderPosCustomerField();
  });
  document.getElementById('product-search').addEventListener('input', renderProductsList);
  document.getElementById('payment-method-select').addEventListener('change', updatePosPaymentFields);
  document.getElementById('sale-discount-percent').addEventListener('input', (event) => {
    saleDiscountPercent = Math.min(100, Math.max(0, Number(event.target.value) || 0));
    event.target.value = saleDiscountPercent;
    renderCart();
  });
  document.querySelectorAll('[data-pos-mode]').forEach((button) => {
    button.addEventListener('click', () => setPosMode(button.dataset.posMode));
  });
  document.getElementById('complete-sale-btn').addEventListener('click', completeSale);
  document.getElementById('cancel-sale-btn').addEventListener('click', closeSaleConfirmation);
  document.getElementById('confirm-sale-btn').addEventListener('click', confirmSale);
  document.getElementById('create-customer-from-pos').addEventListener('click', addCustomerFromPos);
  document.getElementById('toggle-new-customer-btn').addEventListener('click', toggleNewCustomerFields);
  document.getElementById('product-form').addEventListener('submit', handleProductSubmit);
  document.getElementById('toggle-add-stock-btn').addEventListener('click', toggleAddStockRow);
  document.getElementById('cancel-add-stock-btn').addEventListener('click', cancelAddStock);
  document.getElementById('add-product-stock-btn').addEventListener('click', addStockToProduct);
  document.getElementById('cancel-payment-btn').addEventListener('click', closePaymentConfirmation);
  document.getElementById('confirm-payment-btn').addEventListener('click', confirmPaymentRecord);
  document.getElementById('close-receipt-btn').addEventListener('click', closeReceipt);
  document.getElementById('print-receipt-btn').addEventListener('click', () => window.print());
  document.getElementById('cancel-delete-sale-btn').addEventListener('click', closeDeleteSaleConfirmation);
  document.getElementById('confirm-delete-sale-btn').addEventListener('click', confirmDeleteSale);
  document.getElementById('cancel-product-edit').addEventListener('click', cancelProductEdit);
  document.getElementById('close-product-editor').addEventListener('click', cancelProductEdit);
  document.getElementById('add-product-btn').addEventListener('click', focusProductEditor);
  document.getElementById('product-editor-modal').addEventListener('click', (event) => {
    if (event.target.id === 'product-editor-modal') cancelProductEdit();
  });
  // The client form lives in index.html rather than the clients template, so it
  // survives the renderAll() that rebuilds #client-route-view, and it only needs
  // wiring once. Same open/close contract as the product editor above.
  document.getElementById('customer-form').addEventListener('submit', handleCustomerSubmit);
  document.getElementById('cancel-customer-edit').addEventListener('click', cancelCustomerEdit);
  document.getElementById('close-customer-editor').addEventListener('click', cancelCustomerEdit);
  document.getElementById('customer-editor-modal').addEventListener('click', (event) => {
    if (event.target.id === 'customer-editor-modal') cancelCustomerEdit();
  });
  // Closes the report's customer typeahead when the click lands elsewhere.
  document.addEventListener('click', (event) => {
    const list = document.getElementById('report-customer-suggestions');
    const input = document.getElementById('report-customer');
    if (!list || list.classList.contains('hidden')) return;
    if (!list.contains(event.target) && event.target !== input) list.classList.add('hidden');
  });
  setupExpenseListeners();
  setupPurchaseListeners();
  setupReportListeners();
  renderNav();
}

window.addEventListener('popstate', () => {
  if (isCustomerPath()) {
    setActiveTab('customers');
    renderClientRoute();
  }
});

document.getElementById('login-form')?.addEventListener('submit', handleLogin);
document.getElementById('logout-btn')?.addEventListener('click', handleLogout);

setupEventListeners();
renderAll();
setAppLoading(true);
if (isCustomerPath()) {
  setActiveTab('customers');
  renderClientRoute();
}
hydrate();
