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
let incomeRange = { mode: 'today' };
// 'sale' keeps the original checkout untouched; 'return' records an independent
// Retour transaction that puts stock back.
let posMode = 'sale';

// Writes are serialised: a save requested while one is in flight is coalesced into a
// single follow-up so the last state always reaches the server exactly once.
let saveInFlight = false;
let savePending = false;

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

function saveState() {
  normalizeFinancials();
  return persistStateToServer();
}

// Resolves true only when the server confirmed the write. Callers must not report
// success to the user before this resolves.
async function persistStateToServer() {
  if (saveInFlight) {
    savePending = true;
    return false;
  }

  saveInFlight = true;
  setSaveStatus('saving');

  try {
    const response = await fetch(`${API_BASE}/api/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ state })
    });

    if (response.status === 401) {
      showLogin('Session expirée. Reconnectez-vous pour enregistrer.');
      setSaveStatus('error', 'Non enregistré : session expirée.');
      return false;
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setSaveStatus('error', payload.error || `Non enregistré (erreur ${response.status}).`);
      return false;
    }

    setSaveStatus('saved');
    return true;
  } catch (error) {
    setSaveStatus('error', 'Non enregistré : connexion au serveur impossible.');
    return false;
  } finally {
    saveInFlight = false;
    if (savePending) {
      savePending = false;
      persistStateToServer();
    }
  }
}

async function syncStateFromServer() {
  try {
    const response = await fetch(`${API_BASE}/api/state`, { credentials: 'same-origin' });

    if (response.status === 401) {
      showLogin();
      return;
    }
    if (response.status === 404) {
      hideLogin();
      await persistStateToServer();
      setAppLoading(false);
      return;
    }
    if (!response.ok) {
      setAppLoading(false);
      setSaveStatus('error', 'Chargement des données impossible.');
      return;
    }

    const payload = await response.json();
    if (!payload.state) {
      setAppLoading(false);
      return;
    }

    hideLogin();
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, payload.state);
    ensureStateShape();
    normalizeFinancials();
    renderAll();
    setAppLoading(false);
  } catch (error) {
    setAppLoading(false);
    setSaveStatus('error', 'Connexion au serveur impossible.');
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
    await syncStateFromServer();
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

function getProductById(productId) {
  return state.products.find((product) => product.id === productId) || null;
}

// Transactions recorded before returns existed carry no type, so anything that
// is not explicitly a return is a sale.
function getTransactionType(transaction) {
  return transaction?.type === 'return' ? 'return' : 'sale';
}

function isReturn(transaction) {
  return getTransactionType(transaction) === 'return';
}

// A saved blob only contains the keys that existed when it was written, and
// syncStateFromServer drops every key before assigning it, so anything newer
// than the stored state would otherwise be undefined.
function ensureStateShape() {
  if (!state.settings || typeof state.settings !== 'object') state.settings = structuredClone(emptyState.settings);
  if (!Array.isArray(state.products)) state.products = [];
  if (!Array.isArray(state.customers)) state.customers = [];
  if (!Array.isArray(state.sales)) state.sales = [];
  if (!Array.isArray(state.expenses)) state.expenses = [];

  // Cost price is no longer part of a product; shed it from legacy records.
  state.products.forEach((product) => { delete product.costPrice; });
  state.sales.forEach((transaction) => { transaction.type = getTransactionType(transaction); });
  state.expenses.forEach((expense) => { expense.amount = Number(expense.amount) || 0; });
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
    .filter((sale) => sale.customerId === customerId && !isReturn(sale) && sale.paymentMethod === 'debt')
    .filter((sale) => !outstandingOnly || getInvoiceRemainingAmount(sale) > 0)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function normalizeFinancials() {
  ensureStateShape();
  state.customers.forEach((customer) => {
    customer.debtHistory = Array.isArray(customer.debtHistory) ? customer.debtHistory : [];
    const invoices = getCustomerCreditInvoices(customer.id);
    const legacyPayments = customer.debtHistory.filter((entry) => entry.type === 'payment' && !entry.saleId && Number(entry.amount) > 0);

    legacyPayments.forEach((payment) => {
      let remainingPayment = Number(payment.amount);
      invoices.slice().reverse().forEach((invoice) => {
        const available = getInvoiceRemainingAmount(invoice);
        const applied = Math.min(available, remainingPayment);
        if (!applied) return;
        invoice.amountPaid = getInvoicePaidAmount(invoice) + applied;
        remainingPayment -= applied;
        if (!payment.saleId) payment.saleId = invoice.id;
      });
    });

    invoices.forEach((invoice) => {
      invoice.status = getInvoiceStatus(invoice);
    });

    const cashPaid = state.sales
      .filter((sale) => sale.customerId === customer.id && !isReturn(sale) && sale.paymentMethod === 'cash')
      .reduce((sum, sale) => sum + Number(sale.totalAmount || 0), 0);
    // Returns are standalone records: they never move a customer's purchases,
    // payments or balance.
    customer.totalPurchased = state.sales
      .filter((sale) => sale.customerId === customer.id && !isReturn(sale))
      .reduce((sum, sale) => sum + Number(sale.totalAmount || 0), 0);
    customer.totalPaid = cashPaid + invoices.reduce((sum, sale) => sum + getInvoicePaidAmount(sale), 0);
    customer.balance = invoices.reduce((sum, sale) => sum + getInvoiceRemainingAmount(sale), 0);
  });
}

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

function getStartOfWeek(date) {
  const start = getStartOfDay(date);
  const day = start.getDay();
  start.setDate(start.getDate() - day);
  return start;
}

// One date range drives every dashboard figure: the recettes total, the sales
// count and the recent-sales card all read the labels returned here.
function getIncomeRangeBounds() {
  const now = new Date();
  if (incomeRange.mode === 'week') {
    return {
      start: getStartOfWeek(now),
      end: now,
      label: 'Recettes de la semaine',
      countLabel: 'Ventes de la semaine',
      listLabel: 'Ventes de la semaine',
      emptyLabel: 'Aucune vente cette semaine.'
    };
  }
  if (incomeRange.mode === 'custom' && incomeRange.start && incomeRange.end) {
    const start = getStartOfDay(new Date(incomeRange.start));
    const end = new Date(incomeRange.end);
    end.setHours(23, 59, 59, 999);
    const period = start.getTime() === getStartOfDay(end).getTime()
      ? start.toLocaleDateString('fr-FR')
      : `${start.toLocaleDateString('fr-FR')} - ${end.toLocaleDateString('fr-FR')}`;
    return {
      start,
      end,
      label: `${period} - recettes`,
      countLabel: `${period} - ventes`,
      listLabel: `Ventes · ${period}`,
      emptyLabel: 'Aucune vente sur cette période.'
    };
  }
  return {
    start: getStartOfDay(now),
    end: now,
    label: 'Recettes du jour',
    countLabel: 'Ventes du jour',
    listLabel: 'Ventes du jour',
    emptyLabel: 'Aucune vente aujourd’hui.'
  };
}

function getCartItemKey(productId) {
  return productId;
}

function getCartTotal() {
  return cart.reduce((total, item) => total + item.quantity * item.unitPrice, 0);
}

function getOutstandingDebtList() {
  normalizeFinancials();
  return state.customers
    .filter((customer) => customer.balance > 0)
    .sort((a, b) => b.balance - a.balance);
}

function renderNav() {
  const buttons = document.querySelectorAll('.nav-btn');
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.tab;
      if (target === 'debts') {
        navigateDebt('/debts');
        return;
      }
      if (target === 'customers') {
        navigateClient('/clients');
        return;
      }
      document.querySelectorAll('.nav-btn').forEach((nav) => nav.classList.toggle('active', nav === button));
      document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === target));
    });
  });
}

function renderDashboard() {
  // Balances are derived, so recompute before reading them into Total dû.
  normalizeFinancials();

  const lowStock = state.products.filter((product) => product.stock <= getLowStockThreshold(product)).map((product) => ({ ...product, productName: product.name }));
  // Each customer balance is the sum of what is still unpaid on their credit
  // invoices, so settled invoices drop out on their own.
  const debtTotal = state.customers.reduce((sum, customer) => sum + Number(customer.balance || 0), 0);

  const { start, end, label, countLabel, listLabel, emptyLabel } = getIncomeRangeBounds();
  // Returns are a separate transaction type: they are neither revenue nor a checkout.
  const rangeSales = state.sales.filter((sale) => {
    if (isReturn(sale)) return false;
    const saleDate = new Date(sale.createdAt);
    return saleDate >= start && saleDate <= end;
  });
  const rangeIncome = rangeSales.reduce((sum, sale) => sum + Number(sale.totalAmount || 0), 0);
  const recentSales = rangeSales.slice(-5).reverse();

  document.getElementById('income-stat-label').textContent = label;
  document.getElementById('income-stat-value').textContent = formatMoney(rangeIncome);
  document.getElementById('stat-amount-owed').textContent = formatMoney(debtTotal);
  document.getElementById('stat-low-stock').textContent = lowStock.length;
  document.getElementById('sales-count-label').textContent = countLabel;
  document.getElementById('stat-checkouts-today').textContent = rangeSales.length;
  document.getElementById('recent-sales-title').textContent = listLabel;

  const recentHtml = recentSales.length
    ? recentSales.map((sale) => {
        const customer = getCustomerById(sale.customerId);
        return `
          <div class="list-item">
            <div>
              <strong>${customer ? customer.name : 'Client de passage'}</strong>
              <small>${new Date(sale.createdAt).toLocaleString('fr-FR')}</small>
            </div>
            <div class="list-meta">
              <strong>${formatMoney(sale.totalAmount)}</strong>
              <span class="mini-pill ${sale.paymentMethod === 'debt' ? 'warning' : 'success'}">${sale.paymentMethod === 'debt' ? (sale.paymentType === 'partial' ? getInvoiceStatus(sale) : 'Crédit') : 'Espèces'}</span>
            </div>
          </div>
        `;
      }).join('')
    : `<p class="empty-state">${emptyLabel}</p>`;

  document.getElementById('recent-sales-list').innerHTML = recentHtml;

  const lowStockHtml = lowStock.length
    ? lowStock.map((product) => `
        <div class="list-item compact">
          <div>
            <strong>${product.productName}</strong>
            <small>${product.stock} restant(s) · seuil ${getLowStockThreshold(product)}</small>
          </div>
          <span class="mini-dot ${product.stock === 0 ? 'danger' : 'warning'}">${product.stock === 0 ? 'Rupture' : 'Faible'}</span>
        </div>
      `).join('')
    : '<p class="empty-state">Le stock est suffisant pour tous les produits.</p>';

  document.getElementById('low-stock-list').innerHTML = lowStockHtml;
}

function toggleIncomeRangePanel() {
  document.getElementById('income-range-panel').classList.toggle('hidden');
}

function setIncomeRangeMode(mode) {
  document.querySelectorAll('.range-option').forEach((button) => button.classList.toggle('active', button.dataset.range === mode));
  document.getElementById('income-custom-range').classList.toggle('hidden', mode !== 'custom');
  if (mode !== 'custom') {
    incomeRange = { mode };
    document.getElementById('income-range-panel').classList.add('hidden');
    renderDashboard();
  }
}

function applyCustomIncomeRange() {
  const start = document.getElementById('income-range-start').value;
  const end = document.getElementById('income-range-end').value;
  if (!start || !end) return;
  incomeRange = { mode: 'custom', start, end };
  document.getElementById('income-range-panel').classList.add('hidden');
  renderDashboard();
}

function isReturnMode() {
  return posMode === 'return';
}

// Switches the register between Vente and Retour. The cart, catalogue and
// customer picker are shared; only the constraints and wording change.
function setPosMode(mode) {
  const nextMode = mode === 'return' ? 'return' : 'sale';
  if (nextMode === posMode) return;
  posMode = nextMode;

  // A return may hold more units than are in stock; a sale may not. Clamp on the
  // way back so a return-sized cart can never oversell.
  let adjusted = false;
  if (!isReturnMode()) {
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
      ? 'Mode Vente : les quantités ont été ajustées au stock disponible.'
      : isReturnMode() ? 'Mode Retour actif. Le stock sera réapprovisionné.' : 'Mode Vente actif.',
    adjusted ? 'error' : 'info'
  );
}

// Every piece of return-mode wording and styling lives here so the two modes
// can never drift apart.
function applyPosMode() {
  const returning = isReturnMode();
  document.getElementById('cart-area')?.classList.toggle('is-return-mode', returning);
  document.getElementById('pos')?.classList.toggle('is-return-mode', returning);
  document.querySelectorAll('[data-pos-mode]').forEach((button) => {
    const active = button.dataset.posMode === posMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  const text = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  text('pos-page-title', returning ? 'Nouveau retour' : 'Nouvelle vente');
  text('pos-page-subtitle', returning
    ? 'Choisissez les produits retournés, vérifiez les quantités et validez le retour.'
    : 'Choisissez les produits, vérifiez la commande et encaissez.');
  text('pos-status-pill', returning ? 'Mode retour' : 'Prêt à vendre');
  text('cart-kicker', returning ? 'Retour' : 'Encaissement');
  text('cart-title', returning ? 'Retour en cours' : 'Vente en cours');
  text('total-label', returning ? 'Total du retour' : 'Total');
  text('complete-sale-btn', returning ? 'Finaliser le retour' : 'Finaliser la vente');
  text('pos-customer-section-title', returning ? 'Client (facultatif)' : 'Client et paiement');

  document.getElementById('pos-payment-fields')?.classList.toggle('hidden', returning);
  document.getElementById('pos-return-note')?.classList.toggle('hidden', !returning);
  if (returning) document.getElementById('partial-payment-field')?.classList.add('hidden');
}

function renderPosProducts() {
  const searchValue = document.getElementById('pos-product-search')?.value?.toLowerCase() || '';
  const list = state.products.filter((product) => product.name.toLowerCase().includes(searchValue));

  const container = document.getElementById('pos-product-list');
  // A returned product can be out of stock, so return mode never disables Ajouter.
  const returning = isReturnMode();
  container.innerHTML = list.map((product) => `
    <div class="catalog-item">
      <div class="meta">
        <strong>${product.name}</strong>
        <small>${getAvailableStock(product)} en stock · ${formatMoney(product.sellingPrice)}</small>
      </div>
      <button class="add-btn primary-btn" data-add-product="${product.id}" ${!returning && getAvailableStock(product) < 1 ? 'disabled' : ''}>Ajouter</button>
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
  if (!isReturnMode() && getAvailableStock(product) <= (existing?.quantity || 0)) return;

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

function renderCart() {
  const cartContainer = document.getElementById('cart-items');
  const cartCount = document.getElementById('cart-count');
  const totalItems = cart.reduce((total, item) => total + item.quantity, 0);
  cartCount.textContent = `${totalItems} article${totalItems === 1 ? '' : 's'}`;
  if (!cart.length) {
    cartContainer.innerHTML = isReturnMode()
      ? '<div class="empty-cart"><span class="empty-cart-icon">&#8630;</span><strong>Votre retour est vide</strong><p>Ajoutez les produits retournés pour commencer.</p></div>'
      : '<div class="empty-cart"><span class="empty-cart-icon">+</span><strong>Votre vente est vide</strong><p>Ajoutez des produits au catalogue pour commencer.</p></div>';
    document.getElementById('subtotal-value').textContent = formatMoney(0);
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
      item.quantity = isReturnMode() ? requested : Math.min(requested, getAvailableStock(product));
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
  document.getElementById('subtotal-value').textContent = formatMoney(subtotal);
  document.getElementById('total-value').textContent = formatMoney(subtotal);
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
  if (summary) summary.textContent = `${productList.length} produit${productList.length === 1 ? '' : 's'} · ${totalUnits} unité(s) en stock`;

  listEl.innerHTML = productList.length
    ? productList.map((product) => {
        const stock = product.stock;
        const threshold = getLowStockThreshold(product);
        const stockState = stock === 0 ? 'out' : stock <= threshold ? 'low' : 'healthy';
        return `
          <article class="product-row">
            <div class="product-thumb" aria-hidden="true">${product.name.slice(0, 1).toUpperCase()}</div>
            <div class="product-row-info">
              <div class="product-row-title">
                <h4>${product.name}</h4>
              </div>
              ${product.description ? `<p class="product-row-description">${product.description}</p>` : ''}
            </div>
            <div class="product-row-metric">
              <span>Stock</span>
              <strong>${stock}</strong>
            </div>
            <div class="product-row-metric">
              <span>Prix</span>
              <strong>${formatMoney(product.sellingPrice)}</strong>
            </div>
            <span class="stock-status ${stockState}">${stockState === 'out' ? 'Rupture de stock' : stockState === 'low' ? 'Stock faible' : 'En stock'}</span>
            <div class="product-row-actions">
              <button class="secondary-btn compact-btn" data-edit-product="${product.id}">Modifier</button>
              <button class="link-btn danger-link" data-delete-product="${product.id}">Supprimer</button>
            </div>
          </article>
        `;
      }).join('')
    : `<div class="products-empty-state"><div class="empty-state-icon">+</div><h4>Aucun produit trouvé</h4><p>Essayez une autre recherche ou ajoutez un produit au catalogue.</p><button type="button" class="secondary-btn" data-empty-add-product>Ajouter un produit</button></div>`;

  listEl.querySelectorAll('[data-edit-product]').forEach((button) => {
    button.addEventListener('click', () => beginEditProduct(button.dataset.editProduct));
  });
  listEl.querySelectorAll('[data-delete-product]').forEach((button) => {
    button.addEventListener('click', () => deleteProduct(button.dataset.deleteProduct));
  });
  listEl.querySelector('[data-empty-add-product]')?.addEventListener('click', focusProductEditor);
}

function deleteProduct(productId) {
  const product = getProductById(productId);
  if (!product) return;
  const confirmed = window.confirm(`Supprimer ${product.name} ? Le produit sera retiré du catalogue, mais l’historique des ventes sera conservé.`);
  if (!confirmed) return;

  state.products = state.products.filter((entry) => entry.id !== productId);
  cart = cart.filter((item) => item.productId !== productId);
  if (editingProductId === productId) cancelProductEdit();
  saveState();
  renderAll();
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

function addStockToProduct() {
  if (!editingProductId) return;
  const amount = Number(document.getElementById('product-stock-addition').value);
  const product = getProductById(editingProductId);
  if (!product || !amount || amount < 1) return;
  product.stock += amount;
  document.getElementById('product-current-stock').textContent = product.stock;
  document.getElementById('product-stock-addition').value = '';
  document.getElementById('product-stock-add-row').classList.add('hidden');
  saveState();
  renderProductsList();
  renderDashboard();
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
  const salesForCustomer = customerHistoryDateFilter
    ? allSalesForCustomer.filter((sale) => new Date(sale.createdAt).toISOString().slice(0, 10) === customerHistoryDateFilter)
    : allSalesForCustomer;

  const selectedSale = selectedCustomerInvoiceId
    ? salesForCustomer.find((sale) => sale.id === selectedCustomerInvoiceId) || null
    : null;

  const purchaseHistoryHtml = salesForCustomer.length
    ? salesForCustomer.map((sale) => {
        const { label, settledAt } = getInvoiceHistoryLabel(customer, sale);
        return `
        <button class="purchase-row ${selectedSale && selectedSale.id === sale.id ? 'active' : ''}" data-open-sale="${sale.id}">
          <div class="purchase-row-info">
            <strong>Facture n°${sale.id.slice(-4)}</strong>
            <small>${new Date(sale.createdAt).toLocaleString('fr-FR')} · ${sale.items.length} article${sale.items.length === 1 ? '' : 's'}</small>
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
          <div><span>Sous-total</span><strong>${formatMoney(selectedSale.totalAmount)}</strong></div>
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
        <p>${allSalesForCustomer.length} achat${allSalesForCustomer.length === 1 ? '' : 's'}</p>
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

function navigateClient(path) {
  window.history.pushState({}, '', path);
  setActiveTab('customers');
  renderClientRoute();
}

function getClientRoute() {
  const parts = window.location.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts[0] !== 'clients') return { page: 'customers' };
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

function renderClientsPage(container) {
  container.innerHTML = `
    <div class="ledger-page">
      <div class="ledger-page-header"><div><p class="section-kicker">Clients</p><h3>Liste des clients</h3></div><button type="button" class="primary-btn compact-btn" data-add-client>+ Ajouter un client</button></div>
      <label class="ledger-search"><span>Rechercher un client ou un téléphone</span><input id="customer-search" type="search" placeholder="Rechercher un client ou un téléphone" /></label>
      <div id="customer-list" class="ledger-table ledger-customer-list" translate="no"></div>
    </div>
  `;
  const search = container.querySelector('#customer-search');
  search.addEventListener('input', () => renderClientRows(container.querySelector('#customer-list'), search.value));
  container.querySelector('[data-add-client]').addEventListener('click', openCustomerEditor);
  renderClientRows(container.querySelector('#customer-list'), '');
}

function renderClientRows(listEl, searchValue) {
  const query = searchValue.toLowerCase().trim();
  const clients = state.customers.filter((customer) => `${customer.name} ${customer.phone}`.toLowerCase().includes(query));
  listEl.innerHTML = clients.length ? clients.map((customer) => `
    <button type="button" class="ledger-row customer-ledger-row" data-client-id="${customer.id}">
      <span class="ledger-primary"><strong>${customer.name}</strong><small>${customer.phone}</small></span>
      <span class="ledger-money ${Number(customer.balance) > 0 ? "" : "ledger-money-settled"}"><strong>${formatMoney(customer.balance)}</strong><small>Total dû</small></span>
      <span class="ledger-count"><strong>${getCustomerCreditInvoices(customer.id, true).length}</strong><small>facture${getCustomerCreditInvoices(customer.id, true).length === 1 ? '' : 's'} impayée(s)</small></span>
      <span class="ledger-arrow">›</span>
    </button>
  `).join('') : '<p class="empty-state">Aucun client trouvé.</p>';
  listEl.querySelectorAll('[data-client-id]').forEach((button) => button.addEventListener('click', () => navigateClient(`/clients/${encodeURIComponent(button.dataset.clientId)}`)));
}

function renderClientProfilePage(container, customer) {
  const invoices = [...state.sales.filter((sale) => sale.customerId === customer.id)].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  container.innerHTML = `
    <div class="ledger-page">
      <div class="ledger-page-header"><button type="button" class="ledger-back-btn" data-client-back>← Clients</button></div>
      <div class="ledger-entity-header"><div><p class="section-kicker">Profil client</p><h3>${customer.name}</h3><span class="subtle">${customer.phone}</span></div><div class="ledger-entity-stats"><div><span>Total dû</span><strong>${formatMoney(customer.balance)}</strong></div><div><span>Total des achats</span><strong>${formatMoney(customer.totalPurchased)}</strong></div><div><span>Total payé</span><strong>${formatMoney(customer.totalPaid)}</strong></div></div></div>
      <div class="ledger-section-heading"><h4>Historique des transactions</h4><span>${invoices.length} transaction${invoices.length === 1 ? '' : 's'}</span></div>
      <div class="ledger-table ledger-invoice-list">
        ${invoices.length ? invoices.map((invoice) => isReturn(invoice)
          // A return has no paid/remaining figures, so it gets its own row shape.
          ? `<button type="button" class="ledger-row invoice-ledger-row ledger-return-row" data-client-invoice-id="${invoice.id}"><span><strong>Retour n°${invoice.id.slice(-4)}</strong><small>${new Date(invoice.createdAt).toLocaleDateString('fr-FR')}</small></span><span><strong>${formatMoney(invoice.totalAmount)}</strong><small>Total du retour</small></span><span><strong>${invoice.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)}</strong><small>Article(s)</small></span><span class="ledger-remaining"><strong>&mdash;</strong><small>Reste à payer</small></span><span><b class="ledger-status ledger-status-return">Retour</b></span><span class="ledger-arrow">›</span></button>`
          : `<button type="button" class="ledger-row invoice-ledger-row" data-client-invoice-id="${invoice.id}"><span><strong>Facture n°${invoice.id.slice(-4)}</strong><small>${new Date(invoice.createdAt).toLocaleDateString('fr-FR')}</small></span><span><strong>${formatMoney(invoice.totalAmount)}</strong><small>Total</small></span><span><strong>${formatMoney(getInvoicePaidAmount(invoice))}</strong><small>Payé</small></span><span class="ledger-remaining"><strong>${formatMoney(getInvoiceRemainingAmount(invoice))}</strong><small>Reste à payer</small></span><span><b class="ledger-status ${getInvoiceRemainingAmount(invoice) <= 0 ? 'ledger-status-paid' : ''}">${getInvoiceStatus(invoice)}</b></span><span class="ledger-arrow">›</span></button>`
        ).join('') : '<p class="empty-state">Aucune transaction pour ce client.</p>'}
      </div>
    </div>
  `;
  container.querySelector('[data-client-back]')?.addEventListener('click', () => navigateClient('/clients'));
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
      <div class="ledger-financial-summary"><div><span>Total de la facture</span><strong>${formatMoney(invoice.totalAmount)}</strong></div><div><span>Total payé</span><strong>${formatMoney(getInvoicePaidAmount(invoice))}</strong></div><div><span>Reste à payer</span><strong>${formatMoney(getInvoiceRemainingAmount(invoice))}</strong></div></div>
      <div class="ledger-payment-history"><h4>Historique des paiements</h4>${payments.length ? payments.map((payment) => `<div><span>${new Date(payment.date).toLocaleString('fr-FR')}</span><strong>${formatMoney(payment.amount)}</strong></div>`).join('') : '<p class="empty-state">Aucun paiement enregistré pour cette facture.</p>'}</div>
      <p class="ledger-view-only-note">Consultation uniquement. Les paiements se gèrent depuis la section Dettes clients.</p>
    </div>
  `;
  container.querySelector('[data-client-back]')?.addEventListener('click', () => navigateClient(`/clients/${encodeURIComponent(customer.id)}`));
}

function navigateDebt(path) {
  window.history.pushState({}, '', path);
  setActiveTab('debts');
  renderDebtRoute();
}

function getDebtRoute() {
  const parts = window.location.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts[0] !== 'debts') return { page: 'customers' };
  if (parts.length === 1) return { page: 'customers' };
  if (parts.length === 3 && parts[2] === 'invoices') return { page: 'customer', customerId: parts[1] };
  if (parts.length >= 4 && parts[2] === 'invoices') return { page: 'invoice', customerId: parts[1], invoiceId: parts[3] };
  return { page: 'customer', customerId: parts[1] };
}

function renderDebtRoute() {
  const container = document.getElementById('debt-route-view');
  if (!container) return;
  const route = getDebtRoute();
  if (route.page === 'customers') return renderDebtCustomersPage(container);
  const customer = getCustomerById(route.customerId);
  if (!customer) return navigateDebt('/debts');
  if (route.page === 'invoice') return renderDebtInvoicePage(container, customer, route.invoiceId);
  renderDebtCustomerPage(container, customer);
}

function renderDebtCustomersPage(container) {
  container.innerHTML = `
    <div class="ledger-page ledger-customers-page">
      <div class="ledger-page-header"><div><p class="section-kicker">Clients</p><h3>Clients débiteurs</h3></div><span class="subtle">${getOutstandingDebtList().length} client${getOutstandingDebtList().length === 1 ? '' : 's'}</span></div>
      <label class="ledger-search"><span>Rechercher un client ou un téléphone</span><input id="debt-customer-search" type="search" placeholder="Rechercher un client ou un téléphone" /></label>
      <div id="debt-list" class="ledger-table ledger-customer-list" translate="no"></div>
    </div>
  `;
  const search = container.querySelector('#debt-customer-search');
  search.addEventListener('input', () => renderDebtCustomerRows(container.querySelector('#debt-list'), search.value));
  renderDebtCustomerRows(container.querySelector('#debt-list'), '');
}

function renderDebtCustomerRows(listEl, searchValue) {
  const query = searchValue.toLowerCase().trim();
  const customers = getOutstandingDebtList().filter((customer) => `${customer.name} ${customer.phone}`.toLowerCase().includes(query));
  listEl.innerHTML = customers.length ? customers.map((customer) => `
    <button type="button" class="ledger-row customer-ledger-row" data-customer-id="${customer.id}">
      <span class="ledger-primary"><strong>${customer.name}</strong><small>${customer.phone}</small></span>
      <span class="ledger-money ${Number(customer.balance) > 0 ? "" : "ledger-money-settled"}"><strong>${formatMoney(customer.balance)}</strong><small>Total dû</small></span>
      <span class="ledger-count"><strong>${getCustomerCreditInvoices(customer.id, true).length}</strong><small>facture${getCustomerCreditInvoices(customer.id, true).length === 1 ? '' : 's'} impayée(s)</small></span>
      <span class="ledger-arrow">›</span>
    </button>
  `).join('') : '<p class="empty-state">Aucun client avec une dette restante.</p>';
  listEl.querySelectorAll('[data-customer-id]').forEach((button) => button.addEventListener('click', () => navigateDebt(`/debts/${encodeURIComponent(button.dataset.customerId)}`)));
}

function renderDebtCustomerPage(container, customer) {
  const invoices = getCustomerCreditInvoices(customer.id, true);
  container.innerHTML = `
    <div class="ledger-page">
      <div class="ledger-page-header"><button type="button" class="ledger-back-btn" data-debt-back>← Dettes clients</button></div>
      <div class="ledger-entity-header"><div><p class="section-kicker">Dette client</p><h3>${customer.name}</h3><span class="subtle">${customer.phone}</span></div><div class="ledger-entity-stats"><div><span>Total dû</span><strong>${formatMoney(customer.balance)}</strong></div><div><span>Factures impayées</span><strong>${invoices.length}</strong></div></div></div>
      <div class="ledger-section-heading"><h4>Factures impayées</h4><span>${invoices.length} facture${invoices.length === 1 ? '' : 's'}</span></div>
      <div class="ledger-table ledger-invoice-list">
        ${invoices.length ? invoices.map((invoice) => `
          <button type="button" class="ledger-row invoice-ledger-row" data-invoice-id="${invoice.id}">
            <span><strong>Facture n°${invoice.id.slice(-4)}</strong><small>${new Date(invoice.createdAt).toLocaleDateString('fr-FR')}</small></span>
            <span><strong>${formatMoney(invoice.totalAmount)}</strong><small>Total</small></span>
            <span><strong>${formatMoney(getInvoicePaidAmount(invoice))}</strong><small>Payé</small></span>
            <span class="ledger-remaining"><strong>${formatMoney(getInvoiceRemainingAmount(invoice))}</strong><small>Reste à payer</small></span>
            <span><b class="ledger-status">${getInvoiceStatus(invoice)}</b></span><span class="ledger-arrow">›</span>
          </button>
        `).join('') : '<p class="empty-state">Ce client n’a aucune facture impayée.</p>'}
      </div>
    </div>
  `;
  container.querySelector('[data-debt-back]')?.addEventListener('click', () => navigateDebt('/debts'));
  container.querySelectorAll('[data-invoice-id]').forEach((button) => button.addEventListener('click', () => navigateDebt(`/debts/${encodeURIComponent(customer.id)}/invoices/${encodeURIComponent(button.dataset.invoiceId)}`)));
}

function renderDebtInvoicePage(container, customer, invoiceId) {
  const invoice = state.sales.find((sale) => sale.id === invoiceId && sale.customerId === customer.id);
  if (!invoice) return navigateDebt(`/debts/${encodeURIComponent(customer.id)}`);
  const payments = customer.debtHistory.filter((entry) => entry.type === 'payment' && entry.saleId === invoice.id).sort((a, b) => new Date(b.date) - new Date(a.date));
  container.innerHTML = `
    <div class="ledger-page ledger-invoice-page">
      <div class="ledger-page-header"><button type="button" class="ledger-back-btn" data-debt-back>← Factures impayées de ${customer.name}</button></div>
      <div class="ledger-entity-header"><div><p class="section-kicker">Détails de la facture</p><h3>Facture n°${invoice.id.slice(-4)}</h3><span class="subtle">${new Date(invoice.createdAt).toLocaleString('fr-FR')} · ${customer.name}</span></div><b class="ledger-status">${getInvoiceStatus(invoice)}</b></div>
      <table class="ledger-detail-items"><thead><tr><th>Produit</th><th>Quantité</th><th>Prix unitaire</th><th>Total</th></tr></thead><tbody>${invoice.items.map((item) => `<tr><td>${item.productName}</td><td>${item.quantity}</td><td>${formatMoney(item.unitPrice)}</td><td>${formatMoney(item.subtotal)}</td></tr>`).join('')}</tbody></table>
      <div class="ledger-financial-summary"><div><span>Total de la facture</span><strong>${formatMoney(invoice.totalAmount)}</strong></div><div><span>Total payé</span><strong>${formatMoney(getInvoicePaidAmount(invoice))}</strong></div><div><span>Reste à payer</span><strong>${formatMoney(getInvoiceRemainingAmount(invoice))}</strong></div></div>
      <div class="ledger-payment-history"><h4>Historique des paiements</h4>${payments.length ? payments.map((payment) => `<div><span>${new Date(payment.date).toLocaleString('fr-FR')}</span><strong>${formatMoney(payment.amount)}</strong></div>`).join('') : '<p class="empty-state">Aucun paiement enregistré pour cette facture.</p>'}</div>
      ${getInvoiceRemainingAmount(invoice) > 0 ? `<form id="payment-form" class="ledger-payment-form"><input id="payment-customer-select" type="hidden" value="${customer.id}" /><input id="payment-invoice-select" type="hidden" value="${invoice.id}" /><label>Enregistrer un paiement<input id="payment-amount" type="number" step="0.01" min="0.01" max="${getInvoiceRemainingAmount(invoice)}" placeholder="Montant du paiement" required /></label><button type="submit" class="primary-btn">Enregistrer le paiement</button><div id="payment-message" class="message-box"></div></form>` : '<p class="ledger-paid-note">Cette facture est entièrement payée.</p>'}
    </div>
  `;
  container.querySelector('[data-debt-back]')?.addEventListener('click', () => navigateDebt(`/debts/${encodeURIComponent(customer.id)}`));
  container.querySelector('#payment-form')?.addEventListener('submit', recordPayment);
}

function renderSalesHistory() {
  const customerFilter = document.getElementById('history-customer-filter').value.toLowerCase();
  const dateFilter = document.getElementById('history-date-filter').value;
  const paymentFilter = document.getElementById('history-payment-filter').value;

  const filtered = state.sales.filter((sale) => {
    const customer = getCustomerById(sale.customerId);
    const customerMatch = !customerFilter || (customer && customer.name.toLowerCase().includes(customerFilter));
    const dateMatch = !dateFilter || new Date(sale.createdAt).toISOString().slice(0, 10) === dateFilter;
    // Returns carry no payment method, so they only survive the "all" and
    // "return" options rather than falling through every cash/credit filter.
    const paymentMatch = paymentFilter === 'all'
      || (paymentFilter === 'return' ? isReturn(sale) : !isReturn(sale) && sale.paymentMethod === paymentFilter);
    return customerMatch && dateMatch && paymentMatch;
  }).reverse();

  const list = document.getElementById('sales-history-list');
  list.innerHTML = `<table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Type</th>
        <th>Client</th>
        <th>Articles</th>
        <th>Total</th>
        <th>Paiement</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      ${filtered.map((sale) => {
        const customer = getCustomerById(sale.customerId);
        const returning = isReturn(sale);
        return `
          <tr class="${returning ? 'history-return-row' : ''}">
            <td>${new Date(sale.createdAt).toLocaleDateString('fr-FR')}</td>
            <td><span class="mini-pill ${returning ? 'return' : 'neutral'}">${returning ? 'Retour' : 'Vente'}</span></td>
            <td>${customer ? customer.name : 'Client de passage'}</td>
            <td>${sale.items.length}</td>
            <td>${formatMoney(sale.totalAmount)}</td>
            <td>${returning ? '<span class="subtle">—</span>' : `<span class="mini-pill ${sale.paymentMethod === 'debt' ? 'warning' : 'success'}">${sale.paymentMethod === 'debt' ? (sale.paymentType === 'partial' ? getInvoiceStatus(sale) : 'Crédit') : 'Espèces'}</span>`}</td>
            <td class="history-actions">
              <button class="link-btn" data-view-sale="${sale.id}">Voir</button>
              <button class="link-btn danger-link" data-delete-sale="${sale.id}">Supprimer</button>
            </td>
          </tr>
        `;
      }).join('') || '<tr><td colspan="7">Aucune transaction trouvée.</td></tr>'}
    </tbody>
  </table>`;

  list.querySelectorAll('[data-view-sale]').forEach((button) => {
    button.addEventListener('click', () => openReceipt(button.dataset.viewSale));
  });

  list.querySelectorAll('[data-delete-sale]').forEach((button) => {
    button.addEventListener('click', () => openDeleteSaleConfirmation(button.dataset.deleteSale));
  });
}

function renderHistoryCustomerSuggestions() {
  const input = document.getElementById('history-customer-filter');
  const suggestions = document.getElementById('history-customer-suggestions');
  const query = input.value.toLowerCase().trim();
  const matches = state.customers.filter((customer) => `${customer.name} ${customer.phone}`.toLowerCase().includes(query)).slice(0, 6);

  if (!query || !matches.length) {
    suggestions.innerHTML = '';
    suggestions.classList.add('hidden');
    renderSalesHistory();
    return;
  }

  suggestions.innerHTML = matches.map((customer) => `
    <button type="button" class="history-suggestion" data-history-customer="${customer.id}">
      <strong>${customer.name}</strong>
      <small>${customer.phone}</small>
    </button>
  `).join('');
  suggestions.classList.remove('hidden');

  suggestions.querySelectorAll('[data-history-customer]').forEach((button) => {
    button.addEventListener('click', () => {
      const customer = getCustomerById(button.dataset.historyCustomer);
      input.value = customer.name;
      suggestions.classList.add('hidden');
      renderSalesHistory();
    });
  });

  renderSalesHistory();
}

function getSaleItemDisplay(item) {
  return { name: item.productName || 'Article' };
}

function openReceipt(saleId) {
  const sale = state.sales.find((entry) => entry.id === saleId);
  if (!sale) return;
  const customer = getCustomerById(sale.customerId);
  const invoiceBusiness = state.settings;
  const subtotal = sale.items.reduce((sum, item) => sum + (item.subtotal ?? item.quantity * item.unitPrice), 0);
  const discount = Number(sale.discount || 0);
  const paidAmount = getInvoicePaidAmount(sale);
  const remainingBalance = getInvoiceRemainingAmount(sale);
  const isFullyPaid = remainingBalance <= 0;
  const paymentLabel = sale.paymentMethod === 'debt'
    ? (sale.paymentType === 'partial' ? 'Paiement partiel' : 'Crédit')
    : 'Espèces';
  const returning = isReturn(sale);
  const invoiceNumber = `${returning ? 'RET' : 'INV'}-${sale.id.slice(-6).toUpperCase()}`;
  const saleDate = new Date(sale.createdAt);
  const dateLabel = saleDate.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const timeLabel = saleDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  const itemRows = sale.items.map((item) => {
    const { name } = getSaleItemDisplay(item);
    const lineTotal = item.subtotal ?? item.quantity * item.unitPrice;
    const product = getProductById(item.productId);
    const productImage = item.productImage || product?.image || '';
    return `
      <tr>
        <td class="invoice-product-cell">
          ${productImage ? `<img src="${productImage}" alt="" />` : ''}
          <span>${name}</span>
        </td>
        <td class="invoice-num-cell">${item.quantity}</td>
        <td class="invoice-num-cell">${formatMoney(item.unitPrice)}</td>
        <td class="invoice-num-cell">${formatMoney(lineTotal)}</td>
      </tr>
    `;
  }).join('');

  document.getElementById('receipt-content').innerHTML = `
    <div class="invoice-document${returning ? ' invoice-return-document' : ''}">
      ${returning ? '<p class="invoice-return-banner">RETOUR</p>' : ''}
      <header class="invoice-brand-header">
        <img src="/pics/logo.png" alt="Logo H.H Fruit" />
        <div>
          <strong>${invoiceBusiness.storeName || 'H.H Fruit'}</strong>
          <span>${invoiceBusiness.storeAddress}</span>
          <span>${invoiceBusiness.storePhone} &middot; ${invoiceBusiness.storeEmail}</span>
        </div>
        <div class="invoice-number">
          <span>${returning ? 'Reçu de retour' : 'Facture / Reçu'}</span>
          <strong>${invoiceNumber}</strong>
          <small>${dateLabel}</small>
          <small>${timeLabel}</small>
        </div>
      </header>

      <section class="invoice-parties">
        <div>
          <span>Informations client</span>
          <strong>${customer ? customer.name : 'Client de passage'}</strong>
          ${customer?.phone ? `<small>${customer.phone}</small>` : ''}
          ${customer?.address ? `<small>${customer.address}</small>` : ''}
        </div>
        <div>
          <span>${returning ? 'Détails du retour' : 'Détails de la vente'}</span>
          <small>${returning ? 'Retour' : 'Facture'} n° ${invoiceNumber}</small>
          <small>Date : ${dateLabel}</small>
          <small>Heure : ${timeLabel}</small>
          <small>${returning ? 'Retour de marchandise' : `Vente ${paymentLabel.toLowerCase()}`}</small>
        </div>
      </section>

      <table class="print-invoice-table">
        <thead>
          <tr>
            <th>Produit</th>
            <th>Quantité</th>
            <th>Prix unitaire (F CFA)</th>
            <th>Total (F CFA)</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      <section class="invoice-summary">
        ${returning
          ? `<div class="invoice-payment-box">
          <strong>Retour</strong>
          <div><span>Type</span><strong>Retour de marchandise</strong></div>
          <div><span>Articles retournés</span><strong>${sale.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)}</strong></div>
        </div>`
          : `<div class="invoice-payment-box">
          <strong>Paiement</strong>
          <div><span>Montant payé</span><strong>${formatMoney(paidAmount)}</strong></div>
          <div><span>Mode de paiement</span><strong>${paymentLabel}</strong></div>
          ${!isFullyPaid ? `<div><span>Reste à payer</span><strong class="invoice-balance-due">${formatMoney(remainingBalance)}</strong></div>` : ''}
        </div>`}
        <div class="invoice-total-box">
          <div><span>Sous-total</span><strong>${formatMoney(subtotal)}</strong></div>
          ${discount > 0 ? `<div><span>Remise</span><strong>-${formatMoney(discount)}</strong></div>` : ''}
          <div class="invoice-grand-total"><span>${returning ? 'Total du retour' : 'Total'}</span><strong>${formatMoney(sale.totalAmount)}</strong></div>
        </div>
      </section>

      <section class="invoice-signatures">
        <div class="invoice-signature-block">
          <span class="invoice-signature-line"></span>
          <small>Signature du client</small>
        </div>
        <div class="invoice-signature-block">
          <span class="invoice-signature-line"></span>
          <small>Signature autorisée</small>
        </div>
      </section>

      <footer class="invoice-footer">
        <div>
          <strong>${invoiceBusiness.receiptFooter}</strong>
          <span>${invoiceBusiness.countryOfOrigin}</span>
        </div>
        <div>
          <span>${invoiceBusiness.storeAddress}</span>
            <span>${invoiceBusiness.storePhone}</span>
            <span>${invoiceBusiness.storeEmail}</span>
        </div>
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

function confirmDeleteSale() {
  if (!pendingDeleteSaleId) return;
  const saleIndex = state.sales.findIndex((sale) => sale.id === pendingDeleteSaleId);
  if (saleIndex < 0) return;

  const sale = state.sales[saleIndex];
  // Undo whatever the transaction did to stock: a sale removed units, a return
  // added them back.
  const returning = isReturn(sale);
  sale.items.forEach((item) => {
    const product = getProductById(item.productId);
    if (!product) return;
    product.stock = returning
      ? Math.max(0, Number(product.stock || 0) - item.quantity)
      : Number(product.stock || 0) + item.quantity;
  });

  const customer = getCustomerById(sale.customerId);
  if (customer) {
    customer.debtHistory = customer.debtHistory.filter((entry) => entry.saleId !== sale.id);
  }

  state.sales.splice(saleIndex, 1);
  saveState();
  closeDeleteSaleConfirmation();
  closeReceipt();
  renderAll();
  showMessage('pos-message', returning ? 'Retour supprimé et stock rétabli.' : 'Vente supprimée et écritures rétablies.', 'success');
}

function handleProductSubmit(event) {
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

  if (editingProductId) {
    const index = state.products.findIndex((product) => product.id === editingProductId);
    const existingProduct = state.products[index];
    state.products[index] = {
      ...existingProduct,
      ...payload
    };
  } else {
    if (startingStock < 0) return;
    state.products.push({
      id: uid('prod'),
      ...payload,
      stock: startingStock
    });
  }

  saveState();
  cancelProductEdit();
  renderAll();
}

function handleCustomerSubmit(event) {
  event.preventDefault();
  const payload = {
    name: document.getElementById('customer-name').value.trim(),
    phone: document.getElementById('customer-phone').value.trim(),
    address: document.getElementById('customer-address').value.trim()
  };

  if (!payload.name || !payload.phone) return;

  if (editingCustomerId) {
    const index = state.customers.findIndex((customer) => customer.id === editingCustomerId);
    state.customers[index] = { ...state.customers[index], ...payload };
  } else {
    state.customers.push({
      id: uid('cust'),
      name: payload.name,
      phone: payload.phone,
      address: payload.address,
      balance: 0,
      totalPurchased: 0,
      totalPaid: 0,
      debtHistory: []
    });
  }

  saveState();
  cancelCustomerEdit();
  renderAll();
}

function toggleNewCustomerFields() {
  const fields = document.getElementById('new-customer-fields');
  const isHidden = fields.classList.toggle('hidden');
  if (!isHidden) document.getElementById('new-customer-name').focus();
}

function addCustomerFromPos() {
  const name = document.getElementById('new-customer-name').value.trim();
  const phone = document.getElementById('new-customer-phone').value.trim();
  const address = document.getElementById('new-customer-address').value.trim();

  if (!name || !phone) {
    showMessage('pos-message', 'Le nom et le téléphone du client sont obligatoires.', 'error');
    return;
  }

  const newCustomer = {
    id: uid('cust'),
    name,
    phone,
    address,
    balance: 0,
    totalPurchased: 0,
    totalPaid: 0,
    debtHistory: []
  };

  state.customers.push(newCustomer);
  saveState();
  selectedPosCustomerId = newCustomer.id;
  document.getElementById('pos-customer-search').value = `${newCustomer.name} (${newCustomer.phone})`;
  document.getElementById('new-customer-name').value = '';
  document.getElementById('new-customer-phone').value = '';
  document.getElementById('new-customer-address').value = '';
  document.getElementById('new-customer-fields').classList.add('hidden');
  showMessage('pos-message', 'Client créé avec succès.', 'success');
  renderAll();
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

function confirmPaymentRecord() {
  if (!pendingPayment) return;

  const customer = getCustomerById(pendingPayment.customerId);
  const invoice = state.sales.find((sale) => sale.id === pendingPayment.invoiceId && sale.customerId === pendingPayment.customerId);
  if (!customer || !invoice) return;

  if (pendingPayment.amount > getInvoiceRemainingAmount(invoice)) return;
  invoice.amountPaid = getInvoicePaidAmount(invoice) + pendingPayment.amount;
  invoice.status = getInvoiceStatus(invoice);
  customer.debtHistory.push({
    id: uid('payment'),
    type: 'payment',
    amount: pendingPayment.amount,
    date: new Date().toISOString(),
    saleId: invoice.id
  });

  const paymentAmount = pendingPayment.amount;
  const invoiceNumber = pendingPayment.invoiceNumber;
  saveState();
  document.getElementById('payment-form').reset();
  closePaymentConfirmation();
  renderAll();
  showMessage('payment-message', `Paiement de ${formatMoney(paymentAmount)} enregistré sur la facture n°${invoiceNumber}.`, 'success');
}

function completeSale() {
  const returning = isReturnMode();

  if (!cart.length) {
    showMessage('pos-message', returning ? 'Ajoutez au moins un produit au retour.' : 'Ajoutez au moins un produit à la vente.', 'error');
    return;
  }
  if (cart.some((item) => !Number.isFinite(item.quantity) || item.quantity < 1)) {
    showMessage('pos-message', 'Chaque quantité doit être supérieure à 0.', 'error');
    return;
  }

  const customerId = selectedPosCustomerId;
  const totalAmount = getCartTotal();

  // A return is not a payment: no method, no credit, and the client stays optional.
  if (returning) {
    pendingSale = { type: 'return', customerId: customerId || null, totalAmount, items: structuredClone(cart) };
    const customer = customerId ? getCustomerById(customerId) : null;
    document.getElementById('sale-confirm-title').textContent = 'Finaliser ce retour ?';
    document.getElementById('sale-confirm-text').textContent =
      `${formatMoney(totalAmount)} · ${cart.length} article${cart.length === 1 ? '' : 's'} · Retour · ${customer ? customer.name : 'Client de passage'}`;
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
  document.getElementById('sale-confirm-text').textContent = `${formatMoney(totalAmount)} · ${cart.length} article${cart.length === 1 ? '' : 's'} · ${paymentLabel}`;
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
    else await confirmSaleTransaction();
  } finally {
    isCompletingTransaction = false;
    document.getElementById('confirm-sale-btn').disabled = false;
  }
}

// An independent Retour transaction: it never looks up, links to, or edits an
// existing sale, and it leaves every customer balance and total alone.
async function confirmReturn() {
  const { customerId, totalAmount, items } = pendingSale;
  const returnId = uid('return');
  const returnRecord = {
    id: returnId,
    type: 'return',
    createdAt: new Date().toISOString(),
    customerId,
    totalAmount,
    items: items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.quantity * item.unitPrice
    }))
  };

  state.sales.push(returnRecord);

  items.forEach((item) => {
    const product = getProductById(item.productId);
    if (!product) return;
    product.stock = Number(product.stock || 0) + item.quantity;
  });

  cart = [];
  selectedPosCustomerId = null;
  document.getElementById('pos-customer-search').value = '';
  closeSaleConfirmation();
  renderAll();

  const saved = await saveState();
  if (saved) {
    showMessage('pos-message', 'Retour enregistré. Le stock a été réapprovisionné.', 'success');
    openReceipt(returnId);
    return;
  }

  showMessage(
    'pos-message',
    'ATTENTION : le retour n’a PAS été enregistré sur le serveur. Ne fermez pas cette page, vérifiez la connexion puis réessayez.',
    'error'
  );
}

async function confirmSaleTransaction() {
  const { customerId, paymentMethod, partialAmount, totalAmount, items } = pendingSale;
  const amountPaid = paymentMethod === 'cash' ? totalAmount : paymentMethod === 'partial' ? partialAmount : 0;
  const remainingAmount = totalAmount - amountPaid;
  const saleId = uid('sale');
  const saleRecord = {
    id: saleId,
    type: 'sale',
    createdAt: new Date().toISOString(),
    customerId,
    paymentMethod,
    totalAmount,
    paymentMethod: paymentMethod === 'cash' ? 'cash' : 'debt',
    paymentType: paymentMethod,
    amountPaid,
    debtAmount: remainingAmount,
    status: paymentMethod === 'cash' ? 'Paid' : paymentMethod === 'partial' ? 'Partially Paid' : 'Unpaid',
    items: items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.quantity * item.unitPrice
    }))
  };

  state.sales.push(saleRecord);

  items.forEach((item) => {
    const product = getProductById(item.productId);
    if (!product) return;
    product.stock = Math.max(0, product.stock - item.quantity);
  });

  if (customerId) {
    const customer = getCustomerById(customerId);
    if (customer) {
      customer.totalPurchased += totalAmount;
      if (paymentMethod === 'cash') {
        customer.totalPaid += totalAmount;
      }

      if (paymentMethod !== 'cash') {
        customer.debtHistory.push({
          id: uid('ledger'),
          type: 'sale',
          amount: totalAmount,
          date: new Date().toISOString(),
          saleId
        });
        if (amountPaid > 0) {
          customer.debtHistory.push({
            id: uid('payment'),
            type: 'payment',
            amount: amountPaid,
            date: new Date().toISOString(),
            saleId
          });
        }
      }
    }
  }

  cart = [];
  selectedPosCustomerId = null;
  document.getElementById('pos-customer-search').value = '';
  closeSaleConfirmation();
  renderAll();

  // Only confirm the sale to the operator once the server has acknowledged the write,
  // otherwise a failed save would still print a receipt for a sale nobody recorded.
  const saved = await saveState();
  if (saved) {
    showMessage('pos-message', 'Vente finalisée avec succès.', 'success');
    openReceipt(saleId);
    return;
  }

  showMessage(
    'pos-message',
    'ATTENTION : la vente n’a PAS été enregistrée sur le serveur. Ne fermez pas cette page, vérifiez la connexion puis réessayez.',
    'error'
  );
}

// --- Dépenses ---------------------------------------------------------------
// Expenses are a self-contained ledger. Nothing here reads sales, customers,
// debts or stock, and nothing outside here reads state.expenses, so the two
// sides can never affect each other's totals.

const EXPENSE_TYPES = [
  'Salaires',
  'Produits gaspillés',
  'Réparation / Maintenance',
  'Amélioration / Mise à niveau',
  'Autre'
];

// Its own filter state, deliberately separate from the dashboard's incomeRange.
let expenseFilters = { type: 'all', dateMode: 'all', start: '', end: '' };
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

function getExpenseDateBounds() {
  const today = new Date();
  if (expenseFilters.dateMode === 'today') {
    const value = toDateInputValue(today);
    return { start: value, end: value };
  }
  if (expenseFilters.dateMode === 'week') {
    return { start: toDateInputValue(getStartOfWeek(today)), end: toDateInputValue(today) };
  }
  if (expenseFilters.dateMode === 'custom') {
    return { start: expenseFilters.start || '', end: expenseFilters.end || '' };
  }
  return { start: '', end: '' };
}

// The single source of truth for both the list and the total, so the summary can
// never disagree with the rows on screen.
function getFilteredExpenses() {
  const { start, end } = getExpenseDateBounds();
  return state.expenses
    .filter((expense) => {
      const typeMatch = expenseFilters.type === 'all' || expense.type === expenseFilters.type;
      const afterStart = !start || (expense.date || '') >= start;
      const beforeEnd = !end || (expense.date || '') <= end;
      return typeMatch && afterStart && beforeEnd;
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function hasActiveExpenseFilters() {
  return expenseFilters.type !== 'all' || expenseFilters.dateMode !== 'all';
}

function renderExpenses() {
  const list = document.getElementById('expenses-list');
  if (!list) return;

  const filtered = getFilteredExpenses();
  const total = filtered.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);

  document.getElementById('expenses-total').textContent = formatMoney(total);
  document.getElementById('expenses-count').textContent = `${filtered.length} dépense${filtered.length === 1 ? '' : 's'}`;
  document.getElementById('expense-custom-range').classList.toggle('hidden', expenseFilters.dateMode !== 'custom');

  if (!filtered.length) {
    list.innerHTML = `<p class="empty-state">${
      state.expenses.length && hasActiveExpenseFilters() ? 'Aucune dépense pour ces critères' : 'Aucune dépense'
    }</p>`;
    return;
  }

  list.innerHTML = `<table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Type de dépense</th>
        <th>Montant</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      ${filtered.map((expense) => `
        <tr class="expense-row" data-expense-open="${expense.id}">
          <td>${formatExpenseDate(expense.date)}</td>
          <td><span class="expense-type-cell">${expense.type || 'Autre'}</span>${expense.note ? `<small class="expense-note-preview">${expense.note}</small>` : ''}</td>
          <td class="expense-amount-cell">${formatMoney(expense.amount)}</td>
          <td class="history-actions">
            <button type="button" class="link-btn" data-expense-edit="${expense.id}">Modifier</button>
            <button type="button" class="link-btn danger-link" data-expense-delete="${expense.id}">Supprimer</button>
          </td>
        </tr>
      `).join('')}
    </tbody>
  </table>`;

  list.querySelectorAll('[data-expense-edit]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openExpenseEditor(button.dataset.expenseEdit);
    });
  });
  list.querySelectorAll('[data-expense-delete]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openExpenseDeleteConfirmation(button.dataset.expenseDelete);
    });
  });
  list.querySelectorAll('[data-expense-open]').forEach((row) => {
    row.addEventListener('click', () => openExpenseDetails(row.dataset.expenseOpen));
  });
}

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

function handleExpenseSubmit(event) {
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

  const now = new Date().toISOString();
  if (editingExpenseId) {
    const existing = getExpenseById(editingExpenseId);
    if (!existing) return;
    Object.assign(existing, { type, amount, date, note, updatedAt: now });
  } else {
    state.expenses.push({ id: uid('exp'), type, amount, date, note, createdAt: now, updatedAt: now });
  }

  saveState();
  closeExpenseEditor();
  renderExpenses();
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

function confirmExpenseDelete() {
  if (!pendingDeleteExpenseId) return;
  // Touches nothing but this one row in state.expenses.
  state.expenses = state.expenses.filter((expense) => expense.id !== pendingDeleteExpenseId);
  saveState();
  closeExpenseDeleteConfirmation();
  closeExpenseDetails();
  renderExpenses();
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

  document.getElementById('expense-type-filter').addEventListener('change', (event) => {
    expenseFilters.type = event.target.value;
    renderExpenses();
  });
  document.getElementById('expense-date-filter').addEventListener('change', (event) => {
    expenseFilters.dateMode = event.target.value;
    renderExpenses();
  });
  document.getElementById('expense-range-start').addEventListener('change', (event) => {
    expenseFilters.start = event.target.value;
    renderExpenses();
  });
  document.getElementById('expense-range-end').addEventListener('change', (event) => {
    expenseFilters.end = event.target.value;
    renderExpenses();
  });
}

function renderAll() {
  renderDashboard();
  applyPosMode();
  renderPosProducts();
  renderCart();
  renderCustomerSelects();
  renderProductsList();
  renderClientRoute();
  renderDebtRoute();
  renderSalesHistory();
  renderExpenses();
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
  document.getElementById('income-range-toggle').addEventListener('click', toggleIncomeRangePanel);
  document.querySelectorAll('.range-option').forEach((button) => {
    button.addEventListener('click', () => setIncomeRangeMode(button.dataset.range));
  });
  document.getElementById('income-range-apply').addEventListener('click', applyCustomIncomeRange);
  document.getElementById('payment-method-select').addEventListener('change', updatePosPaymentFields);
  document.getElementById('history-customer-filter').addEventListener('input', renderSalesHistory);
  document.getElementById('history-customer-filter').addEventListener('input', renderHistoryCustomerSuggestions);
  document.getElementById('history-date-filter').addEventListener('change', renderSalesHistory);
  document.getElementById('history-payment-filter').addEventListener('change', renderSalesHistory);
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
  document.addEventListener('click', (event) => {
    const panel = document.getElementById('income-range-panel');
    const toggle = document.getElementById('income-range-toggle');
    if (!panel.classList.contains('hidden') && !panel.contains(event.target) && event.target !== toggle && !toggle.contains(event.target)) {
      panel.classList.add('hidden');
    }
  });
  setupExpenseListeners();
  renderNav();
}

window.addEventListener('popstate', () => {
  if (window.location.pathname.startsWith('/debts')) {
    setActiveTab('debts');
    renderDebtRoute();
  } else if (window.location.pathname.startsWith('/clients')) {
    setActiveTab('customers');
    renderClientRoute();
  }
});

document.getElementById('login-form')?.addEventListener('submit', handleLogin);
document.getElementById('logout-btn')?.addEventListener('click', handleLogout);

setupEventListeners();
renderAll();
setAppLoading(true);
if (window.location.pathname.startsWith('/debts')) {
  setActiveTab('debts');
  renderDebtRoute();
} else if (window.location.pathname.startsWith('/clients')) {
  setActiveTab('customers');
  renderClientRoute();
}
syncStateFromServer();
