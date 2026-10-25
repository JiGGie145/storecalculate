export const DEFAULT_TIME_ZONE = 'Africa/Maseru';

export function getPeriodKey(value = new Date(), timeZone = DEFAULT_TIME_ZONE) {
    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new TypeError('A valid date is required to calculate the budget period.');
    }

    const parts = new Intl.DateTimeFormat('en', {
        timeZone,
        year: 'numeric',
        month: '2-digit'
    }).formatToParts(date);
    const year = parts.find(part => part.type === 'year')?.value;
    const month = parts.find(part => part.type === 'month')?.value;

    if (!year || !month) {
        throw new RangeError(`Invalid time zone: ${timeZone}`);
    }

    return `${year}-${month}`;
}

export function getCartSpentMinor(categoryId, items) {
    return items.reduce((total, item) => {
        return item.categoryId === categoryId ? total + item.amountMinor : total;
    }, 0);
}

export function calculateBudgetSummary(category, monthlySpentMinor, items) {
    const cartSpentMinor = getCartSpentMinor(category.id, items);
    const totalSpentMinor = monthlySpentMinor + cartSpentMinor;
    const remainingMinor = category.monthlyBudgetMinor - totalSpentMinor;
    const usagePercent = category.monthlyBudgetMinor === 0
        ? (totalSpentMinor > 0 ? 100 : 0)
        : Math.min(100, Math.max(0, (totalSpentMinor / category.monthlyBudgetMinor) * 100));

    return {
        cartSpentMinor,
        totalSpentMinor,
        remainingMinor,
        usagePercent
    };
}