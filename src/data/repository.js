import {
    deleteCachedRecord,
    enqueueExpenseMutation,
    getCachedSnapshot,
    getMetadata,
    getPendingMutations,
    putCachedRecord,
    removeMutation,
    replaceCachedSnapshot,
    deleteMetadata,
    completeLegacyImport,
    enqueueLegacyExpenses,
    getLegacyImport,
    setMetadata
} from './local-db.js';
import { getPeriodKey } from '../domain/budget.js';
import { LEGACY_STORAGE_KEY, prepareLegacyImport } from '../domain/legacy-import.js';

const CLIENT_ID_PATTERN = /^[a-f\d-]{36}$/i;

function normalizeCategory(record) {
    return {
        id: record.id,
        name: record.name,
        icon: record.icon || '🏷️',
        color: record.color_code || 'emerald',
        monthlyBudgetMinor: record.monthly_budget_minor,
        active: record.active
    };
}

function normalizeExpense(record, pending = false) {
    return {
        id: record.client_id,
        clientId: record.client_id,
        recordId: record.id,
        categoryId: record.category,
        amountMinor: record.amount_minor,
        name: record.name || '',
        timestamp: new Date(record.client_created_at || record.created).getTime(),
        pending
    };
}

function normalizeMonthlyTotal(record) {
    return {
        id: record.id,
        categoryId: record.category,
        periodKey: record.period_key,
        timeZone: record.time_zone,
        spentMinor: record.spent_minor
    };
}

function filterValue(value) {
    return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function assertClientId(clientId) {
    if (!CLIENT_ID_PATTERN.test(clientId)) {
        throw new TypeError('Invalid client item ID.');
    }
}

function isNotFound(error) {
    return error?.status === 404 || error?.response?.code === 404;
}

export function getUserTimeZone(userRecord) {
    return userRecord.timezone || 'Africa/Maseru';
}

export async function readLocalSnapshot(userId) {
    return getCachedSnapshot(userId);
}

export async function refreshSnapshot(pb, userId, timeZone) {
    const periodKey = getPeriodKey(new Date(), timeZone);
    const [categoryRecords, expenseRecords, monthlyRecords, cached, pending] = await Promise.all([
        pb.collection('categories').getFullList({ sort: 'name' }),
        pb.collection('expenses').getFullList({
            filter: `user = ${filterValue(userId)}`,
            sort: '-client_created_at'
        }),
        pb.collection('category_monthly_totals').getFullList({
            filter: `user = ${filterValue(userId)} && period_key = ${filterValue(periodKey)}`
        }),
        getCachedSnapshot(userId),
        getPendingMutations(userId)
    ]);

    const remoteExpenses = expenseRecords.map(record => normalizeExpense(record));
    const remoteClientIds = new Set(remoteExpenses.map(item => item.clientId));
    const pendingCreates = new Set(
        pending.filter(operation => operation.type === 'createExpense').map(operation => operation.clientId)
    );
    const pendingDeletes = new Set(
        pending.filter(operation => operation.type === 'deleteExpense').map(operation => operation.clientId)
    );
    const optimisticExpenses = cached.expenses.filter(item => {
        return pendingCreates.has(item.clientId) && !remoteClientIds.has(item.clientId);
    });
    const expenses = [...remoteExpenses, ...optimisticExpenses]
        .filter(item => !pendingDeletes.has(item.clientId));
    const snapshot = {
        categories: categoryRecords.map(normalizeCategory),
        expenses,
        monthlyTotals: monthlyRecords.map(normalizeMonthlyTotal)
    };

    await replaceCachedSnapshot(userId, snapshot);
    return snapshot;
}

export async function queueExpense(userId, expenseInput) {
    const clientId = crypto.randomUUID();
    const expense = {
        id: clientId,
        clientId,
        recordId: null,
        categoryId: expenseInput.categoryId,
        amountMinor: expenseInput.amountMinor,
        name: expenseInput.name,
        timestamp: Date.now(),
        pending: true
    };

    await enqueueExpenseMutation(userId, expense, 'createExpense');

    return expense;
}

export async function queueExpenseDeletion(userId, expense) {
    await enqueueExpenseMutation(userId, expense, 'deleteExpense');
}

async function fingerprintLegacyCart(rawState) {
    const legacyState = JSON.parse(rawState);
    const fingerprintData = {
        buckets: (Array.isArray(legacyState.buckets) ? legacyState.buckets : []).map(bucket => ({
            id: bucket?.id,
            name: bucket?.name
        })),
        items: (Array.isArray(legacyState.items) ? legacyState.items : []).map(item => ({
            id: item?.id,
            bucketId: item?.bucketId,
            amount: item?.amount,
            name: item?.name,
            timestamp: item?.timestamp
        }))
    };
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(fingerprintData))
    );
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function importLegacyCart(userId, categories) {
    const previousImport = await getLegacyImport();
    if (previousImport) {
        return previousImport.userId === userId
            ? previousImport
            : { status: 'deferred', reason: 'another-account' };
    }

    let rawState;
    try {
        rawState = localStorage.getItem(LEGACY_STORAGE_KEY);
    } catch {
        return { status: 'deferred', reason: 'storage-unavailable' };
    }

    const prepared = prepareLegacyImport(rawState, categories);
    if (prepared.status !== 'ready') return prepared;

    let sourceFingerprint;
    try {
        sourceFingerprint = await fingerprintLegacyCart(rawState);
    } catch {
        return { status: 'deferred', reason: 'fingerprint-unavailable' };
    }
    return enqueueLegacyExpenses(userId, prepared.expenses, { sourceFingerprint });
}

