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
let selectedCustomerInvoiceId = null;
let selectedDebtCustomerId = null;
let selectedDebtInvoiceId = null;
let selectedPosCustomerId = null;
let editingProductId = null;
let editingCustomerId = null;
let customerDateFilter = { mode: 'all', start: '', end: '' };
let dashboardSalesDateFilter = getTodayFilter();
let saleDiscountPercent = 0;
let pertesFilters = { mode: 'all', start: '', end: '' };
let editingPerteId = null;
let pendingDeletePerteId = null;
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
  (payload.products || []).forEach((product) => upsert(state.products, product));
  (payload.sales || []).forEach((sale) => upsert(state.sales, sale));
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

// Forms with a write in flight. A submit handler is async, so between the click
// and the server's answer the button is still live: without this a second click
// sends a second POST and the record is written twice.
const submittingForms = new WeakSet();

// Runs `write` with the form's submit button disabled, and refuses to start a
// second run while the first is still going. The WeakSet is the actual guard --
// the disabled attribute is only what makes it visible to the operator, and a
// keyboard Enter can beat it. Always releases, so a failed write can be retried.
async function submitOnce(form, write) {
  if (!form || submittingForms.has(form)) return null;
  const button = form.querySelector('[type="submit"]');
  submittingForms.add(form);
  if (button) button.disabled = true;
  try {
    return await write();
  } finally {
    submittingForms.delete(form);
    if (button) button.disabled = false;
  }
}

