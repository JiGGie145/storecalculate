import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_STORAGE_KEY, prepareLegacyImport } from '../src/domain/legacy-import.js';

const categories = [
    { id: 'category-groceries', name: 'Groceries', active: true },
    { id: 'category-baby', name: 'Baby Care', active: true }
];

function makeLegacyState(overrides = {}) {
    return JSON.stringify({
        currencyCode: 'LSL',
        currencySymbol: 'M',
        cashLimit: 500,
        buckets: [
            { id: 'old-groceries', name: 'Groceries', allocated: 1000 },
            { id: 'old-baby', name: 'Baby Care', allocated: 500 }
        ],
        items: [
            { id: 'legacy-1', bucketId: 'old-groceries', amount: 18.04, name: 'Milk', timestamp: '2026-09-27T10:00:00.000Z' },
            { id: 'legacy-2', bucketId: 'old-baby', amount: '25.5', name: 'Wipes', timestamp: '2026-09-27T10:05:00.000Z' }
        ],
        ...overrides
    });
}

test('uses the existing legacy storage key', () => {
    assert.equal(LEGACY_STORAGE_KEY, 'ledger_flow_app_state');
});

test('maps LSL cart items to active categories and integer minor units only', () => {
    let id = 0;
    const result = prepareLegacyImport(makeLegacyState(), categories, {
        createId: () => `new-client-${++id}`,
        now: () => 123
    });

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.expenses.map(expense => ({
        clientId: expense.clientId,
        categoryId: expense.categoryId,
        amountMinor: expense.amountMinor,
        name: expense.name
    })), [
        { clientId: 'new-client-1', categoryId: 'category-groceries', amountMinor: 1804, name: 'Milk' },
        { clientId: 'new-client-2', categoryId: 'category-baby', amountMinor: 2550, name: 'Wipes' }
    ]);
    assert.equal('cashLimit' in result, false);
    assert.equal('currencyCode' in result, false);
});

test('does not import data with a non-LSL currency', () => {
    const result = prepareLegacyImport(makeLegacyState({ currencyCode: 'USD', currencySymbol: '$' }), categories);

    assert.deepEqual(result, { status: 'deferred', reason: 'unsupported-currency' });
});

test('defers when a legacy bucket has no unique active category match', () => {
    const state = JSON.parse(makeLegacyState());
    state.buckets[0].name = 'Unmanaged bucket';

    assert.deepEqual(
        prepareLegacyImport(JSON.stringify(state), categories),
        { status: 'deferred', reason: 'category-mismatch' }
    );
    assert.deepEqual(
        prepareLegacyImport(makeLegacyState(), [...categories, { id: 'duplicate', name: 'Groceries', active: true }]),
        { status: 'deferred', reason: 'category-mismatch' }
    );
});

test('defers malformed or unsupported legacy amounts without partial import', () => {
    const state = JSON.parse(makeLegacyState());
    state.items[1].amount = '3.005';

    assert.deepEqual(
        prepareLegacyImport(JSON.stringify(state), categories),
        { status: 'deferred', reason: 'invalid-item' }
    );
});