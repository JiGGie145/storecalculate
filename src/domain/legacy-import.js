import { parseMoneyToMinorUnits } from './money.js';

export const LEGACY_STORAGE_KEY = 'ledger_flow_app_state';

function normalizeCategoryName(name) {
    return String(name || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function deferred(reason) {
    return { status: 'deferred', reason };
}

export function prepareLegacyImport(rawState, categories, options = {}) {
    if (rawState === null || rawState === undefined) {
        return { status: 'missing' };
    }

    let legacyState;
    try {
        legacyState = JSON.parse(rawState);
    } catch {
        return deferred('invalid-state');
    }

    if (!legacyState || !Array.isArray(legacyState.items)) {
        return deferred('invalid-state');
    }
    if (legacyState.items.length === 0) {
        return { status: 'empty' };
    }

    const currencyCode = String(legacyState.currencyCode || '').trim().toUpperCase();
    const currencySymbol = String(legacyState.currencySymbol || '').trim();
    const isLsl = currencyCode ? currencyCode === 'LSL' : currencySymbol === 'M';
    if (!isLsl) {
        return deferred('unsupported-currency');
    }

    const bucketsById = new Map((Array.isArray(legacyState.buckets) ? legacyState.buckets : [])
        .filter(bucket => bucket && bucket.id !== undefined)
        .map(bucket => [String(bucket.id), bucket]));
    const categoriesByName = new Map();

    for (const category of Array.isArray(categories) ? categories : []) {
        const normalizedName = normalizeCategoryName(category?.name);
        if (!normalizedName) continue;
        const matchingCategories = categoriesByName.get(normalizedName) || [];
        matchingCategories.push(category);
        categoriesByName.set(normalizedName, matchingCategories);
    }

    const createId = options.createId || (() => globalThis.crypto.randomUUID());
    const now = options.now || Date.now;
    const expenses = [];

    for (const item of legacyState.items) {
        if (!item || typeof item !== 'object') {
            return deferred('invalid-item');
        }

        let amountMinor;
        try {
            amountMinor = parseMoneyToMinorUnits(item.amount);
        } catch {
            return deferred('invalid-item');
        }
        if (amountMinor <= 0) {
            return deferred('invalid-item');
        }

        const bucket = bucketsById.get(String(item.bucketId));
        const matchingCategories = categoriesByName.get(normalizeCategoryName(bucket?.name)) || [];
        if (matchingCategories.length !== 1 || matchingCategories[0].active === false) {
            return deferred('category-mismatch');
        }

        const timestamp = new Date(item.timestamp).getTime();
        const clientId = createId();
        expenses.push({
            id: clientId,
            clientId,
            recordId: null,
            categoryId: matchingCategories[0].id,
            amountMinor,
            name: String(item.name || '').trim().slice(0, 120),
            timestamp: Number.isFinite(timestamp) ? timestamp : now(),
            pending: true
        });
    }

    return { status: 'ready', expenses };
}