function getCustomerById(customerId) {
  return state.customers.find((customer) => customer.id === customerId) || null;
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

// --- Filtre de date ---------------------------------------------------------
// The one date filter every page uses: a period list, and a calendar that only
// appears once "Période personnalisée" is picked from it. A page hands over its
// current filter and a callback; the control never filters anything itself.
//
// What it reports is { mode: 'all' | 'day' | 'range', start, end, preset }, the
// shape matchesDateRangeFilter() reads. `preset` is the period it came from and
// only decides the label.

const SHARED_DATE_PERIODS = {
  today: 'Aujourd\'hui',
  week: 'Cette semaine',
  month: 'Ce mois',
  custom: 'Période personnalisée'
};

const SHARED_DATE_NO_FILTER = { mode: 'all', start: '', end: '', preset: '' };

// Open menus, the month on screen and a half-picked range, per control. Accueil
// and the client profile rebuild their markup on every change, so this lives
// here rather than in the DOM and a rebuilt control comes back as it was left.
const sharedDatePickerState = {};

function sharedDateFilterMarkup() {
  const periods = Object.entries(SHARED_DATE_PERIODS)
    .map(([key, label]) => `<button type="button" role="option" data-date-period="${key}">${label}</button>`)
    .join('');
  return `
    <div class="shared-date-control" role="group" aria-label="Filtre de date">
      <div class="shared-date-select">
        <button type="button" class="shared-date-select-trigger" data-date-select aria-haspopup="listbox" aria-expanded="false"><span data-date-label></span><span class="shared-date-caret" aria-hidden="true">▾</span></button>
        <div class="shared-date-select-menu hidden" data-date-menu role="listbox" aria-label="Période">
          ${periods}
          <button type="button" class="shared-date-menu-reset" data-date-reset>Effacer le filtre</button>
        </div>
      </div>
      <button type="button" class="calendar-icon-btn" data-date-calendar aria-label="Choisir une période" title="Choisir une période">📅</button>
    </div>
    <div class="shared-date-calendar hidden" data-date-panel role="dialog" aria-label="Période personnalisée">
      <div class="shared-date-calendar-head"><button type="button" data-date-prev aria-label="Mois précédent">‹</button><strong data-date-month></strong><button type="button" data-date-next aria-label="Mois suivant">›</button></div>
      <div class="shared-date-weekdays" aria-hidden="true"><span>L</span><span>M</span><span>M</span><span>J</span><span>V</span><span>S</span><span>D</span></div>
      <div class="shared-date-calendar-grid" data-date-grid></div>
      <div class="shared-date-calendar-foot"><span data-date-hint></span><button type="button" class="shared-date-reset" data-date-clear>Effacer</button></div>
    </div>`;
}

function sharedDateKey(date) {
  return toDateInputValue(date);
}

function sharedDateLabel(value, options) {
  return new Date(`${value}T12:00:00`).toLocaleDateString('fr-FR', options);
}

// "16/09/2026" for one day, "12/09 – 16/09/2026" for a range inside one year.
function sharedDateRangeLabel(start, end) {
  if (!end || start === end) return sharedDateLabel(start);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${sharedDateLabel(start, sameYear ? { day: '2-digit', month: '2-digit' } : undefined)} – ${sharedDateLabel(end)}`;
}

function sharedDatePreset(kind) {
  const today = new Date();
  const end = sharedDateKey(today);
  if (kind === 'today') return { mode: 'day', start: end, end, preset: 'today' };
  if (kind === 'month') return { mode: 'range', start: sharedDateKey(new Date(today.getFullYear(), today.getMonth(), 1)), end, preset: 'month' };
  const day = (today.getDay() + 6) % 7;
  const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - day);
  return { mode: 'range', start: sharedDateKey(startDate), end, preset: 'week' };
}

// Which entry of the list the filter belongs to, or '' when there is no filter.
// Dates that did not come from a preset can only have been picked by hand.
function sharedDateActivePeriod(filter, picker) {
  if (picker.customPending) return 'custom';
  if (!filter || filter.mode === 'all' || !filter.start) return '';
  return SHARED_DATE_PERIODS[filter.preset] ? filter.preset : 'custom';
}

// Picked dates only replace "Période personnalisée" once the calendar closes:
// while it is open a shorter label would shrink the control and slide the
// calendar out from under the pointer between the first and second click.
function sharedDateTriggerLabel(filter, picker) {
  const period = sharedDateActivePeriod(filter, picker);
  if (!period) return 'Toutes les dates';
  if (period !== 'custom' || picker.calendarOpen) return SHARED_DATE_PERIODS[period];
  return sharedDateRangeLabel(filter.start, filter.end);
}

function renderSharedDateCalendar(panel, filter, picker) {
  const monthDate = new Date(`${picker.month}-01T12:00:00`);
  const firstDay = (monthDate.getDay() + 6) % 7;
  const days = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
  const today = sharedDateKey(new Date());
  // Only a hand-picked selection is drawn: a preset was not chosen here.
  const picked = !picker.customPending && sharedDateActivePeriod(filter, picker) === 'custom';
  const start = picker.anchor || (picked ? filter.start : '');
  const end = picker.anchor ? '' : (picked ? filter.end || filter.start : '');

  const cells = [];
  for (let index = 0; index < firstDay; index += 1) cells.push('<span class="shared-date-empty"></span>');
  for (let day = 1; day <= days; day += 1) {
    const value = sharedDateKey(new Date(monthDate.getFullYear(), monthDate.getMonth(), day));
    const classes = ['shared-date-day'];
    if (value === today) classes.push('is-today');
    if (start && end && start !== end && value >= start && value <= end) {
      classes.push('in-range');
      if (value === start) classes.push('range-start');
      if (value === end) classes.push('range-end');
    }
    const selected = value === start || value === end;
    if (selected) classes.push('selected');
    cells.push(`<button type="button" class="${classes.join(' ')}" data-date-day="${value}" aria-pressed="${selected}">${day}</button>`);
  }

  panel.querySelector('[data-date-month]').textContent = monthDate.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  panel.querySelector('[data-date-grid]').innerHTML = cells.join('');
  panel.querySelector('[data-date-hint]').textContent = picker.anchor
    ? `${sharedDateLabel(picker.anchor)} · choisissez la fin`
    : start ? sharedDateRangeLabel(start, end) : 'Un jour, ou deux dates';
}

// The calendar opens to the right of the control. Where the screen has no room
// for that it drops below instead, nudged sideways so it stays on screen.
function positionSharedDateCalendar(root, panel) {
  const gutter = 12;
  const control = root.querySelector('.shared-date-control').getBoundingClientRect();
  const rootLeft = root.getBoundingClientRect().left;
  const width = panel.offsetWidth;
  const below = control.right + 8 + width > window.innerWidth - gutter;
  panel.classList.toggle('is-below', below);
  const shift = below ? Math.max(gutter - rootLeft, Math.min(0, window.innerWidth - gutter - width - rootLeft)) : 0;
  panel.style.setProperty('--calendar-shift', `${shift}px`);
}

// Closes every date filter except the one a click landed in; a keypress closes
// them all. The path is read rather than the target, because picking a date can
// rebuild the very markup that was clicked before the click reaches the document.
function closeSharedDateFilters(event) {
  const inside = event?.type === 'click'
    ? event.composedPath().find((node) => node?.dataset?.dateFilterId)?.dataset.dateFilterId
    : undefined;
  Object.entries(sharedDatePickerState).forEach(([id, picker]) => {
    if (id === inside || (!picker.menuOpen && !picker.calendarOpen)) return;
    picker.close();
  });
}

function setupSharedDateFilter(root, id, initialFilter, onApply) {
  if (!root) return;
  root.innerHTML = sharedDateFilterMarkup();
  root.dataset.dateFilterId = id;

  let filter = initialFilter && initialFilter.mode !== 'all' && initialFilter.start ? initialFilter : SHARED_DATE_NO_FILTER;
  const picker = sharedDatePickerState[id] || (sharedDatePickerState[id] = {
    menuOpen: false, calendarOpen: false, customPending: false, anchor: '', month: ''
  });
  if (!picker.month) picker.month = (filter.start || sharedDateKey(new Date())).slice(0, 7);

  const trigger = root.querySelector('[data-date-select]');
  const menu = root.querySelector('[data-date-menu]');
  const calendarButton = root.querySelector('[data-date-calendar]');
  const panel = root.querySelector('[data-date-panel]');

  const paint = () => {
    if (!trigger.isConnected) return;
    const period = sharedDateActivePeriod(filter, picker);
    root.querySelector('[data-date-label]').textContent = sharedDateTriggerLabel(filter, picker);
    trigger.classList.toggle('has-value', Boolean(period));
    trigger.setAttribute('aria-expanded', String(picker.menuOpen));
    menu.classList.toggle('hidden', !picker.menuOpen);
    menu.querySelectorAll('[data-date-period]').forEach((button) => {
      const active = button.dataset.datePeriod === period;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    menu.querySelector('[data-date-reset]').classList.toggle('hidden', filter.mode === 'all');
    calendarButton.classList.toggle('active', picker.calendarOpen);
    calendarButton.setAttribute('aria-expanded', String(picker.calendarOpen));
    panel.classList.toggle('hidden', !picker.calendarOpen);
    if (picker.calendarOpen) {
      renderSharedDateCalendar(panel, filter, picker);
      positionSharedDateCalendar(root, panel);
    }
  };

  const apply = (next) => {
    filter = next;
    onApply(next);
    paint();
  };

  // Closing without picking a date keeps whatever filter was already there.
  picker.close = () => {
    picker.menuOpen = false;
    picker.calendarOpen = false;
    picker.customPending = false;
    picker.anchor = '';
    paint();
  };
  picker.repaint = paint;

  const toggleMenu = () => {
    const opening = !picker.menuOpen;
    picker.close();
    picker.menuOpen = opening;
    paint();
  };

  trigger.addEventListener('click', toggleMenu);

  // Once a custom period is in play the icon reopens its calendar; otherwise it
  // opens the list, since the calendar only exists for a custom period.
  calendarButton.addEventListener('click', () => {
    if (sharedDateActivePeriod(filter, picker) !== 'custom') return toggleMenu();
    const opening = !picker.calendarOpen;
    picker.close();
    picker.calendarOpen = opening;
    paint();
  });

  menu.querySelectorAll('[data-date-period]').forEach((button) => button.addEventListener('click', () => {
    const period = button.dataset.datePeriod;
    const wasCustom = sharedDateActivePeriod(filter, picker) === 'custom';
    picker.close();
    if (period !== 'custom') return apply(sharedDatePreset(period));
    picker.customPending = !wasCustom;
    picker.calendarOpen = true;
    picker.month = ((wasCustom && filter.start) || sharedDateKey(new Date())).slice(0, 7);
    paint();
  }));

  const reset = () => {
    picker.close();
    apply({ ...SHARED_DATE_NO_FILTER });
  };
  menu.querySelector('[data-date-reset]').addEventListener('click', reset);
  panel.querySelector('[data-date-clear]').addEventListener('click', reset);

  const moveMonth = (step) => {
    const date = new Date(`${picker.month}-01T12:00:00`);
    date.setMonth(date.getMonth() + step);
    picker.month = sharedDateKey(date).slice(0, 7);
    paint();
  };
  panel.querySelector('[data-date-prev]').addEventListener('click', () => moveMonth(-1));
  panel.querySelector('[data-date-next]').addEventListener('click', () => moveMonth(1));

  // The first date filters that single day straight away; a second one turns it
  // into the range between the two. A third starts over.
  const grid = panel.querySelector('[data-date-grid]');
  grid.addEventListener('click', (event) => {
    const value = event.target.closest('[data-date-day]')?.dataset.dateDay;
    if (!value) return;
    picker.customPending = false;
    if (!picker.anchor) {
      picker.anchor = value;
      return apply({ mode: 'day', start: value, end: value, preset: 'custom' });
    }
    const [start, end] = [picker.anchor, value].sort();
    picker.anchor = '';
    apply({ mode: start === end ? 'day' : 'range', start, end, preset: 'custom' });
  });

  // While the end is still to be chosen, the days it would cover are previewed.
  grid.addEventListener('mouseover', (event) => {
    const value = event.target.closest('[data-date-day]')?.dataset.dateDay;
    if (!picker.anchor || !value) return;
    const [start, end] = [picker.anchor, value].sort();
    grid.querySelectorAll('[data-date-day]').forEach((day) => {
      day.classList.toggle('in-preview', day.dataset.dateDay >= start && day.dataset.dateDay <= end);
    });
  });
  grid.addEventListener('mouseleave', () => {
    grid.querySelectorAll('.in-preview').forEach((day) => day.classList.remove('in-preview'));
  });

  paint();
}

function getProductById(productId) {
  return state.products.find((product) => product.id === productId) || null;
}

function getWasteSales() {
  return state.sales.filter((sale) => getTransactionType(sale) === 'waste').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getWasteRows() {
  return getWasteSales().filter((sale) => {
    const item = sale.items?.[0];
    if (!item) return false;
    const productMatch = pertesFilters.productId && pertesFilters.productId !== 'all'
      ? item.productId === pertesFilters.productId
      : true;
    const dateMatch = matchesDateRangeFilter(sale.createdAt, pertesFilters);
    return productMatch && dateMatch;
  });
}

// Transactions recorded before returns existed carry no type, so anything that
// is not explicitly a return is a sale.
// The five kinds of row in state.sales. Anything unrecognised is read as a sale,
// which is what a row written before the ledger grew these types would be.
const TRANSACTION_TYPES = ['sale', 'return', 'purchase', 'waste', 'adjustment', 'adjustment_out'];
const PERTE_REASONS = [
  'Produit périmé',
  'Produit avarié',
  'Produit endommagé',
  'Produit cassé',
  'Perdu',
  'Autre'
];

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
};

function isReturnMode() {
  return posMode === 'return';
}

// True when the cart may not exceed what is on the shelf. A return is the one
// mode that may, since the units are coming back in.
function isStockLimitedMode() {
  return POS_MODES[posMode].stockLimited;
}

// Switches the register between Vente and Retour. The cart, catalogue and
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

  ['cart-area', 'pos'].forEach((id) => {
    const element = document.getElementById(id);
    element?.classList.toggle('is-return-mode', returning);
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

function renderWasteView() {
  const listEl = document.getElementById('pertes-list');
  const summaryEl = document.getElementById('pertes-summary');
  const totalEl = document.getElementById('pertes-total-quantity');
  const filterSummaryEl = document.getElementById('pertes-filter-summary');
  const rows = getWasteRows();
  const productSearch = document.getElementById('pertes-product-search');
  const selectedProduct = pertesFilters.productId && pertesFilters.productId !== 'all'
    ? getProductById(pertesFilters.productId) : null;
  if (productSearch && document.activeElement !== productSearch) productSearch.value = selectedProduct?.name || '';
  document.getElementById('clear-pertes-product')?.classList.toggle('hidden', !selectedProduct);
  const totalUnits = rows.reduce((sum, sale) => sum + Number(sale.items?.[0]?.quantity || 0), 0);

  if (summaryEl) summaryEl.textContent = `${plural(rows.length, 'perte')} · ${plural(totalUnits, 'article')} perdu`;
  if (totalEl) totalEl.textContent = `${totalUnits} article${Math.abs(totalUnits) > 1 ? 's' : ''}`;
  if (filterSummaryEl) filterSummaryEl.textContent = getDateFilterSummary(pertesFilters);

  if (!listEl) return;

  if (!rows.length) {
    listEl.innerHTML = `
      <div class="empty-state-block">
        <strong>Aucune perte</strong>
        <p>La liste des pertes enregistrées apparaîtra ici.</p>
      </div>`;
    return;
  }

  listEl.innerHTML = rows.map((sale) => {
    const item = sale.items?.[0];
    const product = item ? getProductById(item.productId) : null;
    const when = new Date(sale.createdAt);
    return `
      <article class="perte-row" data-perte-details="${sale.id}">
        <div class="perte-row-main">
          <div class="perte-row-date"><span class="perte-row-label">Date</span><strong>${when.toLocaleDateString('fr-FR')}</strong></div>
          <div class="perte-row-product"><span class="perte-row-label">Produit</span><strong>${escapeHtml(product?.name || item?.productName || 'Produit supprimé')}</strong></div>
          <div class="perte-row-quantity"><span class="perte-row-label">Quantité</span><strong>${Number(item?.quantity || 0)}</strong><small>article${Number(item?.quantity || 0) > 1 ? 's' : ''}</small></div>
          <div class="perte-row-reason"><span class="perte-row-label">Motif</span><span class="perte-reason-pill">${escapeHtml(sale.reason || 'Autre')}</span></div>
        </div>
        <div class="perte-row-actions">
          <button type="button" class="link-btn" data-perte-view="${sale.id}">Voir</button>
          <button type="button" class="link-btn" data-perte-edit="${sale.id}">Modifier</button>
          <button type="button" class="link-btn danger-link" data-perte-delete="${sale.id}">Supprimer</button>
        </div>
      </article>
    `;
  }).join('');

  listEl.querySelectorAll('[data-perte-details]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      openPerteDetails(row.dataset.perteDetails);
    });
  });
  listEl.querySelectorAll('[data-perte-view]').forEach((button) => {
    button.addEventListener('click', () => openPerteDetails(button.dataset.perteView));
  });
  listEl.querySelectorAll('[data-perte-edit]').forEach((button) => {
    button.addEventListener('click', () => openPerteEditor(button.dataset.perteEdit));
  });
  listEl.querySelectorAll('[data-perte-delete]').forEach((button) => {
    button.addEventListener('click', () => deletePerte(button.dataset.perteDelete));
  });
}

function renderPerteProductOptions(query = '') {
  const options = document.getElementById('perte-product-options');
  const search = document.getElementById('perte-product-search');
  if (!options || !search) return;
  const normalizedQuery = query.trim().toLowerCase();
  const matches = state.products
    .filter((product) => product.name.toLowerCase().includes(normalizedQuery))
    .slice(0, 30);
  options.innerHTML = matches.length
    ? matches.map((product) => `<button type="button" class="perte-product-option" role="option" data-product-id="${product.id}"><strong>${escapeHtml(product.name)}</strong><small>${Number(product.stock || 0)} en stock</small></button>`).join('')
    : '<p class="perte-product-empty">Aucun produit trouvé.</p>';
  options.classList.remove('hidden');
  search.setAttribute('aria-expanded', 'true');
}

function closePerteProductOptions() {
  const options = document.getElementById('perte-product-options');
  const search = document.getElementById('perte-product-search');
  options?.classList.add('hidden');
  search?.setAttribute('aria-expanded', 'false');
}

function selectPerteProduct(productId) {
  const product = getProductById(productId);
  const hiddenInput = document.getElementById('perte-product');
  const search = document.getElementById('perte-product-search');
  if (!product || !hiddenInput || !search) return;
  hiddenInput.value = product.id;
  search.value = product.name;
  closePerteProductOptions();
}

function renderPerteHistoryProductOptions(query = '') {
  const options = document.getElementById('pertes-product-options');
  const input = document.getElementById('pertes-product-search');
  if (!options || !input) return;
  const normalizedQuery = query.trim().toLowerCase();
  const matches = state.products
    .filter((product) => product.name.toLowerCase().includes(normalizedQuery))
    .slice(0, 30);
  options.innerHTML = matches.length
    ? matches.map((product) => `<button type="button" class="pertes-product-option" role="option" data-pertes-product-id="${product.id}">${escapeHtml(product.name)}</button>`).join('')
    : '<p class="pertes-product-empty">Aucun produit trouvé.</p>';
  options.classList.remove('hidden');
  input.setAttribute('aria-expanded', 'true');
}

function closePerteHistoryProductOptions() {
  const options = document.getElementById('pertes-product-options');
  const input = document.getElementById('pertes-product-search');
  options?.classList.add('hidden');
  input?.setAttribute('aria-expanded', 'false');
}

function selectPerteHistoryProduct(productId) {
  const product = getProductById(productId);
  const input = document.getElementById('pertes-product-search');
  const clear = document.getElementById('clear-pertes-product');
  if (!product || !input) return;
  pertesFilters.productId = product.id;
  input.value = product.name;
  clear?.classList.remove('hidden');
  closePerteHistoryProductOptions();
  renderWasteView();
}

function clearPerteHistoryProduct() {
  pertesFilters.productId = 'all';
  const input = document.getElementById('pertes-product-search');
  input.value = '';
  document.getElementById('clear-pertes-product')?.classList.add('hidden');
  closePerteHistoryProductOptions();
  renderWasteView();
}

function openPerteEditor(perteId = null) {
  const sale = perteId ? getWasteSales().find((entry) => entry.id === perteId) : null;
  editingPerteId = sale ? sale.id : null;
  const form = document.getElementById('perte-form');
  if (!form) return;
  form.reset();
  const productSelect = document.getElementById('perte-product');
  const productSearch = document.getElementById('perte-product-search');
  const reasonSelect = document.getElementById('perte-reason');
  const dateInput = document.getElementById('perte-date');
  const noteInput = document.getElementById('perte-note');
  const qtyInput = document.getElementById('perte-quantity');
  reasonSelect.innerHTML = PERTE_REASONS.map((reason) => `<option value="${reason}">${reason}</option>`).join('');
  if (sale) {
    const item = sale.items?.[0];
    const productId = item?.productId || '';
    productSelect.value = productId;
    productSearch.value = item?.productName || getProductById(productId)?.name || '';
    qtyInput.value = item?.quantity || 1;
    reasonSelect.value = sale.reason || 'Autre';
    dateInput.value = sale.createdAt ? toDateInputValue(new Date(sale.createdAt)) : toDateInputValue(new Date());
    noteInput.value = sale.note || '';
    document.getElementById('perte-form-title').textContent = 'Modifier la perte';
    document.getElementById('perte-submit-btn').textContent = 'Enregistrer';
  } else {
    productSelect.value = '';
    productSearch.value = '';
    qtyInput.value = 1;
    reasonSelect.value = 'Produit périmé';
    dateInput.value = toDateInputValue(new Date());
    noteInput.value = '';
    document.getElementById('perte-form-title').textContent = 'Nouvelle perte';
    document.getElementById('perte-submit-btn').textContent = 'Enregistrer';
  }
  document.getElementById('perte-form-message').textContent = '';
  document.getElementById('perte-editor-modal').classList.remove('hidden');
  productSearch.focus();
}

function closePerteEditor() {
  editingPerteId = null;
  document.getElementById('perte-form')?.reset();
  document.getElementById('perte-form-message').textContent = '';
  document.getElementById('perte-editor-modal')?.classList.add('hidden');
}

async function handlePerteSubmit(event) {
  event.preventDefault();
  const productId = document.getElementById('perte-product').value;
  const quantity = Number(document.getElementById('perte-quantity').value);
  const reason = document.getElementById('perte-reason').value;
  const date = document.getElementById('perte-date').value;
  const note = document.getElementById('perte-note').value.trim();
  const product = getProductById(productId);
  const formMessage = document.getElementById('perte-form-message');

  if (!productId || !product) {
    formMessage.textContent = 'Sélectionnez un produit existant.';
    return;
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    formMessage.textContent = 'La quantité doit être supérieure à 0.';
    return;
  }
  const existingPerte = editingPerteId ? getWasteSales().find((sale) => sale.id === editingPerteId) : null;
  const existingItem = existingPerte?.items?.[0];
  const restoredStock = Number(product.stock || 0)
    + (existingItem?.productId === productId ? Number(existingItem.quantity || 0) : 0);
  if (quantity > restoredStock) {
    formMessage.textContent = `La quantité ne peut pas dépasser le stock disponible (${restoredStock}).`;
    return;
  }
  if (!date) {
    formMessage.textContent = 'La date est obligatoire.';
    return;
  }
  if (!reason || !PERTE_REASONS.includes(reason)) {
    formMessage.textContent = 'Sélectionnez un motif valide.';
    return;
  }

  const payload = {
    type: 'waste',
    productId,
    reason,
    date,
    note,
    items: [{ productId, quantity }]
  };

  const saved = await submitOnce(event.target, () => (editingPerteId
    ? mutate(`/sales/${editingPerteId}`, 'PUT', { ...payload, reason, date, note, items: payload.items })
    : mutate('/sales', 'POST', payload)));
  if (saved === null) return;
  closePerteEditor();
  renderWasteView();
  renderProductsList();
}

function openPerteDetails(perteId) {
  const sale = getWasteSales().find((entry) => entry.id === perteId);
  if (!sale) return;
  const item = sale.items?.[0];
  const product = item ? getProductById(item.productId) : null;
  const detail = document.getElementById('perte-details-modal');
  const body = document.getElementById('perte-details-body');
  if (!detail || !body) return;
  detail.dataset.perteId = sale.id;
  body.innerHTML = `
    <div class="expense-detail-row"><span>Produit</span><strong>${escapeHtml(product?.name || item?.productName || 'Produit supprimé')}</strong></div>
    <div class="expense-detail-row"><span>Quantité</span><strong>${Number(item?.quantity || 0)}</strong></div>
    <div class="expense-detail-row"><span>Motif</span><strong>${escapeHtml(sale.reason || 'Autre')}</strong></div>
    <div class="expense-detail-row"><span>Date</span><strong>${new Date(sale.createdAt).toLocaleDateString('fr-FR')}</strong></div>
    <div class="expense-detail-row expense-detail-note"><span>Note</span><strong>${escapeHtml(sale.note || 'Aucune note')}</strong></div>
  `;
  detail.classList.remove('hidden');
}

function closePerteDetails() {
  document.getElementById('perte-details-modal')?.classList.add('hidden');
}

async function confirmPerteDelete() {
  const saleId = pendingDeletePerteId;
  if (!saleId) return;
  const saved = await mutate(`/sales/${saleId}`, 'DELETE', null, () => {
    state.sales = state.sales.filter((entry) => entry.id !== saleId);
  });
  if (saved === null) return;
  pendingDeletePerteId = null;
  document.getElementById('perte-delete-modal')?.classList.add('hidden');
  closePerteDetails();
  renderWasteView();
  renderProductsList();
}

async function deletePerte(perteId) {
  const sale = getWasteSales().find((entry) => entry.id === perteId);
  if (!sale) return;
  pendingDeletePerteId = sale.id;
  document.getElementById('perte-delete-text').textContent = `Voulez-vous vraiment supprimer cette perte ?`;
  document.getElementById('perte-delete-modal').classList.remove('hidden');
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
  // Receiving goods belongs in Achats, where the cost and supplier are captured;
  // this block is for correcting a count.
  document.getElementById('inventory-section-hint').textContent = 'Corrigez le comptage. Pour une livraison, utilisez Achats.';
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
  const row = document.getElementById('product-stock-add-row');
  row.classList.toggle('hidden');
  if (!row.classList.contains('hidden')) {
    // Pre-filled with what the system believes, so the operator overwrites it
    // with what they actually counted.
    const product = getProductById(editingProductId);
    const field = document.getElementById('product-stock-addition');
    field.value = product ? product.stock : '';
    field.focus();
    field.select();
    renderStockDelta();
  }
}

function cancelAddStock() {
  document.getElementById('product-stock-add-row').classList.add('hidden');
  document.getElementById('product-stock-addition').value = '';
  document.getElementById('product-stock-delta').textContent = '';
}

// Says what the correction will do before it is made, so nobody removes stock by
// mistyping a count.
function renderStockDelta() {
  const label = document.getElementById('product-stock-delta');
  const product = getProductById(editingProductId);
  const raw = document.getElementById('product-stock-addition').value;
  if (!label) return;
  if (!product || raw === '') {
    label.textContent = '';
    label.className = 'stock-delta';
    return;
  }
  const delta = Math.trunc(Number(raw)) - product.stock;
  if (!Number.isFinite(delta) || delta === 0) {
    label.textContent = 'Aucun changement.';
    label.className = 'stock-delta';
    return;
  }
  label.textContent = delta > 0
    ? `Ajoutera ${plural(delta, 'unité')} au stock.`
    : `Retirera ${plural(Math.abs(delta), 'unité')} du stock.`;
  label.className = `stock-delta ${delta > 0 ? 'is-up' : 'is-down'}`;
}

async function addStockToProduct() {
  if (!editingProductId) return;
  const product = getProductById(editingProductId);
  const raw = document.getElementById('product-stock-addition').value;
  if (!product || raw === '') return;

  const target = Math.trunc(Number(raw));
  if (!Number.isFinite(target) || target < 0 || target === product.stock) return;

  // The counted figure is sent, not the difference: the server works the
  // difference out against the locked row, so a concurrent sale cannot be undone
  // by a correction that was calculated before it happened.
  const saved = await mutate(`/products/${editingProductId}/stock`, 'POST', { target });
  if (saved === null) return;

  document.getElementById('product-current-stock').textContent = saved.product.stock;
  cancelAddStock();
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
      selectedCustomerInvoiceId = null;
      navigateClient(`/clients/${encodeURIComponent(button.dataset.selectCustomer)}`);
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

async function deleteCustomer(customer) {
  if (Number(customer.balance) > 0) {
    window.alert(`${customer.name} doit encore ${formatMoney(customer.balance)}. Réglez la dette avant de supprimer la fiche.`);
    return;
  }
  if (!window.confirm(`Supprimer la fiche de ${customer.name} ? Ses ventes passées sont conservées.`)) return;

  const saved = await mutate(`/customers/${customer.id}`, 'DELETE', null, () => {
    state.customers = state.customers.filter((entry) => entry.id !== customer.id);
  });
  if (saved === null) return;
  navigateClient('/clients');
}

function cancelCustomerEdit() {
  editingCustomerId = null;
  document.getElementById('customer-form').reset();
  document.getElementById('customer-form-title').textContent = 'Ajouter un client';
  document.getElementById('cancel-customer-edit').classList.add('hidden');
  document.getElementById('customer-editor-modal')?.classList.add('hidden');
}

function getTodayFilter() {
  const today = toDateInputValue(new Date());
  return { mode: 'day', start: today, end: today, preset: 'today' };
}

function getDashboardTransactions() {
  const filter = getTodayFilter();
  return state.sales
    .filter((sale) => isCustomerSale(sale) || isReturn(sale))
    .filter((sale) => matchesDateRangeFilter(sale.createdAt, filter));
}

function renderDashboard() {
  const summary = document.getElementById('dashboard-summary');
  const history = document.getElementById('dashboard-history');
  if (!summary || !history) return;

  const todayTransactions = getDashboardTransactions();
  const todaySales = todayTransactions.filter(isCustomerSale);
  const todayReturns = todayTransactions.filter(isReturn);
  const filteredSales = state.sales
    .filter(isCustomerSale)
    .filter((sale) => matchesDateRangeFilter(sale.createdAt, dashboardSalesDateFilter));
  const todayWastes = state.sales
    .filter((sale) => getTransactionType(sale) === 'waste')
    .filter((sale) => matchesDateRangeFilter(sale.createdAt, getTodayFilter()));
  const salesTotal = filteredSales.reduce((total, sale) => total + Number(sale.totalAmount || 0), 0);
  const wasteQuantity = todayWastes.reduce((total, sale) => total + (sale.items || [])
    .reduce((itemsTotal, item) => itemsTotal + Number(item.quantity || 0), 0), 0);
  const debtTotal = state.customers.reduce((total, customer) => total + Math.max(0, Number(customer.balance || 0)), 0);
  const lowStockProducts = state.products.filter((product) => Number(product.stock || 0) <= getLowStockThreshold(product));

  summary.innerHTML = `
    <article class="dashboard-stat-card">
      <span>Factures aujourd’hui</span>
      <strong>${todaySales.length}</strong>
      <small>facture(s)</small>
    </article>
    <article class="dashboard-stat-card dashboard-sales-card">
      <span>Ventes aujourd’hui</span>
      </div><strong>${formatMoney(salesTotal)}</strong></div>
    </article>
    <article class="dashboard-stat-card">
      <span>Total dû</span>
      <strong>${formatMoney(debtTotal)}</strong>
      <small>dettes en cours</small>
    </article>
    <article class="dashboard-stat-card dashboard-low-stock-card">
      <span>Stock faible</span>
      <strong>${lowStockProducts.length}</strong>
      <small>produit(s) à réapprovisionner</small>
      <div class="dashboard-low-stock-list">${lowStockProducts.length
    ? lowStockProducts.map((product) => `<span>${escapeHtml(product.name)} · ${Number(product.stock || 0)}</span>`).join('')
    : '<span>Aucun produit concerné</span>'}</div>
    </article>
    <article class="dashboard-stat-card">
      <span>Pertes aujourd’hui</span>
      <strong>${wasteQuantity}</strong>
      <small>article(s) perdu(s)</small>
    </article>
    <article class="dashboard-stat-card">
      <span>Retours aujourd’hui</span>
      <strong>${todayReturns.length}</strong>
      <small>transaction(s)</small>
    </article>`;

  setupSharedDateFilter(document.getElementById('dashboard-sales-date-filter'), 'dashboard-sales', dashboardSalesDateFilter, (filter) => {
    dashboardSalesDateFilter = filter;
    renderDashboard();
  });

  const recent = [...state.sales]
    .filter((sale) => isCustomerSale(sale) || isReturn(sale))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10);
  history.innerHTML = recent.length ? recent.map((sale) => {
    const returning = isReturn(sale);
    const customer = sale.customerId ? getCustomerById(sale.customerId) : null;
    return `
      <div class="dashboard-transaction-row">
        <span><strong>${new Date(sale.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</strong><small>${returning ? 'Retour' : 'Vente'}</small></span>
        <span><strong>${customer ? escapeHtml(customer.name) : 'Client de passage'}</strong></span>
        <strong>${formatMoney(sale.totalAmount)}</strong>
        <span class="dashboard-transaction-status">${returning ? 'Retour' : getInvoiceStatus(sale)}</span>
      </div>`;
  }).join('') : '<p class="dashboard-empty">Aucune vente ou retour enregistré.</p>';
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
  const purchaseSummaryTotal = getCustomerPurchaseTotalForFilter(customer.id, customerDateFilter);
  const transactionHistoryRows = getCustomerTransactionHistoryForFilter(customer.id, customerDateFilter);

  container.innerHTML = `
    <div class="ledger-page">
      <div class="ledger-page-header">
        <button type="button" class="ledger-back-btn" data-client-back>← Clients</button>
        <div class="ledger-page-actions">
          <button type="button" class="secondary-btn compact-btn" data-edit-client>Modifier</button>
          <button type="button" class="link-btn danger-link" data-delete-client>Supprimer</button>
        </div>
      </div>
      <div class="ledger-entity-header">
        <div><p class="section-kicker">Profil client</p><h3>${escapeHtml(customer.name)}</h3><span class="subtle">${escapeHtml(customer.phone)}${customer.address ? ` · ${escapeHtml(customer.address)}` : ''}</span></div>
        <div class="ledger-entity-stats">
          <div class="customer-summary-card">
            <div class="customer-summary-header"><span>Total acheté</span></div>
            <div class="customer-summary-value-row"><div data-purchase-summary-filter class="shared-date-filter"></div><strong class="customer-summary-total">${formatMoney(purchaseSummaryTotal)}</strong></div>
          </div>
        </div>
      </div>
      <div class="ledger-section-heading">
        <h4>Historique des transactions</h4>
        <span>${plural(transactionHistoryRows.length, 'transaction')}</span>
      </div>
      <div class="ledger-table ledger-invoice-list">
        ${transactionHistoryRows.length ? transactionHistoryRows.map((invoice) => isReturn(invoice)
    ? `<button type="button" class="ledger-row invoice-ledger-row ledger-return-row" data-client-invoice-id="${invoice.id}"><span><strong>Retour n°${invoice.id.slice(-4)}</strong><small>${new Date(invoice.createdAt).toLocaleDateString('fr-FR')}</small></span><span><strong>${formatMoney(invoice.totalAmount)}</strong><small>Total du retour</small></span><span><strong>${invoice.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)}</strong><small>Article(s)</small></span><span class="ledger-remaining"><strong>&mdash;</strong><small>Reste à payer</small></span><span><b class="ledger-status ledger-status-return">Retour</b></span><span class="ledger-arrow">›</span></button>`
    : `<button type="button" class="ledger-row invoice-ledger-row" data-client-invoice-id="${invoice.id}"><span><strong>Facture n°${invoice.id.slice(-4)}</strong><small>${new Date(invoice.createdAt).toLocaleDateString('fr-FR')}</small></span><span><strong>${formatMoney(invoice.totalAmount)}</strong><small>Total</small></span><span><strong>${formatMoney(getInvoicePaidAmount(invoice))}</strong><small>Payé</small></span><span class="ledger-remaining"><strong>${formatMoney(getInvoiceRemainingAmount(invoice))}</strong><small>Reste à payer</small></span><span><b class="ledger-status ${getInvoiceRemainingAmount(invoice) <= 0 ? 'ledger-status-paid' : ''}">${getInvoiceStatus(invoice)}</b></span><span class="ledger-arrow">›</span></button>`
  ).join('') : '<p class="empty-state">Aucune transaction pour ce client.</p>'}
      </div>
    </div>
  `;

  setupSharedDateFilter(container.querySelector('[data-purchase-summary-filter]'), 'customer', customerDateFilter, (filter) => {
    customerDateFilter = filter;
    renderClientProfilePage(container, customer);
  });

  container.querySelector('[data-client-back]')?.addEventListener('click', () => navigateClient('/clients'));
  container.querySelector('[data-edit-client]')?.addEventListener('click', () => beginEditCustomer(customer.id));
  container.querySelector('[data-delete-client]')?.addEventListener('click', () => deleteCustomer(customer));
  container.querySelectorAll('[data-client-invoice-id]').forEach((button) => button.addEventListener('click', () => navigateClient(`/clients/${encodeURIComponent(customer.id)}/invoices/${encodeURIComponent(button.dataset.clientInvoiceId)}`)));
}

function renderClientInvoicePage(container, customer, invoiceId) {
  const invoice = state.sales.find((sale) => sale.id === invoiceId && sale.customerId === customer.id);
  if (!invoice) return navigateClient(`/clients/${encodeURIComponent(customer.id)}`);

  // A return is not an invoice: there is nothing paid, owed or settled on it.
  if (isReturn(invoice)) {
    container.innerHTML = `
      <div class="ledger-page ledger-invoice-page ledger-return-page">
        <div class="ledger-page-header"><button type="button" class="ledger-back-btn" data-client-back>← Profil de ${customer.name}</button><div class="ledger-page-actions"><button type="button" class="link-btn danger-link" data-delete-invoice>Supprimer le retour</button></div></div>
        <div class="ledger-entity-header"><div><p class="section-kicker">Détails du retour</p><h3>Retour n°${invoice.id.slice(-4)}</h3><span class="subtle">${new Date(invoice.createdAt).toLocaleString('fr-FR')} · ${customer.name} · ${customer.phone}</span></div><b class="ledger-status ledger-status-return">Retour</b></div>
        <table class="ledger-detail-items"><thead><tr><th>Produit</th><th>Quantité</th><th>Prix unitaire</th><th>Total</th></tr></thead><tbody>${invoice.items.map((item) => `<tr><td>${item.productName}</td><td>${item.quantity}</td><td>${formatMoney(item.unitPrice)}</td><td>${formatMoney(item.subtotal)}</td></tr>`).join('')}</tbody></table>
        <div class="ledger-financial-summary"><div><span>Total du retour</span><strong>${formatMoney(invoice.totalAmount)}</strong></div><div><span>Articles retournés</span><strong>${invoice.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)}</strong></div></div>
        <p class="ledger-view-only-note">Ce retour est une transaction indépendante. Il ne modifie aucune facture ni aucun solde client.</p>
      </div>
    `;
    container.querySelector('[data-client-back]')?.addEventListener('click', () => navigateClient(`/clients/${encodeURIComponent(customer.id)}`));
    container.querySelector('[data-delete-invoice]')?.addEventListener('click', () => openDeleteSaleConfirmation(invoice.id));
    return;
  }

  const payments = customer.debtHistory
    .filter((entry) => entry.type === 'payment' && entry.saleId === invoice.id)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const remaining = getInvoiceRemainingAmount(invoice);
  container.innerHTML = `
    <div class="ledger-page ledger-invoice-page">
      <div class="ledger-page-header"><button type="button" class="ledger-back-btn" data-client-back>← Profil de ${customer.name}</button><div class="ledger-page-actions"><button type="button" class="link-btn danger-link" data-delete-invoice>Supprimer la facture</button></div></div>
      <div class="ledger-entity-header"><div><p class="section-kicker">Détails de la facture</p><h3>Facture n°${invoice.id.slice(-4)}</h3><span class="subtle">${new Date(invoice.createdAt).toLocaleString('fr-FR')} · ${customer.name} · ${customer.phone}</span></div><b class="ledger-status ${getInvoiceRemainingAmount(invoice) <= 0 ? 'ledger-status-paid' : ''}">${getInvoiceStatus(invoice)}</b></div>
      <table class="ledger-detail-items"><thead><tr><th>Produit</th><th>Quantité</th><th>Prix unitaire</th><th>Total</th></tr></thead><tbody>${invoice.items.map((item) => `<tr><td>${item.productName}</td><td>${item.quantity}</td><td>${formatMoney(item.unitPrice)}</td><td>${formatMoney(item.subtotal)}</td></tr>`).join('')}</tbody></table>
      <div class="ledger-financial-summary">${invoice.discountPercent > 0 ? `<div><span>Remise (${invoice.discountPercent} %)</span><strong>-${formatMoney(invoice.discount)}</strong></div>` : ''}<div><span>Total de la facture</span><strong>${formatMoney(invoice.totalAmount)}</strong></div><div><span>Total payé</span><strong>${formatMoney(getInvoicePaidAmount(invoice))}</strong></div><div><span>Reste à payer</span><strong>${formatMoney(remaining)}</strong></div><div><span>Statut</span><strong>${getInvoiceStatus(invoice)}</strong></div></div>
      <div class="ledger-payment-history"><h4>Historique des paiements</h4>${payments.length ? payments.map((payment, index) => `<div><span><strong>Paiement ${index + 1}</strong><small>${new Date(payment.date).toLocaleDateString('fr-FR')}</small></span><strong>${formatMoney(payment.amount)}</strong></div>`).join('') : '<p class="empty-state">Aucun paiement enregistré pour cette facture.</p>'}</div>
      ${remaining > 0 ? `<button type="button" class="primary-btn" data-record-invoice-payment>Enregistrer un paiement</button>` : '<p class="ledger-paid-note">Facture entièrement réglée.</p>'}
    </div>
  `;
  container.querySelector('[data-client-back]')?.addEventListener('click', () => navigateClient(`/clients/${encodeURIComponent(customer.id)}`));
  container.querySelector('[data-record-invoice-payment]')?.addEventListener('click', () => openPaymentModal(customer.id, invoice.id));
  container.querySelector('[data-delete-invoice]')?.addEventListener('click', () => openDeleteSaleConfirmation(invoice.id));
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
// The VAT breakdown. Off while the shop charges no TVA, since it only ever
// printed a row of zeros.
const INVOICE_SHOWS_TAX_TABLE = false;
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

      <section class="inv-closing${INVOICE_SHOWS_TAX_TABLE ? '' : ' inv-closing-no-tax'}">
        ${INVOICE_SHOWS_TAX_TABLE ? `
        <table class="inv-tax">
          <thead>
            <tr><th>CODE</th><th>BASE<small>${INVOICE_CURRENCY}</small></th><th>TAUX</th><th>MONTANT<small>${INVOICE_CURRENCY}</small></th></tr>
          </thead>
          <tbody>
            <tr><td>Total</td><td>0</td><td>0</td><td>0</td></tr>
          </tbody>
        </table>` : ''}

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
let isDeletingSale = false;

function openDeleteSaleConfirmation(saleId) {
  const sale = state.sales.find((entry) => entry.id === saleId);
  if (!sale) return;
  const customer = getCustomerById(sale.customerId);
  pendingDeleteSaleId = saleId;
  const who = customer ? customer.name : 'le client de passage';
  const units = plural(sale.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0), 'article');
  const number = sale.id.slice(-4);
  document.getElementById('delete-sale-title').textContent = isReturn(sale) ? `Supprimer le retour n°${number} ?` : `Supprimer la facture n°${number} ?`;
  document.getElementById('delete-sale-text').textContent = isReturn(sale)
    ? `Le retour de ${formatMoney(sale.totalAmount)} pour ${who} sera supprimé. Les ${units} remis en stock par ce retour en seront retirés.`
    : `La facture de ${formatMoney(sale.totalAmount)} pour ${who} sera supprimée. Les ${units} vendus retourneront en stock, et les totaux et dettes du client seront rétablis.`;
  document.getElementById('confirm-delete-sale-btn').textContent = isReturn(sale) ? 'Supprimer le retour' : 'Supprimer la facture';
  document.getElementById('delete-sale-modal').classList.remove('hidden');
}

function closeDeleteSaleConfirmation() {
  pendingDeleteSaleId = null;
  document.getElementById('delete-sale-modal').classList.add('hidden');
}

async function confirmDeleteSale() {
  // A second click while the first delete is in flight would only come back as
  // "Transaction introuvable", so it is not sent at all.
  if (!pendingDeleteSaleId || isDeletingSale) return;
  const sale = state.sales.find((entry) => entry.id === pendingDeleteSaleId);
  if (!sale) return;

  const returning = isReturn(sale);
  const button = document.getElementById('confirm-delete-sale-btn');
  isDeletingSale = true;
  button.disabled = true;
  try {
    const saved = await mutate(`/sales/${sale.id}`, 'DELETE', null, () => {
      state.sales = state.sales.filter((entry) => entry.id !== sale.id);
    });
    if (saved === null) return;
    closeDeleteSaleConfirmation();
    closeReceipt();
    setSaveStatus('saved', returning ? 'Retour supprimé. Le stock a été corrigé.' : 'Facture supprimée. Les articles sont revenus en stock.');
  } finally {
    isDeletingSale = false;
    button.disabled = false;
  }
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
  const saved = await submitOnce(event.target, () => (editingProductId
    ? mutate(`/products/${editingProductId}`, 'PUT', payload)
    : mutate('/products', 'POST', { ...payload, stock: startingStock })));
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

  const saved = await submitOnce(event.target, () => (editingCustomerId
    ? mutate(`/customers/${editingCustomerId}`, 'PUT', payload)
    : mutate('/customers', 'POST', payload)));
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

let payingCustomerId = null;
let payingInvoiceId = null;
let isSavingPayment = false;
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

// --- Paiement d’une dette -------------------------------------------------
// A payment is entered against a customer's whole balance, not one invoice: the
// shop takes what is handed over and it comes off the running tab. The server
// splits it across their unpaid invoices oldest first; previewAllocation() below
// shows the operator that same split before they commit to it.

// The split the server is about to make, computed from the same rule so the
// preview and the result cannot disagree. Oldest invoice first.
function previewAllocation(customerId, amount) {
  const invoices = getCustomerCreditInvoices(customerId, true)
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const slices = [];
  let left = amount;
  for (const invoice of invoices) {
    if (left <= 0) break;
    const remaining = getInvoiceRemainingAmount(invoice);
    const part = Math.min(left, remaining);
    if (part <= 0) continue;
    slices.push({ invoice, amount: part, settles: part >= remaining });
    left -= part;
  }
  return slices;
}

function openPaymentModal(customerId, invoiceId) {
  const customer = getCustomerById(customerId);
  const invoice = state.sales.find((sale) => sale.id === invoiceId && sale.customerId === customerId);
  if (!customer || !invoice || getInvoiceRemainingAmount(invoice) <= 0) return;

  payingCustomerId = customer.id;
  payingInvoiceId = invoice.id;
  document.getElementById('payment-modal-customer').textContent = `${customer.name} · Facture n°${invoice.id.slice(-4)}`;
  document.getElementById('payment-outstanding').textContent = formatMoney(getInvoiceRemainingAmount(invoice));

  const input = document.getElementById('payment-amount');
  input.value = '';
  input.max = getInvoiceRemainingAmount(invoice);
  document.getElementById('payment-date').value = toDateInputValue(new Date());
  showMessage('payment-message', '', '');

  document.getElementById('payment-modal').classList.remove('hidden');
  input.focus();
}

function closePaymentModal() {
  payingCustomerId = null;
  payingInvoiceId = null;
  document.getElementById('payment-form').reset();
  showMessage('payment-message', '', '');
  document.getElementById('payment-modal').classList.add('hidden');
}

function renderPaymentAllocation() {
  const list = document.getElementById('payment-allocation-list');
  if (!list || !payingCustomerId) return;

  const customer = getCustomerById(payingCustomerId);
  const amount = Number(document.getElementById('payment-amount')?.value || 0);

  if (!Number.isFinite(amount) || amount <= 0) {
    list.innerHTML = '<p class="empty-state">Saisissez un montant pour voir les factures qu’il règle.</p>';
    return;
  }
  if (amount > Number(customer?.balance || 0)) {
    list.innerHTML = `<p class="empty-state">Le montant dépasse la dette en cours (${formatMoney(customer?.balance)}).</p>`;
    return;
  }

  const slices = previewAllocation(payingCustomerId, amount);
  list.innerHTML = slices.map((slice) => `
    <div class="payment-allocation-row">
      <div>
        <strong>Facture n°${escapeHtml(slice.invoice.id.slice(-4))}</strong>
        <small>${new Date(slice.invoice.createdAt).toLocaleDateString('fr-FR')}</small>
      </div>
      <span class="mini-pill ${slice.settles ? 'success' : 'warning'}">${slice.settles ? 'Soldée' : 'Partiel'}</span>
      <strong class="payment-allocation-amount">${formatMoney(slice.amount)}</strong>
    </div>
  `).join('');
}

async function handlePaymentSubmit(event) {
  event.preventDefault();
  if (!payingCustomerId || !payingInvoiceId || isSavingPayment) return;

  const customer = getCustomerById(payingCustomerId);
  const invoice = state.sales.find((sale) => sale.id === payingInvoiceId);
  const amount = Number(document.getElementById('payment-amount').value);
  const date = document.getElementById('payment-date').value;

  if (!customer || !invoice || !Number.isFinite(amount) || amount <= 0) {
    showMessage('payment-message', 'Saisissez un montant supérieur à 0.', 'error');
    return;
  }
  const remaining = getInvoiceRemainingAmount(invoice);
  if (amount > remaining) {
    showMessage('payment-message', `Le paiement ne peut pas dépasser le reste à payer (${formatMoney(remaining)}).`, 'error');
    return;
  }
  if (!date) {
    showMessage('payment-message', 'La date du paiement est obligatoire.', 'error');
    return;
  }

  const button = document.getElementById('confirm-payment-btn');
  isSavingPayment = true;
  if (button) button.disabled = true;
  const saved = await mutate(`/sales/${invoice.id}/payments`, 'POST', { amount, date });
  isSavingPayment = false;
  if (button) button.disabled = false;
  if (saved === null) return;

  closePaymentModal();
  if (Number(saved.customer?.balance || 0) <= 0) {
    clientListScope = 'debtors';
    navigateClient('/clients');
  }
  setSaveStatus('saved', `Paiement de ${formatMoney(amount)} enregistré pour la facture n°${invoice.id.slice(-4)}.`);
}

const EMPTY_CART_ERRORS = {
  sale: 'Ajoutez au moins un produit à la vente.',
  return: 'Ajoutez au moins un produit au retour.'
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
  // The flag is set and the button disabled before the first await, so a second
  // click while the save is in flight cannot record the transaction twice.
  // pendingSale itself is only cleared once the server has answered.
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

// Resets the register after any completed transaction.
// Puts the register back to the state it starts the day in. Every field is named
// here rather than only the cart array, because the previous version emptied the
// array without repainting -- so a finished sale left its items and total sitting
// on screen, inviting exactly the second click this prevents.
function clearPos() {
  cart = [];
  saleDiscountPercent = 0;
  selectedPosCustomerId = null;

  const setValue = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  setValue('pos-product-search', '');
  setValue('pos-customer-search', '');
  setValue('sale-discount-percent', 0);
  setValue('payment-method-select', 'cash');
  setValue('partial-payment-amount', '');
  setValue('new-customer-name', '');
  setValue('new-customer-phone', '');
  setValue('new-customer-address', '');

  const hide = (id) => document.getElementById(id)?.classList.add('hidden');
  hide('new-customer-fields');
  hide('pos-customer-suggestions');

  closeSaleConfirmation();
  updatePosPaymentFields();
  renderPosProducts();
  renderCart();
}

// An independent Retour transaction: it never links to the original invoice.
// The money is settled against whatever the customer still owes, and the server
// says how much of it had to come out of the till.
async function confirmReturn() {
  const { customerId, items } = pendingSale;
  const saved = await mutate('/sales', 'POST', {
    type: 'return',
    customerId,
    items: items.map((item) => ({ productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice }))
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

async function confirmSaleTransaction() {
  const { customerId, paymentMethod, partialAmount, items } = pendingSale;
  const saved = await mutate('/sales', 'POST', {
    type: 'sale',
    customerId,
    paymentType: paymentMethod,
    partialAmount: paymentMethod === 'partial' ? partialAmount : 0,
    discountPercent: saleDiscountPercent,
    // The price on each cart line, as the cashier left it, is what gets charged.
    items: items.map((item) => ({ productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice }))
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
let purchaseHistoryFilters = { mode: 'all', start: '', end: '', productId: 'all' };
let editingPurchaseId = null;

function getPurchaseTotal() {
  return purchaseCart.reduce((total, item) => total + item.quantity * item.unitPrice, 0);
}

function renderPurchaseProducts() {
  const container = document.getElementById('purchase-product-list');
  if (!container) return;
  const search = document.getElementById('purchase-product-search')?.value?.toLowerCase() || '';
  const list = search ? state.products.filter((product) => product.name.toLowerCase().includes(search)).slice(0, 30) : [];

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
    : search ? '<div class="empty-cart"><strong>Aucun produit trouvé</strong></div>' : '';

  container.querySelectorAll('[data-add-purchase]').forEach((button) => {
    button.addEventListener('click', () => addToPurchase(button.dataset.addPurchase));
  });
}

function closePurchaseProductOptions() {
  const container = document.getElementById('purchase-product-list');
  if (container) container.innerHTML = '';
}

function addToPurchase(productId) {
  const product = getProductById(productId);
  if (!product) return;
  const existing = purchaseCart.find((item) => item.productId === productId);
  purchaseCart = [{ productId, productName: product.name, quantity: purchaseCart[0]?.quantity || 1, unitPrice: 0 }];
  document.getElementById('purchase-product-search').value = product.name;
  document.getElementById('clear-purchase-product')?.classList.remove('hidden');
  document.getElementById('purchase-product-list').innerHTML = '';
  renderPurchaseCart();
}

function clearPurchaseProduct() {
  purchaseCart = [];
  const search = document.getElementById('purchase-product-search');
  if (search) search.value = '';
  document.getElementById('clear-purchase-product')?.classList.add('hidden');
  document.getElementById('purchase-product-list').innerHTML = '';
  renderPurchaseCart();
  search?.focus();
}

function renderPurchaseCart() {
  const container = document.getElementById('purchase-cart-items');
  if (!container) return;
  if (!purchaseCart.length) {
    container.innerHTML = '<div class="empty-cart"><strong>Aucun produit sélectionné</strong><p>Recherchez puis sélectionnez un produit.</p></div>';
    return;
  }

  container.innerHTML = purchaseCart.map((item) => `
    <div class="cart-row">
      <div class="cart-product-name"><strong>${escapeHtml(item.productName)}</strong></div>
      <label class="cart-quantity-field">
        <span>Quantité à ajouter</span>
        <input data-purchase-qty="${item.productId}" type="number" min="1" step="1" value="${item.quantity}" />
      </label>
      <button class="link-btn cart-remove-btn" data-purchase-remove="${item.productId}">Changer</button>
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

  container.querySelectorAll('[data-purchase-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      purchaseCart = purchaseCart.filter((entry) => entry.productId !== button.dataset.purchaseRemove);
      renderPurchaseCart();
    });
  });

}

