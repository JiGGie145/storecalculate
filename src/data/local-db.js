import { openDB } from 'idb';

const DATABASE_NAME = 'ledger-flow-local';
const DATABASE_VERSION = 1;
const CACHED_STORES = ['categories', 'expenses', 'monthlyTotals'];
const LEGACY_IMPORT_KEY = 'ledger-flow:legacy-import-v1';

const databasePromise = openDB(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database) {
        for (const storeName of CACHED_STORES) {
            if (!database.objectStoreNames.contains(storeName)) {
                const store = database.createObjectStore(storeName, { keyPath: 'cacheKey' });
                store.createIndex('byUserId', 'userId');
            }
        }

        if (!database.objectStoreNames.contains('outbox')) {
            const store = database.createObjectStore('outbox', { keyPath: 'id' });
            store.createIndex('byUserId', 'userId');
        }

        if (!database.objectStoreNames.contains('metadata')) {
            database.createObjectStore('metadata', { keyPath: 'key' });
        }
    }
});

function cacheKey(userId, id) {
    return `${userId}:${id}`;
}

export async function getCachedSnapshot(userId) {
    const database = await databasePromise;
    const transaction = database.transaction(CACHED_STORES, 'readonly');
    const [categories, expenses, monthlyTotals] = await Promise.all(
        CACHED_STORES.map(storeName => transaction.objectStore(storeName).index('byUserId').getAll(userId))
    );

    await transaction.done;
    return { categories, expenses, monthlyTotals };
}

export async function replaceCachedSnapshot(userId, snapshot) {
    const database = await databasePromise;
    const transaction = database.transaction(CACHED_STORES, 'readwrite');

    for (const storeName of CACHED_STORES) {
        const store = transaction.objectStore(storeName);
        const existing = await store.index('byUserId').getAll(userId);

        for (const record of existing) {
            await store.delete(record.cacheKey);
        }

        for (const record of snapshot[storeName]) {
            await store.put({ ...record, userId, cacheKey: cacheKey(userId, record.id) });
        }
    }

    await transaction.done;
}

export async function putCachedRecord(storeName, userId, record) {
    if (!CACHED_STORES.includes(storeName)) {
        throw new TypeError(`Unsupported cache store: ${storeName}`);
    }

    const database = await databasePromise;
    await database.put(storeName, {
        ...record,
        userId,
        cacheKey: cacheKey(userId, record.id)
    });
}

export async function deleteCachedRecord(storeName, userId, id) {
    if (!CACHED_STORES.includes(storeName)) {
        throw new TypeError(`Unsupported cache store: ${storeName}`);
    }

    const database = await databasePromise;
    await database.delete(storeName, cacheKey(userId, id));
}

export async function enqueueMutation(userId, mutation) {
    const database = await databasePromise;
    const operation = {
        ...mutation,
        id: crypto.randomUUID(),
        userId,
        createdAt: Date.now()
    };

    await database.put('outbox', operation);
    return operation;
}

export async function enqueueExpenseMutation(userId, expense, type) {
    const database = await databasePromise;
    const transaction = database.transaction(['expenses', 'outbox'], 'readwrite');
    const operation = {
        id: crypto.randomUUID(),
        userId,
        type,
        clientId: expense.clientId,
        expense,
        recordId: expense.recordId,
        createdAt: Date.now()
    };

    if (type === 'createExpense') {
        await transaction.objectStore('expenses').put({
            ...expense,
            userId,
            cacheKey: cacheKey(userId, expense.id)
        });
    } else if (type === 'deleteExpense') {
        await transaction.objectStore('expenses').delete(cacheKey(userId, expense.id));
    } else {
        transaction.abort();
        throw new TypeError(`Unsupported expense mutation: ${type}`);
    }

    await transaction.objectStore('outbox').put(operation);
    await transaction.done;
    return operation;
}

export async function getLegacyImport() {
    const database = await databasePromise;
    const metadata = await database.get('metadata', LEGACY_IMPORT_KEY);
    return metadata?.value || null;
}

export async function enqueueLegacyExpenses(userId, expenses, importDetails) {
    const database = await databasePromise;
    const transaction = database.transaction(['expenses', 'outbox', 'metadata'], 'readwrite');
    const metadataStore = transaction.objectStore('metadata');
    const previous = await metadataStore.get(LEGACY_IMPORT_KEY);

    if (previous) {
        await transaction.done;
        return previous.value;
    }

    for (const expense of expenses) {
        const operation = {
            id: crypto.randomUUID(),
            userId,
            type: 'createExpense',
            clientId: expense.clientId,
            expense,
            createdAt: Date.now()
        };

        await transaction.objectStore('expenses').put({
            ...expense,
            userId,
            cacheKey: cacheKey(userId, expense.id)
        });
        await transaction.objectStore('outbox').put(operation);
    }

    const importRecord = {
        ...importDetails,
        status: 'queued',
        userId,
        clientIds: expenses.map(expense => expense.clientId),
        importedCount: expenses.length,
        queuedAt: Date.now()
    };
    await metadataStore.put({ key: LEGACY_IMPORT_KEY, value: importRecord });
    await transaction.done;
    return importRecord;
}

export async function completeLegacyImport(userId, sourceFingerprint) {
    const database = await databasePromise;
    const transaction = database.transaction(['metadata', 'outbox'], 'readwrite');
    const store = transaction.objectStore('metadata');
    const metadata = await store.get(LEGACY_IMPORT_KEY);
    const importRecord = metadata?.value;
    let result = importRecord || null;

    if (importRecord?.userId === userId && importRecord.sourceFingerprint === sourceFingerprint) {
        const operations = await transaction.objectStore('outbox').index('byUserId').getAll(userId);
        const pendingCreateIds = new Set(
            operations.filter(operation => operation.type === 'createExpense').map(operation => operation.clientId)
        );
        const allImportedCreatesSynced = importRecord.clientIds.every(clientId => !pendingCreateIds.has(clientId));

        if (importRecord.status === 'queued' && allImportedCreatesSynced) {
            result = { ...importRecord, status: 'completed', completedAt: Date.now() };
            await store.put({ key: LEGACY_IMPORT_KEY, value: result });
        }
    }

    await transaction.done;
    return result;
}

export async function getPendingMutations(userId) {
    const database = await databasePromise;
    const operations = await database.getAllFromIndex('outbox', 'byUserId', userId);
    return operations.sort((left, right) => left.createdAt - right.createdAt);
}

export async function removeMutation(id) {
    const database = await databasePromise;
    await database.delete('outbox', id);
}

export async function getMetadata(userId, key) {
    const database = await databasePromise;
    const metadata = await database.get('metadata', `${userId}:${key}`);
    return metadata?.value;
}

export async function setMetadata(userId, key, value) {
    const database = await databasePromise;
    await database.put('metadata', { key: `${userId}:${key}`, value });
}

export async function deleteMetadata(userId, key) {
    const database = await databasePromise;
    await database.delete('metadata', `${userId}:${key}`);
}