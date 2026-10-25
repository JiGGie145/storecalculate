import './styles.css';
import { calculateBudgetSummary, DEFAULT_TIME_ZONE, getPeriodKey } from './domain/budget.js';
import { formatMoney, parseMoneyToMinorUnits } from './domain/money.js';
import { pb } from './data/pocketbase.js';
import {
    flushOutbox,
    finalizeLegacyCartImport,
    getUserTimeZone,
    importLegacyCart,
    performCheckout,
    queueExpense,
    queueExpenseDeletion,
    readLocalSnapshot,
    refreshSnapshot,
    subscribeToChanges
} from './data/repository.js';

const COLOR_THEMES = {
    emerald: { color: '#34d399', soft: 'rgba(16, 185, 129, 0.10)' },
    sky: { color: '#38bdf8', soft: 'rgba(14, 165, 233, 0.10)' },
    cyan: { color: '#22d3ee', soft: 'rgba(6, 182, 212, 0.10)' },
    amber: { color: '#fbbf24', soft: 'rgba(245, 158, 11, 0.10)' },
    orange: { color: '#fb923c', soft: 'rgba(249, 115, 22, 0.10)' },
    rose: { color: '#fb7185', soft: 'rgba(244, 63, 94, 0.10)' },
    blue: { color: '#60a5fa', soft: 'rgba(59, 130, 246, 0.10)' },
    violet: { color: '#a78bfa', soft: 'rgba(139, 92, 246, 0.10)' },
    slate: { color: '#94a3b8', soft: 'rgba(148, 163, 184, 0.10)' }
};