async function createProductFromPurchase() {
  const nameField = document.getElementById('new-purchase-product-name');
  const priceField = document.getElementById('new-purchase-product-price');
  const name = nameField.value.trim();
  const sellingPrice = Number(priceField.value);

  if (!name) {
    showMessage('purchase-message', 'Le nom du produit est obligatoire.', 'error');
    return;
  }
  if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
    showMessage('purchase-message', 'Indiquez le prix de vente du produit.', 'error');
    return;
  }

  // The catalogue is uniquely named server-side, but mutate() reports failures on
  // the global save indicator rather than here, so a refusal would leave the last
  // success message sitting under the form. Caught here, next to the field.
  const clash = state.products.find((product) =>
    product.name.trim().toLowerCase() === name.toLowerCase());
  if (clash) {
    showMessage('purchase-message', `« ${clash.name} » existe déjà dans le catalogue. Ajoutez-le depuis la liste.`, 'error');
    return;
  }

  // Created with no stock: the units arrive through this purchase, so that the
  // delivery is what puts them on the shelf and is recorded as having done so.
  showMessage('purchase-message', '', 'info');
  const saved = await mutate('/products', 'POST', {
    name,
    sellingPrice,
    stock: 0,
    lowStockThreshold: 10,
    description: ''
  });
  if (saved === null) {
    showMessage('purchase-message', 'Le produit n’a pas pu être créé. Vérifiez le nom et réessayez.', 'error');
    return;
  }

  nameField.value = '';
  priceField.value = '';
  document.getElementById('new-purchase-product-fields').classList.add('hidden');
  addToPurchase(saved.product.id);
  showMessage('purchase-message', `${saved.product.name} a été créé et ajouté à l’achat.`, 'success');
}

