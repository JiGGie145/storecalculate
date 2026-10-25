import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, parseMoneyToMinorUnits } from '../src/domain/money.js';
import {
    calculateBudgetSummary,
    getCartSpentMinor,
    getPeriodKey
} from '../src/domain/budget.js';

test('parses decimal prices exactly into minor units', () => {
    assert.equal(parseMoneyToMinorUnits('18'), 1800);
    assert.equal(parseMoneyToMinorUnits('18.4'), 1840);
    assert.equal(parseMoneyToMinorUnits('18.04'), 1804);
});

test('rejects invalid, negative, and over-precision money values', () => {
    for (const value of ['', '-1.00', '1.005', 'one']) {
        assert.throws(() => parseMoneyToMinorUnits(value), TypeError);
    }
});

test('formats LSL money and negative remaining balances', () => {
    assert.equal(formatMoney(123456), 'M 1,234.56');
    assert.equal(formatMoney(-5), '-M 0.05');
});

test('resolves the calendar month in the account time zone', () => {
    const justAfterUtcMonthBoundary = new Date('2026-03-01T00:30:00.000Z');

    assert.equal(getPeriodKey(justAfterUtcMonthBoundary, 'UTC'), '2026-03');
    assert.equal(getPeriodKey(justAfterUtcMonthBoundary, 'Africa/Maseru'), '2026-03');
    assert.equal(getPeriodKey(new Date('2026-02-28T23:30:00.000Z'), 'America/Los_Angeles'), '2026-02');
});

test('calculates category remaining from monthly totals and active cart items', () => {
    const category = { id: 'groceries', monthlyBudgetMinor: 100000 };
    const items = [
        { categoryId: 'groceries', amountMinor: 2500 },
        { categoryId: 'baby', amountMinor: 3000 },
        { categoryId: 'groceries', amountMinor: 1750 }
    ];

    assert.equal(getCartSpentMinor('groceries', items), 4250);
    assert.deepEqual(calculateBudgetSummary(category, 20000, items), {
        cartSpentMinor: 4250,
        totalSpentMinor: 24250,
        remainingMinor: 75750,
        usagePercent: 24.25
    });
});

test('caps usage display while preserving an over-budget remaining amount', () => {
    const summary = calculateBudgetSummary(
        { id: 'baby', monthlyBudgetMinor: 1000 },
        1200,
        [{ categoryId: 'baby', amountMinor: 500 }]
    );

    assert.equal(summary.remainingMinor, -700);
    assert.equal(summary.usagePercent, 100);
});