const dom = Object.fromEntries([
    'loginView', 'calculatorView', 'configurationMessage', 'loginError', 'loginForm',
    'loginEmail', 'loginPassword', 'loginSubmit', 'accountLabel', 'syncStatus',
    'signOutButton', 'cartTotalDisplay', 'cartCountDisplay', 'clearCartButton',
    'checkoutButton', 'budgetPeriodLabel', 'bucketsContainer', 'emptyBudgetsState',
    'tabHeaders', 'ledgerItemsList', 'emptyLedgerState', 'speedButtonsContainer',
    'emptyCategoriesState', 'quickAmountInput', 'quickNoteInput', 'numpadToggle',
    'numpadToggleText', 'onscreenNumpad', 'toast', 'toastIcon', 'toastMessage'
].map(id => [id, document.getElementById(id.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`))]));

const state = {
    user: null,
    timeZone: DEFAULT_TIME_ZONE,
    snapshot: { categories: [], expenses: [], monthlyTotals: [] },
    activeFilter: 'all',
    unsubscribeRealtime: null,
    syncPromise: null,
    toastTimeout: null,
    legacyImportDeferred: false,
    legacyImportWarningShown: false
};

function activeCategories() {
    return state.snapshot.categories.filter(category => category.active !== false);
}

function categoryTheme(category) {
    const requestedColor = String(category.color || 'emerald').toLowerCase().split(/[-_]/)[0];
    return COLOR_THEMES[requestedColor] || COLOR_THEMES.emerald;
}

function cartTotalMinor() {
    return state.snapshot.expenses.reduce((total, expense) => total + expense.amountMinor, 0);
}

function setView(showCalculator) {
    dom.loginView.classList.toggle('hidden', showCalculator);
    dom.calculatorView.classList.toggle('hidden', !showCalculator);
}

function setSyncStatus(label, status = 'connecting') {
    const indicator = document.createElement('span');
    const indicatorClasses = {
        connecting: 'h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse',
        synced: 'h-1.5 w-1.5 rounded-full bg-emerald-400',
        pending: 'h-1.5 w-1.5 rounded-full bg-amber-400',
        offline: 'h-1.5 w-1.5 rounded-full bg-rose-400',
        issue: 'h-1.5 w-1.5 rounded-full bg-rose-400'
    };

    indicator.className = indicatorClasses[status] || indicatorClasses.connecting;
    dom.syncStatus.replaceChildren(indicator, document.createTextNode(label));
}

function showToast(message, kind = 'info') {
    dom.toastMessage.textContent = message;
    dom.toastIcon.className = kind === 'error'
        ? 'fa-solid fa-circle-exclamation text-rose-400'
        : kind === 'success'
            ? 'fa-solid fa-circle-check text-emerald-400'
            : 'fa-solid fa-circle-info text-sky-400';
    dom.toast.classList.remove('opacity-0');
    dom.toast.classList.add('opacity-100');

    window.clearTimeout(state.toastTimeout);
    state.toastTimeout = window.setTimeout(() => {
        dom.toast.classList.remove('opacity-100');
        dom.toast.classList.add('opacity-0');
    }, 2800);
}

function getErrorMessage(error, fallback) {
    return error?.response?.message || error?.message || fallback;
}

function reportLegacyImportIssue(result) {
    if (result.status !== 'deferred' || state.legacyImportWarningShown) return;

    const messages = {
        'another-account': 'The legacy cart import is associated with another account on this device.',
        'category-mismatch': 'Legacy cart import is waiting for matching active account categories.',
        'fingerprint-unavailable': 'Legacy cart data was left untouched because it could not be verified.',
        'invalid-item': 'A legacy cart item could not be imported; the saved data was left untouched.',
        'invalid-state': 'The saved legacy cart could not be read and was left untouched.',
        'storage-unavailable': 'Legacy cart data is unavailable in this browser session.',
        'unsupported-currency': 'Legacy cart prices were not in LSL and were left untouched.'
    };
    const message = messages[result.reason];
    if (!message) return;

    state.legacyImportDeferred = result.reason === 'category-mismatch';
    state.legacyImportWarningShown = true;
    showToast(message, 'error');
}

function renderBudgetCards(periodKey) {
    const categories = activeCategories();
    const periodTotals = new Map();

    for (const total of state.snapshot.monthlyTotals) {
        if (total.periodKey === periodKey) {
            periodTotals.set(total.categoryId, (periodTotals.get(total.categoryId) || 0) + total.spentMinor);
        }
    }

    dom.bucketsContainer.replaceChildren();
    dom.emptyBudgetsState.classList.toggle('hidden', categories.length > 0);

    for (const category of categories) {
        const budgetMinor = Number.isSafeInteger(category.monthlyBudgetMinor)
            ? category.monthlyBudgetMinor
            : 0;
        const monthlySpentMinor = periodTotals.get(category.id) || 0;
        const summary = calculateBudgetSummary(
            { ...category, monthlyBudgetMinor: budgetMinor },
            monthlySpentMinor,
            state.snapshot.expenses
        );
        const theme = categoryTheme(category);
        const article = document.createElement('article');
        article.className = 'min-w-0 border border-slate-800 bg-slate-900 px-2.5 py-2';

        const heading = document.createElement('div');
        heading.className = 'flex min-w-0 items-center justify-between gap-1';

        const identity = document.createElement('div');
        identity.className = 'flex min-w-0 items-center gap-1.5';

        const icon = document.createElement('span');
        icon.className = 'flex h-6 w-6 shrink-0 items-center justify-center text-sm';
        icon.style.backgroundColor = theme.soft;
        icon.style.color = theme.color;
        icon.textContent = category.icon || '🏷️';

        const name = document.createElement('h3');
        name.className = 'truncate text-xs font-semibold text-slate-100';
        name.textContent = category.name;
        name.title = category.name;
        identity.append(icon, name);

        const remaining = document.createElement('p');
        remaining.className = `shrink-0 font-mono text-[10px] font-semibold ${summary.remainingMinor < 0 ? 'text-rose-400' : 'text-emerald-400'}`;
        remaining.textContent = formatMoney(summary.remainingMinor);
        heading.append(identity, remaining);

        const progress = document.createElement('div');
        progress.className = 'budget-progress mt-2';
        const progressFill = document.createElement('span');
        progressFill.style.width = `${summary.usagePercent}%`;
        progressFill.style.backgroundColor = summary.remainingMinor < 0 ? '#fb7185' : theme.color;
        progress.append(progressFill);

        const details = document.createElement('div');
        details.className = 'mt-1.5 flex items-center justify-between gap-1 text-[9px]';
        const spent = document.createElement('span');
        spent.className = 'min-w-0 truncate text-slate-400';
        spent.textContent = `Spent ${formatMoney(summary.totalSpentMinor)}`;
        const allocated = document.createElement('span');
        allocated.className = 'shrink-0 font-mono text-slate-500';
        allocated.textContent = `of ${formatMoney(budgetMinor)}`;
        details.append(spent, allocated);

        const cartSpent = document.createElement('p');
        cartSpent.className = 'mt-0.5 text-[9px] text-slate-500';
        cartSpent.textContent = `Cart ${formatMoney(summary.cartSpentMinor)}`;
        article.append(heading, progress, details, cartSpent);
        dom.bucketsContainer.append(article);
    }
}

function renderCategoryTabs() {
    const categories = activeCategories();
    const expenses = state.snapshot.expenses;

    if (state.activeFilter !== 'all' && !categories.some(category => category.id === state.activeFilter)) {
        state.activeFilter = 'all';
    }

    dom.tabHeaders.replaceChildren();
    const filters = [{ id: 'all', name: 'All', count: expenses.length }, ...categories.map(category => ({
        id: category.id,
        name: category.name,
        count: expenses.filter(expense => expense.categoryId === category.id).length
    }))];

    for (const filter of filters) {
        const selected = state.activeFilter === filter.id;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.filter = filter.id;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(selected));
        button.className = selected
            ? 'whitespace-nowrap bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white'
            : 'whitespace-nowrap bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-400 transition hover:text-white';
        button.append(document.createTextNode(`${filter.name} `));
        const count = document.createElement('span');
        count.className = selected ? 'text-emerald-100' : 'text-slate-500';
        count.textContent = String(filter.count);
        button.append(count);
        dom.tabHeaders.append(button);
    }
}

function renderLedger() {
    const categoriesById = new Map(state.snapshot.categories.map(category => [category.id, category]));
    const allExpenses = [...state.snapshot.expenses].sort((left, right) => right.timestamp - left.timestamp);
    const expenses = state.activeFilter === 'all'
        ? allExpenses
        : allExpenses.filter(expense => expense.categoryId === state.activeFilter);

    dom.ledgerItemsList.replaceChildren();

    if (expenses.length === 0) {
        dom.ledgerItemsList.append(dom.emptyLedgerState);
        return;
    }

    for (const expense of expenses) {
        const category = categoriesById.get(expense.categoryId);
        const row = document.createElement('article');
        row.className = 'flex items-center gap-2 border-b border-slate-800/70 px-1 py-2 last:border-0';

        const details = document.createElement('div');
        details.className = 'min-w-0 flex-1';
        const itemName = document.createElement('p');
        itemName.className = 'truncate text-xs font-medium text-slate-200';
        itemName.textContent = expense.name || category?.name || 'Shopping item';
        const metadata = document.createElement('p');
        metadata.className = 'mt-0.5 truncate text-[10px] text-slate-500';
        metadata.textContent = `${category?.name || 'Archived budget'} · ${new Date(expense.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        details.append(itemName, metadata);

        if (expense.pending) {
            const pending = document.createElement('span');
            pending.className = 'shrink-0 text-[9px] uppercase tracking-wide text-amber-400';
            pending.textContent = 'Queued';
            details.append(pending);
        }

        const amount = document.createElement('span');
        amount.className = 'shrink-0 font-mono text-xs font-medium text-slate-100';
        amount.textContent = formatMoney(expense.amountMinor);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'flex h-8 w-8 shrink-0 items-center justify-center text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-400';
        remove.title = 'Remove item';
        remove.setAttribute('aria-label', `Remove ${expense.name || 'shopping item'}`);
        remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
        remove.addEventListener('click', () => void removeExpense(expense));

        row.append(details, amount, remove);
        dom.ledgerItemsList.append(row);
    }
}

function renderEntryButtons() {
    const categories = activeCategories();
    dom.speedButtonsContainer.replaceChildren();
    dom.emptyCategoriesState.classList.toggle('hidden', categories.length > 0);

    for (const category of categories) {
        const theme = categoryTheme(category);
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.categoryId = category.id;
        button.className = 'flex min-h-9 min-w-0 items-center justify-center gap-1.5 border px-2 py-1.5 text-xs font-semibold transition hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40';
        button.style.borderColor = `${theme.color}55`;
        button.style.backgroundColor = theme.soft;
        button.style.color = theme.color;

        const icon = document.createElement('span');
        icon.className = 'shrink-0';
        icon.textContent = category.icon || '🏷️';
        const label = document.createElement('span');
        label.className = 'truncate';
        label.textContent = `+ ${category.name}`;
        button.append(icon, label);
        button.addEventListener('click', () => void addExpense(category.id));
        dom.speedButtonsContainer.append(button);
    }
}

function render() {
    const categories = activeCategories();
    const total = cartTotalMinor();
    const periodKey = getPeriodKey(new Date(), state.timeZone);
    const periodDate = new Intl.DateTimeFormat('en-GB', {
        timeZone: state.timeZone,
        month: 'long',
        year: 'numeric'
    }).format(new Date());

    dom.accountLabel.textContent = state.user?.name || state.user?.email || 'Shared household';
    dom.cartTotalDisplay.textContent = formatMoney(total);
    dom.cartCountDisplay.textContent = `${state.snapshot.expenses.length} ${state.snapshot.expenses.length === 1 ? 'item' : 'items'}`;
    dom.budgetPeriodLabel.textContent = `${periodDate} · ${periodKey}`;
    dom.checkoutButton.disabled = state.snapshot.expenses.length === 0 || !navigator.onLine;
    dom.clearCartButton.disabled = state.snapshot.expenses.length === 0;

    renderBudgetCards(periodKey);
    renderCategoryTabs();
    renderLedger();
    renderEntryButtons();
}

async function renderCachedSnapshot() {
    if (!state.user) return;
    state.snapshot = await readLocalSnapshot(state.user.id);
    render();
}

function handleSessionFailure(error) {
    const status = error?.status || error?.response?.code;
    if (status !== 401) return false;

    pb?.authStore.clear();
    void endSession(false);
    return true;
}

async function syncAccount() {
    if (!pb || !state.user) return;
    if (state.syncPromise) return state.syncPromise;

    const accountId = state.user.id;
    const syncPromise = (async () => {
        setSyncStatus(navigator.onLine ? 'Syncing' : 'Offline', navigator.onLine ? 'connecting' : 'offline');
        try {
            if (!navigator.onLine) {
                const importResult = await importLegacyCart(accountId, state.snapshot.categories);
                state.legacyImportDeferred = importResult.reason === 'category-mismatch';
                reportLegacyImportIssue(importResult);
                if (importResult.status === 'queued' && importResult.userId === accountId) {
                    state.snapshot = await readLocalSnapshot(accountId);
                }
                setSyncStatus('Offline', 'offline');
                render();
                return;
            }

            let syncResult = await flushOutbox(pb, accountId);
            let snapshot = await refreshSnapshot(pb, accountId, state.timeZone);
            if (state.user?.id !== accountId) return;

            const importResult = await importLegacyCart(accountId, snapshot.categories);
            state.legacyImportDeferred = importResult.reason === 'category-mismatch';
            reportLegacyImportIssue(importResult);

            if (importResult.status === 'queued' && importResult.userId === accountId) {
                syncResult = await flushOutbox(pb, accountId);
                snapshot = await refreshSnapshot(pb, accountId, state.timeZone);
                if (state.user?.id !== accountId) return;
            }

            const completedImport = await finalizeLegacyCartImport(accountId);
            if (importResult.status === 'queued' && completedImport?.status === 'completed') {
                state.legacyImportDeferred = false;
                showToast(`Imported ${completedImport.importedCount} legacy cart ${completedImport.importedCount === 1 ? 'item' : 'items'}.`, 'success');
            }

            state.snapshot = snapshot;
            render();

            if (syncResult.pending > 0) {
                setSyncStatus(`${syncResult.pending} queued`, 'pending');
            } else {
                setSyncStatus('Synced', 'synced');
            }

            if (!state.unsubscribeRealtime) {
                try {
                    state.unsubscribeRealtime = await subscribeToChanges(pb, accountId, () => {
                        void renderCachedSnapshot();
                        if (state.legacyImportDeferred) void syncAccount();
                    });
                } catch (error) {
                    console.warn('Realtime subscription is unavailable.', error);
                }
            }
        } catch (error) {
            if (handleSessionFailure(error)) return;
            console.warn('Account sync failed.', error);
            if (!navigator.onLine) {
                setSyncStatus('Offline', 'offline');
            } else {
                setSyncStatus('Sync issue', 'issue');
            }
        }
    })();

    state.syncPromise = syncPromise;
    try {
        await syncPromise;
    } finally {
        if (state.syncPromise === syncPromise) state.syncPromise = null;
    }
}

async function startSession(user) {
    if (!user?.id) return;

    if (state.unsubscribeRealtime) {
        await state.unsubscribeRealtime().catch(() => {});
        state.unsubscribeRealtime = null;
    }

    state.user = user;
    state.timeZone = getUserTimeZone(user);
    state.activeFilter = 'all';
    state.legacyImportDeferred = false;
    state.legacyImportWarningShown = false;
    setView(true);
    setSyncStatus(navigator.onLine ? 'Connecting' : 'Offline', navigator.onLine ? 'connecting' : 'offline');

    try {
        state.snapshot = await readLocalSnapshot(user.id);
    } catch (error) {
        console.warn('Local cache could not be read.', error);
        state.snapshot = { categories: [], expenses: [], monthlyTotals: [] };
    }
    render();
    void syncAccount();
}

async function endSession(clearAuth = true) {
    if (state.unsubscribeRealtime) {
        await state.unsubscribeRealtime().catch(() => {});
        state.unsubscribeRealtime = null;
    }

    state.user = null;
    state.snapshot = { categories: [], expenses: [], monthlyTotals: [] };
    state.activeFilter = 'all';
    state.legacyImportDeferred = false;
    dom.loginPassword.value = '';
    dom.loginError.classList.add('hidden');
    setView(false);
    if (clearAuth) pb?.authStore.clear();
}

async function addExpense(categoryId) {
    const category = activeCategories().find(item => item.id === categoryId);
    if (!category || !state.user) return;

    let amountMinor;
    try {
        amountMinor = parseMoneyToMinorUnits(dom.quickAmountInput.value);
        if (amountMinor <= 0) throw new TypeError('Enter an amount greater than zero.');
    } catch (error) {
        showToast(getErrorMessage(error, 'Enter a valid amount.'), 'error');
        dom.quickAmountInput.focus();
        return;
    }

    try {
        await queueExpense(state.user.id, {
            categoryId,
            amountMinor,
            name: dom.quickNoteInput.value.trim()
        });
        dom.quickAmountInput.value = '';
        dom.quickNoteInput.value = '';
        await renderCachedSnapshot();
        showToast(navigator.onLine ? 'Item added to the shared cart.' : 'Item saved locally and queued to sync.', 'success');
        if (navigator.onLine) void syncAccount();
    } catch (error) {
        showToast(getErrorMessage(error, 'The item could not be added.'), 'error');
    }
}

async function removeExpense(expense) {
    if (!state.user) return;

    try {
        await queueExpenseDeletion(state.user.id, expense);
        await renderCachedSnapshot();
        showToast(navigator.onLine ? 'Item removed from the shared cart.' : 'Removal saved and queued to sync.', 'success');
        if (navigator.onLine) void syncAccount();
    } catch (error) {
        showToast(getErrorMessage(error, 'The item could not be removed.'), 'error');
    }
}

async function clearCart() {
    if (!state.user || state.snapshot.expenses.length === 0) return;
    if (!window.confirm('Remove every item from the current cart?')) return;

    try {
        await Promise.all(state.snapshot.expenses.map(expense => queueExpenseDeletion(state.user.id, expense)));
        await renderCachedSnapshot();
        showToast(navigator.onLine ? 'Cart cleared.' : 'Cart clear saved and queued to sync.', 'success');
        if (navigator.onLine) void syncAccount();
    } catch (error) {
        showToast(getErrorMessage(error, 'The cart could not be cleared.'), 'error');
    }
}

async function checkout() {
    if (!pb || !state.user || state.snapshot.expenses.length === 0) return;
    if (!navigator.onLine) {
        showToast('Checkout requires an internet connection.', 'error');
        return;
    }

    const items = [...state.snapshot.expenses];
    const expectedTotalMinor = items.reduce((total, expense) => total + expense.amountMinor, 0);
    const expectedCart = items.map(expense => ({
        clientId: expense.clientId,
        amountMinor: expense.amountMinor,
        categoryId: expense.categoryId
    }));

    if (!window.confirm(`Complete checkout for ${formatMoney(expectedTotalMinor)}?`)) return;

    dom.checkoutButton.disabled = true;
    dom.checkoutButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Processing';

    try {
        await performCheckout(pb, state.user.id, expectedTotalMinor, expectedCart);
        await syncAccount();
        showToast('Checkout recorded. Your category totals are up to date.', 'success');
    } catch (error) {
        if (error?.status === 409 || error?.response?.code === 409) {
            showToast('The shared cart changed. Review the updated total and try again.', 'error');
            await syncAccount();
        } else if (!handleSessionFailure(error)) {
            showToast(getErrorMessage(error, 'Checkout could not be completed.'), 'error');
        }
    } finally {
        dom.checkoutButton.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> Complete checkout';
        render();
    }
}

function handleAmountKeypad(value) {
    const current = dom.quickAmountInput.value;
    if (value === '.') {
        if (current.includes('.')) return;
        dom.quickAmountInput.value = current ? `${current}.` : '0.';
        return;
    }

    const decimalIndex = current.indexOf('.');
    if (decimalIndex !== -1 && current.length - decimalIndex > 2) return;
    dom.quickAmountInput.value = `${current}${value}`;
}

function registerEventHandlers() {
    dom.loginForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!pb) return;

        dom.loginError.classList.add('hidden');
        dom.loginSubmit.disabled = true;
        dom.loginSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Signing in';

        try {
            const auth = await pb.collection('users').authWithPassword(
                dom.loginEmail.value.trim(),
                dom.loginPassword.value
            );
            await startSession(auth.record);
        } catch (error) {
            dom.loginError.textContent = getErrorMessage(error, 'Sign-in failed. Check your details and connection.');
            dom.loginError.classList.remove('hidden');
        } finally {
            dom.loginSubmit.disabled = false;
            dom.loginSubmit.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i> Sign in to ledger';
        }
    });

    dom.signOutButton.addEventListener('click', () => void endSession());
    dom.clearCartButton.addEventListener('click', () => void clearCart());
    dom.checkoutButton.addEventListener('click', () => void checkout());

    dom.tabHeaders.addEventListener('click', event => {
        const button = event.target.closest('button[data-filter]');
        if (!button) return;
        state.activeFilter = button.dataset.filter;
        renderCategoryTabs();
        renderLedger();
    });

    dom.quickAmountInput.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const firstCategory = activeCategories()[0];
        if (firstCategory) void addExpense(firstCategory.id);
    });

    dom.numpadToggle.addEventListener('click', () => {
        const expanded = dom.numpadToggle.getAttribute('aria-expanded') === 'true';
        dom.numpadToggle.setAttribute('aria-expanded', String(!expanded));
        dom.onscreenNumpad.classList.toggle('hidden', expanded);
        dom.onscreenNumpad.classList.toggle('grid', !expanded);
        dom.numpadToggleText.textContent = expanded ? 'Show on-screen keypad' : 'Hide on-screen keypad';
    });

    dom.onscreenNumpad.addEventListener('click', event => {
        const button = event.target.closest('button[data-digit], button[data-action]');
        if (!button) return;

        if (button.dataset.action === 'clear-amount') {
            dom.quickAmountInput.value = '';
        } else {
            handleAmountKeypad(button.dataset.digit);
        }
        dom.quickAmountInput.focus();
    });

    window.addEventListener('online', () => {
        if (!state.user) return;
        render();
        void syncAccount();
    });
    window.addEventListener('offline', () => {
        if (!state.user) return;
        setSyncStatus('Offline', 'offline');
        render();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.user && navigator.onLine) {
            void syncAccount();
        }
    });
}

function initialize() {
    registerEventHandlers();

    if (!pb) {
        dom.configurationMessage.textContent = 'PocketBase is not configured. Set VITE_POCKETBASE_URL and restart the app.';
        dom.configurationMessage.classList.remove('hidden');
        dom.loginSubmit.disabled = true;
    } else if (pb.authStore.isValid && pb.authStore.model) {
        void startSession(pb.authStore.model);
    }

    if (import.meta.env.PROD && 'serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(error => {
            console.warn('Service worker registration failed.', error);
        });
    }
}

initialize();