function renderPurchases() {
  renderPurchaseProducts();
  renderPurchaseCart();
  const historySearch = document.getElementById('purchase-history-product-search');
  const selectedProduct = purchaseHistoryFilters.productId !== 'all' ? getProductById(purchaseHistoryFilters.productId) : null;
  if (historySearch && document.activeElement !== historySearch) historySearch.value = selectedProduct?.name || '';
  document.getElementById('clear-purchase-history-product')?.classList.toggle('hidden', !selectedProduct);
  renderPurchaseHistory();
}

function getPurchaseHistoryRows() {
  return state.sales
    .filter((sale) => getTransactionType(sale) === 'purchase')
    .filter((sale) => matchesDateRangeFilter(sale.createdAt, purchaseHistoryFilters))
    .filter((sale) => purchaseHistoryFilters.productId === 'all' || sale.items?.some((item) => item.productId === purchaseHistoryFilters.productId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function renderPurchaseHistory() {
  const list = document.getElementById('purchase-history-list');
  if (!list) return;
  const rows = getPurchaseHistoryRows();
  const count = document.getElementById('purchase-history-count');
  if (count) count.textContent = plural(rows.length, 'achat');
  list.innerHTML = rows.length ? rows.map((sale) => {
    const units = sale.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const total = Number(sale.totalAmount || 0);
    const products = sale.items.map((item) => `${escapeHtml(item.productName)}`).join('<br>');
    return `<article class="purchase-history-row" data-purchase-row="${sale.id}">
      <div class="purchase-history-date"><span>Date</span><strong>${new Date(sale.createdAt).toLocaleDateString('fr-FR')}</strong></div>
      <div class="purchase-history-product"><span>Produit</span><strong>${products}</strong></div>
      <div class="purchase-history-quantity"><span>Quantité ajoutée</span><strong>${units}</strong><small>article${units > 1 ? 's' : ''}</small></div>
      <div class="purchase-history-actions"><button type="button" class="link-btn" data-purchase-view="${sale.id}">Voir</button><button type="button" class="link-btn" data-purchase-edit="${sale.id}">Modifier</button><button type="button" class="link-btn danger-link" data-purchase-delete="${sale.id}">Supprimer</button></div>
    </article>`;
  }).join('') : '<div class="empty-state-block"><strong>Aucun achat enregistré</strong><p>Les ajouts au stock apparaîtront ici.</p></div>';
  list.querySelectorAll('[data-purchase-view]').forEach((button) => button.addEventListener('click', () => {
    const sale = state.sales.find((entry) => entry.id === button.dataset.purchaseView);
    if (sale) window.alert(`${sale.items.map((item) => `${item.productName} · ${item.quantity}`).join('\n')}\n${new Date(sale.createdAt).toLocaleDateString('fr-FR')}`);
  }));
  list.querySelectorAll('[data-purchase-edit]').forEach((button) => button.addEventListener('click', () => openPurchaseEditor(button.dataset.purchaseEdit)));
  list.querySelectorAll('[data-purchase-delete]').forEach((button) => button.addEventListener('click', () => deletePurchase(button.dataset.purchaseDelete)));
}

function renderPurchaseHistoryProductOptions(query = '') {
  const options = document.getElementById('purchase-history-product-options');
  const input = document.getElementById('purchase-history-product-search');
  if (!options || !input) return;
  const matches = state.products.filter((product) => product.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 30);
  options.innerHTML = matches.length
    ? matches.map((product) => `<button type="button" class="pertes-product-option" data-purchase-product-id="${product.id}">${escapeHtml(product.name)}</button>`).join('')
    : '<p class="pertes-product-empty">Aucun produit trouvé.</p>';
  options.classList.remove('hidden');
  input.setAttribute('aria-expanded', 'true');
}

function clearPurchaseHistoryProduct() {
  purchaseHistoryFilters.productId = 'all';
  document.getElementById('purchase-history-product-search').value = '';
  document.getElementById('clear-purchase-history-product')?.classList.add('hidden');
  document.getElementById('purchase-history-product-options')?.classList.add('hidden');
  renderPurchaseHistory();
}

function closePurchaseHistoryProductOptions() {
  const options = document.getElementById('purchase-history-product-options');
  const input = document.getElementById('purchase-history-product-search');
  options?.classList.add('hidden');
  input?.setAttribute('aria-expanded', 'false');
}

async function deletePurchase(purchaseId) {
  if (!window.confirm('Supprimer cet ajout au stock ? Le stock sera restauré.')) return;
  const saved = await mutate(`/sales/${purchaseId}`, 'DELETE');
  if (saved !== null) renderPurchases();
}

function openPurchaseEditor(purchaseId = null) {
  const sale = purchaseId ? state.sales.find((entry) => entry.id === purchaseId && getTransactionType(entry) === 'purchase') : null;
  editingPurchaseId = sale?.id || null;
  const item = sale?.items?.[0];
  purchaseCart = item ? [{ productId: item.productId, productName: item.productName, quantity: item.quantity, unitPrice: 0 }] : [];
  document.getElementById('purchase-product-search').value = item?.productName || '';
  document.getElementById('clear-purchase-product')?.classList.toggle('hidden', !item);
  document.getElementById('purchase-quantity').value = item?.quantity || 1;
  document.getElementById('purchase-date').value = sale?.createdAt ? toDateInputValue(new Date(sale.createdAt)) : toDateInputValue(new Date());
  document.getElementById('purchase-editor-title').textContent = sale ? 'Modifier l’ajout au stock' : 'Ajouter au stock';
  showMessage('purchase-message', '', '');
  renderPurchaseProducts();
  if (item) document.getElementById('purchase-product-list').innerHTML = '';
  renderPurchaseCart();
  document.getElementById('purchase-editor-modal').classList.remove('hidden');
  document.getElementById('purchase-product-search').focus();
}

function closePurchaseEditor() {
  purchaseCart = [];
  editingPurchaseId = null;
  document.getElementById('clear-purchase-product')?.classList.add('hidden');
  document.getElementById('purchase-editor-modal')?.classList.add('hidden');
}

async function completePurchase() {
  if (isSavingPurchase) return;
  const quantity = Number(document.getElementById('purchase-quantity')?.value || 0);
  if (!purchaseCart.length || !Number.isInteger(quantity) || quantity <= 0) {
    showMessage('purchase-message', 'Sélectionnez un produit et indiquez une quantité valide.', 'error');
    return;
  }

  isSavingPurchase = true;
  const button = document.getElementById('complete-purchase-btn');
  if (button) button.disabled = true;

  try {
    // A purchase's unit price is what the shop paid; this form does not ask for
    // it, so the cost is recorded as 0.
    const payload = { type: 'purchase', date: document.getElementById('purchase-date')?.value || '', items: [{ productId: purchaseCart[0].productId, quantity, unitPrice: 0 }] };
    const saved = editingPurchaseId
      ? await mutate(`/sales/${editingPurchaseId}`, 'PUT', payload)
      : await mutate('/sales', 'POST', payload);
    if (saved === null) return;

    purchaseCart = [];
    renderPurchases();
    closePurchaseEditor();
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
  const next = scope === 'purchases' ? 'purchases' : scope === 'pertes' ? 'pertes' : 'catalogue';
  document.querySelectorAll('[data-stock-scope]').forEach((button) => {
    const active = button.dataset.stockScope === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.getElementById('stock-catalogue')?.classList.toggle('hidden', next !== 'catalogue');
  document.getElementById('stock-purchases')?.classList.toggle('hidden', next !== 'purchases');
  document.getElementById('stock-pertes')?.classList.toggle('hidden', next !== 'pertes');
  const showAddProduct = next === 'catalogue';
  document.getElementById('add-product-btn')?.classList.toggle('hidden', !showAddProduct);
  document.getElementById('pertes-btn')?.classList.toggle('active', next === 'pertes');
  if (next === 'pertes') {
    if (!pertesFilters.productId) pertesFilters.productId = 'all';
    renderWasteView();
  }
}

function setupPurchaseListeners() {
  setupSharedDateFilter(document.getElementById('purchase-date-filter'), 'purchases', purchaseHistoryFilters, (filter) => {
    purchaseHistoryFilters = { ...purchaseHistoryFilters, ...filter };
    renderPurchaseHistory();
  });
  document.getElementById('purchase-history-product-search')?.addEventListener('focus', (event) => renderPurchaseHistoryProductOptions(event.target.value));
  document.getElementById('purchase-history-product-search')?.addEventListener('input', (event) => {
    purchaseHistoryFilters.productId = 'all';
    document.getElementById('clear-purchase-history-product')?.classList.add('hidden');
    renderPurchaseHistoryProductOptions(event.target.value);
  });
  document.getElementById('purchase-history-product-options')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-purchase-product-id]');
    if (!option) return;
    purchaseHistoryFilters.productId = option.dataset.purchaseProductId;
    document.getElementById('purchase-history-product-search').value = getProductById(option.dataset.purchaseProductId)?.name || '';
    document.getElementById('clear-purchase-history-product')?.classList.remove('hidden');
    document.getElementById('purchase-history-product-options').classList.add('hidden');
    renderPurchaseHistory();
  });
  document.getElementById('clear-purchase-history-product')?.addEventListener('click', clearPurchaseHistoryProduct);
  document.addEventListener('click', (event) => {
    const picker = document.getElementById('purchase-history-product-picker');
    if (picker && !picker.contains(event.target)) closePurchaseHistoryProductOptions();
  });
  document.getElementById('clear-purchase-product')?.addEventListener('click', clearPurchaseProduct);
  document.getElementById('open-purchase-editor')?.addEventListener('click', openPurchaseEditor);
  document.getElementById('close-purchase-editor')?.addEventListener('click', closePurchaseEditor);
  document.getElementById('cancel-purchase-editor')?.addEventListener('click', closePurchaseEditor);
  document.getElementById('purchase-editor-modal')?.addEventListener('click', (event) => {
    if (event.target.id === 'purchase-editor-modal') closePurchaseEditor();
  });
  document.getElementById('toggle-new-purchase-product-btn')?.addEventListener('click', () => {
    const fields = document.getElementById('new-purchase-product-fields');
    fields.classList.toggle('hidden');
    if (!fields.classList.contains('hidden')) document.getElementById('new-purchase-product-name').focus();
  });
  document.getElementById('create-product-from-purchase')?.addEventListener('click', createProductFromPurchase);
  document.querySelectorAll('[data-stock-scope]').forEach((button) => {
    button.addEventListener('click', () => setStockScope(button.dataset.stockScope));
  });
  document.getElementById('purchase-product-search')?.addEventListener('input', renderPurchaseProducts);
  document.addEventListener('click', (event) => {
    const selector = document.querySelector('.purchase-selector-block');
    if (selector && !selector.contains(event.target)) closePurchaseProductOptions();
  });
  document.getElementById('complete-purchase-btn')?.addEventListener('click', completePurchase);
}

// --- Rapports ---------------------------------------------------------------
// Everything that moved in a day or a period, on one timeline: sales, purchases,
// returns, write-offs and stock corrections.
//
// Expenses are managed in their own tab and no longer appear as rows here, but
// they are still money out of the till, so summariseReport() keeps counting them
// in Décaissé and in the net. It reads state.expenses directly for that rather
// than going through the rows.
//
// Computed in the browser from `state`, because /api/state already ships every
// transaction on load and the dashboard, the history and the expenses page all
// filter the same way. That holds for a few thousand transactions; past that this
// wants to become a server-side aggregate over a date range.

// Label, sign against the till, and which side of the stock ledger each type sits
// on. `cash` is what the type does to money actually in the drawer.
const REPORT_TYPES = {
  sale: { label: 'Vente', stock: 'out', chip: 'sale' },
  purchase: { label: 'Achat', stock: 'in', chip: 'purchase' },
  return: { label: 'Retour', stock: 'in', chip: 'return' },
  waste: { label: 'Perte', stock: 'out', chip: 'waste' },
  adjustment: { label: 'Ajustement +', stock: 'in', chip: 'adjustment' },
  adjustment_out: { label: 'Ajustement −', stock: 'out', chip: 'adjustment' }
};

// Which transaction types each filter chip lets through. 'money' is the cash view:
// only the types that move money in or out of the till.
const REPORT_CATEGORIES = {
  all: ['sale', 'return'],
  sale: ['sale'],
  return: ['return']
};

let reportFilters = { mode: 'day', day: '', start: '', end: '', preset: 'today', category: 'all', customerId: '' };

// The date filter this page is currently describing, in the shape the shared
// matchesDateRangeFilter() helper expects.
function getReportFilter() {
  if (reportFilters.mode === 'day') {
    const day = reportFilters.day || toDateInputValue(new Date());
    return { mode: 'day', start: day, end: day, preset: reportFilters.preset };
  }
  return getDateFilterMode(reportFilters.start, reportFilters.end) === 'all'
    ? { mode: 'all', start: '', end: '', preset: '' }
    : { mode: getDateFilterMode(reportFilters.start, reportFilters.end), start: reportFilters.start, end: reportFilters.end, preset: reportFilters.preset };
}

// An expense carries a plain calendar day rather than a timestamp, so it is
// compared as one: midday keeps it inside its own day in every timezone.
function expenseWithinFilter(expense, filter) {
  return matchesDateRangeFilter(`${expense.date}T12:00:00`, filter);
}

// The expenses a date filter covers, newest first. Shared by the Dépenses tab and
// by the report's Décaissé total, so the two can never disagree.
function getExpensesForFilter(filter, type = 'all') {
  return state.expenses
    .filter((expense) => expenseWithinFilter(expense, filter))
    .filter((expense) => type === 'all' || (expense.type || 'Autre') === type)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// What the Détail column names: the counterparty for a sale, the supplier for a
// delivery, and for the types that have neither, what actually happened.
function reportRowParty(type, sale, customer) {
  if (type === 'purchase') return sale.supplier || 'Fournisseur non précisé';
  if (type === 'waste') return sale.reason || 'Autre';
  if (type === 'adjustment' || type === 'adjustment_out') return 'Correction de stock';
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
      detail: type.startsWith('adjustment') && sale.reason ? sale.reason : '',
      units: sale.items.reduce((total, item) => total + Number(item.quantity || 0), 0),
      amount: Number(sale.totalAmount || 0),
      sale
    });
  }

  return rows.sort((a, b) => new Date(b.at) - new Date(a.at));
}

// Debt payments are their own money event: they are cash arriving later for a
// sale that was booked earlier, so they are counted on the day they were paid.
function getReportPayments(filter) {
  const payments = [];
  for (const customer of state.customers) {
    // Sale rows already drop out when the report is narrowed to one customer, so
    // without this Encaisse credited them with everyone else's payments too.
    if (reportFilters.customerId && customer.id !== reportFilters.customerId) continue;
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

  // Expenses have no rows on this page any more, and no customer either -- so
  // narrowing the report to one customer takes them out of the totals, exactly as
  // it did when they were rows the filter dropped.
  const expenseValue = 0;

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
  const cashOut = totalFor('purchase') + refundCash;

  return {
    cashIn,
    cashOut,
    net: cashIn - cashOut,
    salesValue: totalFor('sale'),
    purchaseValue: totalFor('purchase'),
    returnValue: totalFor('return'),
    wasteValue: totalFor('waste'),
    expenseValue,
    unitsSold: unitsFor('sale'),
    unitsBought: unitsFor('purchase'),
    unitsReturned: unitsFor('return'),
    unitsWasted: unitsFor('waste'),
    unitsAdjusted: unitsFor('adjustment') - unitsFor('adjustment_out'),
    totalDue: rows
      .filter((row) => row.type === 'sale')
      .reduce((sum, row) => sum + getInvoiceRemainingAmount(row.sale), 0),
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
    ['Décaissé', formatMoney(summary.cashOut), 'Achats et remboursements'],
    ['Solde net', formatMoney(summary.net), summary.net >= 0 ? 'Excédent sur la période' : 'Déficit sur la période'],
    ['Total dû', formatMoney(summary.owedNow), 'Dettes clients en cours, toutes périodes'],
    ['Stock faible', summary.lowStockNow, summary.lowStockNow ? 'Produits à réapprovisionner' : 'Stock suffisant partout']
  ];
  const stock = [
    ['Vendus', summary.unitsSold, formatMoney(summary.salesValue)],
    ['Achetés', summary.unitsBought, formatMoney(summary.purchaseValue)],
    ['Retournés', summary.unitsReturned, formatMoney(summary.returnValue)],
    ['Perdus', summary.unitsWasted, 'Stock uniquement'],
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
  if (row.type !== 'sale') return '<span class="mini-pill report-pill-return">Retour</span>';
  const credit = row.sale?.paymentMethod === 'debt';
  const label = credit ? (row.sale?.paymentType === 'partial' ? getInvoiceStatus(row.sale) : 'Crédit') : 'Espèces';
  return `<span class="mini-pill ${credit ? 'warning' : 'success'}">${label}</span>`;
}

// Which row actions a movement offers. A purchase or a correction has no invoice
// to show.
function reportRowActions(row) {
  if (row.type === 'sale' || row.type === 'return') {
    return `<button class="link-btn" data-report-view="${row.id}">Voir</button><button class="link-btn danger-link" data-report-delete="${row.id}">Supprimer</button>`;
  }
  return '';
}

function reportTable(rows) {
  if (!rows.length) {
    return `
      <div class="card">
        <div class="empty-state-block">
          <strong>Aucun mouvement sur cette période</strong>
          <p>Changez la date, le client ou la catégorie pour voir d’autres transactions.</p>
        </div>
      </div>`;
  }

  return `
    <div class="card">
      <div class="table-wrap report-table-wrap">
        <table class="report-table">
          <thead>
            <tr>
              <th>Date</th><th>Type</th><th>Facture / reçu</th><th>Client</th>
              <th class="report-num">Total</th><th>Statut</th>
              <th class="row-actions-head" aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => {
    const meta = REPORT_TYPES[row.type];
    const when = new Date(row.at);
    const stamp = when.toLocaleDateString('fr-FR');
    const documentLabel = row.type === 'return' ? `Retour n°${row.id.slice(-4)}` : `Facture n°${row.id.slice(-4)}`;
    return `
              <tr class="report-row report-row-${meta.chip}">
                <td>${stamp}</td>
                <td><span class="mini-pill report-pill-${meta.chip}">${meta.label}</span></td>
                <td><strong>${documentLabel}</strong></td>
                <td>${escapeHtml(row.party)}</td>
                <td class="report-num">${formatMoney(row.amount)}</td>
                <td>${reportSettlement(row)}</td>
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

  // A customer deleted while selected has no sales left under their id, so the
  // filter lets go of them rather than showing an empty report for nobody.
  if (reportFilters.customerId && !getCustomerById(reportFilters.customerId)) reportFilters.customerId = '';
  syncReportCustomerField();

  const rows = getReportRows();
  const summary = summariseReport(rows);
  const customer = getReportCustomer();

  container.innerHTML = `
    <p class="report-period">${escapeHtml(reportPeriodLabel())}${customer ? ` · ${escapeHtml(customer.name)}` : ''} · ${plural(summary.count, 'mouvement')}</p>
    <div class="report-totals" aria-label="Totaux de la période">
      <div class="report-total"><span>Total des ventes</span><strong>${formatMoney(summary.salesValue)}</strong></div>
      <div class="report-total"><span>Total dû</span><strong>${formatMoney(summary.totalDue)}</strong></div>
    </div>
    ${reportTable(rows)}`;

  const bind = (attribute, handler) => container.querySelectorAll(`[${attribute}]`).forEach((button) => {
    button.addEventListener('click', () => handler(button.getAttribute(attribute)));
  });
  bind('data-report-view', openReceipt);
  bind('data-report-delete', openDeleteSaleConfirmation);
}

function getReportCustomer() {
  return reportFilters.customerId ? getCustomerById(reportFilters.customerId) : null;
}

// The box shows the chosen customer's name, except while it is being typed in.
function syncReportCustomerField() {
  const input = document.getElementById('report-customer-search');
  const customer = getReportCustomer();
  if (input && document.activeElement !== input) input.value = customer?.name || '';
  document.getElementById('clear-report-customer')?.classList.toggle('hidden', !customer);
}

function renderReportCustomerOptions(query = '') {
  const options = document.getElementById('report-customer-options');
  const input = document.getElementById('report-customer-search');
  if (!options || !input) return;
  const normalizedQuery = query.trim().toLowerCase();
  const matches = state.customers
    .filter((customer) => `${customer.name} ${customer.phone}`.toLowerCase().includes(normalizedQuery))
    .slice(0, 30);
  options.innerHTML = matches.length
    ? matches.map((customer) => `<button type="button" class="pertes-product-option report-customer-option" role="option" data-report-customer-id="${customer.id}"><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.phone)}</small></button>`).join('')
    : '<p class="pertes-product-empty">Aucun client trouvé.</p>';
  options.classList.remove('hidden');
  input.setAttribute('aria-expanded', 'true');
}

function closeReportCustomerOptions() {
  document.getElementById('report-customer-options')?.classList.add('hidden');
  document.getElementById('report-customer-search')?.setAttribute('aria-expanded', 'false');
}

function selectReportCustomer(customerId) {
  if (!getCustomerById(customerId)) return;
  reportFilters.customerId = customerId;
  closeReportCustomerOptions();
  document.getElementById('report-customer-search')?.blur();
  renderReports();
}

function clearReportCustomer() {
  reportFilters.customerId = '';
  const input = document.getElementById('report-customer-search');
  if (input) input.value = '';
  closeReportCustomerOptions();
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
  const customer = getReportCustomer();

  const lines = [
    ['Total des ventes', formatMoney(summary.salesValue)],
    ['Total dû', formatMoney(summary.totalDue)],
    ['Retours', `${summary.unitsReturned} art. · ${formatMoney(summary.returnValue)}`],
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
          ${customer ? `<div><span>CLIENT</span><strong>${escapeHtml(customer.name)}</strong></div>` : ''}
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
  setupSharedDateFilter(document.getElementById('report-shared-date-filter'), 'report', getReportFilter(), (filter) => {
    reportFilters.mode = filter.mode === 'day' ? 'day' : 'range';
    reportFilters.day = filter.start;
    reportFilters.start = filter.start;
    reportFilters.end = filter.end;
    reportFilters.preset = filter.preset;
    renderReports();
  });
  document.querySelectorAll('[data-report-category]').forEach((button) => {
    button.addEventListener('click', () => setReportCategory(button.dataset.reportCategory));
  });
  document.getElementById('export-report-btn')?.addEventListener('click', exportReportPdf);

  const customerSearch = document.getElementById('report-customer-search');
  customerSearch?.addEventListener('focus', () => renderReportCustomerOptions(customerSearch.value));
  customerSearch?.addEventListener('input', () => {
    // Typing over a chosen customer lets go of them, so the box never shows one
    // name while the table is filtered by another.
    if (reportFilters.customerId) {
      reportFilters.customerId = '';
      renderReports();
    }
    renderReportCustomerOptions(customerSearch.value);
  });
  customerSearch?.addEventListener('blur', () => {
    // Leaving the box half-typed puts the chosen name back, or empties it.
    setTimeout(syncReportCustomerField, 0);
  });
  document.getElementById('report-customer-options')?.addEventListener('mousedown', (event) => event.preventDefault());
  document.getElementById('report-customer-options')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-report-customer-id]');
    if (option) selectReportCustomer(option.dataset.reportCustomerId);
  });
  document.getElementById('clear-report-customer')?.addEventListener('click', clearReportCustomer);
  document.addEventListener('click', (event) => {
    const picker = document.getElementById('report-customer-picker');
    if (picker && !picker.contains(event.target)) closeReportCustomerOptions();
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
let expenseDateFilter = { mode: 'all', start: '', end: '' };

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
  setupSharedDateFilter(document.getElementById('expense-shared-date-filter'), 'expenses', expenseDateFilter, (filter) => {
    expenseDateFilter = filter;
  });
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
  renderDashboard();
  applyPosMode();
  renderPosProducts();
  renderCart();
  renderCustomerSelects();
  renderProductsList();
  renderWasteView();
  renderClientRoute();
  renderPurchases();
  renderReports();
}

function setupEventListeners() {
  document.querySelector('[data-dashboard-reports]')?.addEventListener('click', () => setActiveTab('reports'));
  document.addEventListener('click', closeSharedDateFilters);
  // Listened for on the document: picking a date can rebuild the page and leave
  // focus on <body>, outside the control.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSharedDateFilters(event);
  });
  window.addEventListener('resize', () => {
    Object.values(sharedDatePickerState).forEach((picker) => { if (picker.calendarOpen) picker.repaint(); });
  });
  document.getElementById('pos-product-search').addEventListener('input', renderPosProducts);
  document.getElementById('pos-customer-search').addEventListener('input', () => {
    selectedPosCustomerId = null;
    renderPosCustomerField();
  });
  document.getElementById('product-search').addEventListener('input', renderProductsList);
  document.getElementById('pertes-product-filter')?.addEventListener('change', (event) => {
    pertesFilters.productId = event.target.value;
    renderWasteView();
  });
  document.getElementById('pertes-product-search')?.addEventListener('focus', (event) => {
    renderPerteHistoryProductOptions(event.target.value);
  });
  document.getElementById('pertes-product-search')?.addEventListener('input', (event) => {
    pertesFilters.productId = 'all';
    document.getElementById('clear-pertes-product')?.classList.add('hidden');
    renderPerteHistoryProductOptions(event.target.value);
  });
  document.getElementById('pertes-product-options')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-pertes-product-id]');
    if (option) selectPerteHistoryProduct(option.dataset.pertesProductId);
  });
  document.getElementById('clear-pertes-product')?.addEventListener('click', clearPerteHistoryProduct);
  document.addEventListener('click', (event) => {
    const picker = document.getElementById('pertes-product-picker');
    if (picker && !picker.contains(event.target)) closePerteHistoryProductOptions();
  });
  setupSharedDateFilter(document.getElementById('pertes-date-filter'), 'pertes', pertesFilters, (filter) => {
    pertesFilters = { ...pertesFilters, ...filter };
    renderWasteView();
  });
  document.getElementById('perte-product-search')?.addEventListener('focus', (event) => {
    renderPerteProductOptions(event.target.value);
  });
  document.getElementById('perte-product-search')?.addEventListener('input', (event) => {
    document.getElementById('perte-product').value = '';
    renderPerteProductOptions(event.target.value);
  });
  document.getElementById('perte-product-options')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-product-id]');
    if (option) selectPerteProduct(option.dataset.productId);
  });
  document.addEventListener('click', (event) => {
    const picker = document.getElementById('perte-product-picker');
    if (picker && !picker.contains(event.target)) closePerteProductOptions();
  });
  document.getElementById('add-perte-btn')?.addEventListener('click', () => openPerteEditor());
  document.getElementById('perte-form')?.addEventListener('submit', handlePerteSubmit);
  document.getElementById('cancel-perte-edit')?.addEventListener('click', closePerteEditor);
  document.getElementById('close-perte-editor')?.addEventListener('click', closePerteEditor);
  document.getElementById('perte-editor-modal')?.addEventListener('click', (event) => {
    if (event.target.id === 'perte-editor-modal') closePerteEditor();
  });
  document.getElementById('confirm-perte-delete')?.addEventListener('click', confirmPerteDelete);
  document.getElementById('cancel-perte-delete')?.addEventListener('click', () => {
    pendingDeletePerteId = null;
    document.getElementById('perte-delete-modal')?.classList.add('hidden');
  });
  document.getElementById('perte-delete-modal')?.addEventListener('click', (event) => {
    if (event.target.id === 'perte-delete-modal') {
      pendingDeletePerteId = null;
      event.target.classList.add('hidden');
    }
  });
  document.getElementById('close-perte-details')?.addEventListener('click', closePerteDetails);
  document.getElementById('edit-perte-from-details')?.addEventListener('click', () => {
    const id = document.getElementById('perte-details-modal')?.dataset.perteId;
    if (id) {
      closePerteDetails();
      openPerteEditor(id);
    }
  });
  document.getElementById('delete-perte-from-details')?.addEventListener('click', () => {
    const id = document.getElementById('perte-details-modal')?.dataset.perteId;
    if (id) {
      closePerteDetails();
      deletePerte(id);
    }
  });
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
  document.getElementById('product-stock-addition').addEventListener('input', renderStockDelta);
  document.getElementById('add-product-stock-btn').addEventListener('click', addStockToProduct);
  document.getElementById('payment-form').addEventListener('submit', handlePaymentSubmit);
  document.getElementById('payment-amount').addEventListener('input', renderPaymentAllocation);
  document.getElementById('payment-pay-all').addEventListener('click', () => {
    const invoice = state.sales.find((sale) => sale.id === payingInvoiceId);
    if (!invoice) return;
    document.getElementById('payment-amount').value = getInvoiceRemainingAmount(invoice);
  });
  document.getElementById('cancel-payment-btn').addEventListener('click', closePaymentModal);
  document.getElementById('close-payment-modal').addEventListener('click', closePaymentModal);
  document.getElementById('payment-modal').addEventListener('click', (event) => {
    if (event.target.id === 'payment-modal') closePaymentModal();
  });
  document.getElementById('close-receipt-btn').addEventListener('click', closeReceipt);
  document.getElementById('print-receipt-btn').addEventListener('click', () => window.print());
  document.getElementById('cancel-delete-sale-btn').addEventListener('click', closeDeleteSaleConfirmation);
  document.getElementById('confirm-delete-sale-btn').addEventListener('click', confirmDeleteSale);
  document.getElementById('cancel-product-edit').addEventListener('click', cancelProductEdit);
  document.getElementById('close-product-editor').addEventListener('click', cancelProductEdit);
  document.getElementById('add-product-btn').addEventListener('click', focusProductEditor);
  document.getElementById('pertes-btn').addEventListener('click', () => setStockScope('pertes'));
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