export async function finalizeLegacyCartImport(userId) {
    const importRecord = await getLegacyImport();
    if (!importRecord || importRecord.userId !== userId) return importRecord;

    const completedImport = await completeLegacyImport(userId, importRecord.sourceFingerprint);
    if (completedImport?.status !== 'completed') return completedImport;

    try {
        const rawState = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (rawState !== null && await fingerprintLegacyCart(rawState) === completedImport.sourceFingerprint) {
            localStorage.removeItem(LEGACY_STORAGE_KEY);
        }
    } catch {}

    return completedImport;
}

async function findRemoteExpense(pb, userId, clientId) {
    const filter = `client_id = ${filterValue(clientId)} && user = ${filterValue(userId)}`;

    try {
        return await pb.collection('expenses').getFirstListItem(filter);
    } catch (error) {
        if (isNotFound(error)) {
            return null;
        }

        throw error;
    }
}

export async function flushOutbox(pb, userId) {
    if (!navigator.onLine) {
        return { synced: 0, pending: (await getPendingMutations(userId)).length };
    }

    const operations = await getPendingMutations(userId);
    let synced = 0;

    for (const operation of operations) {
        if (operation.type === 'createExpense') {
            assertClientId(operation.clientId);
            let record = await findRemoteExpense(pb, userId, operation.clientId);

            if (!record) {
                record = await pb.collection('expenses').create({
                    client_id: operation.clientId,
                    amount_minor: operation.expense.amountMinor,
                    name: operation.expense.name,
                    category: operation.expense.categoryId,
                    user: userId,
                    client_created_at: new Date(operation.expense.timestamp).toISOString()
                });
            }

            await putCachedRecord('expenses', userId, normalizeExpense(record));
        } else if (operation.type === 'deleteExpense') {
            assertClientId(operation.clientId);
            const record = operation.recordId
                ? await pb.collection('expenses').getOne(operation.recordId).catch(error => {
                    if (isNotFound(error)) return null;
                    throw error;
                })
                : await findRemoteExpense(pb, userId, operation.clientId);

            if (record && record.user === userId) {
                await pb.collection('expenses').delete(record.id).catch(error => {
                    if (!isNotFound(error)) throw error;
                });
            }

            await deleteCachedRecord('expenses', userId, operation.clientId);
        } else {
            throw new Error(`Unsupported queued operation: ${operation.type}`);
        }

        await removeMutation(operation.id);
        synced += 1;
    }

    return { synced, pending: (await getPendingMutations(userId)).length };
}

export async function subscribeToChanges(pb, userId, onChange) {
    const filter = `user = ${filterValue(userId)}`;
    const subscriptions = [
        ['categories', async event => {
            if (event.action === 'delete') {
                await deleteCachedRecord('categories', userId, event.record.id);
            } else {
                await putCachedRecord('categories', userId, normalizeCategory(event.record));
            }
            onChange();
        }],
        ['expenses', async event => {
            const item = normalizeExpense(event.record);
            if (event.action === 'delete') {
                await deleteCachedRecord('expenses', userId, item.clientId);
            } else {
                await putCachedRecord('expenses', userId, item);
            }
            onChange();
        }],
        ['category_monthly_totals', async event => {
            const total = normalizeMonthlyTotal(event.record);
            if (event.action === 'delete') {
                await deleteCachedRecord('monthlyTotals', userId, total.id);
            } else {
                await putCachedRecord('monthlyTotals', userId, total);
            }
            onChange();
        }]
    ];

    await Promise.all(subscriptions.map(([collection, callback]) => {
        return pb.collection(collection).subscribe('*', callback, { filter });
    }));

    return async () => {
        await Promise.all(subscriptions.map(([collection]) => pb.collection(collection).unsubscribe('*')));
    };
}

export async function performCheckout(pb, userId, expectedTotalMinor, expectedCart) {
    if (!navigator.onLine) {
        throw new Error('Checkout requires an internet connection.');
    }
    if (!Number.isSafeInteger(expectedTotalMinor) || expectedTotalMinor < 0 || !Array.isArray(expectedCart)) {
        throw new TypeError('Checkout requires a valid total and cart snapshot.');
    }

    const syncResult = await flushOutbox(pb, userId);
    if (syncResult.pending > 0) {
        throw new Error('Pending cart changes could not be synced. Try again before checkout.');
    }

    const cartSnapshot = expectedCart
        .map(item => ({
            client_id: item.clientId,
            amount_minor: item.amountMinor,
            category: item.categoryId
        }))
        .sort((left, right) => left.client_id.localeCompare(right.client_id));
    const requestFingerprint = JSON.stringify({
        expected_total_minor: expectedTotalMinor,
        expected_cart: cartSnapshot
    });
    const pendingCheckout = await getMetadata(userId, 'pendingCheckout');
    const checkoutId = pendingCheckout?.requestFingerprint === requestFingerprint
        ? pendingCheckout.checkoutId
        : crypto.randomUUID();
    await setMetadata(userId, 'pendingCheckout', { checkoutId, requestFingerprint });
    const result = await pb.send('/api/ledger/checkout', {
        method: 'POST',
        body: {
            checkout_id: checkoutId,
            expected_total_minor: expectedTotalMinor,
            expected_cart: cartSnapshot
        }
    });

    await deleteMetadata(userId, 'pendingCheckout');
    return result;
}