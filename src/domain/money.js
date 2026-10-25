const MINOR_UNITS_PER_MAJOR = 100;

export function parseMoneyToMinorUnits(value) {
    const normalized = String(value).trim();
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);

    if (!match) {
        throw new TypeError('Enter an amount with no more than two decimal places.');
    }

    const majorUnits = Number(match[1]);
    const minorPart = Number((match[2] || '').padEnd(2, '0'));
    const amountMinor = majorUnits * MINOR_UNITS_PER_MAJOR + minorPart;

    if (!Number.isSafeInteger(amountMinor)) {
        throw new RangeError('Amount is outside the supported range.');
    }

    return amountMinor;
}

export function formatMoney(amountMinor, symbol = 'M') {
    if (!Number.isSafeInteger(amountMinor)) {
        throw new TypeError('Money amounts must be safe integer minor units.');
    }

    const isNegative = amountMinor < 0;
    const absoluteAmount = Math.abs(amountMinor);
    const majorUnits = Math.floor(absoluteAmount / MINOR_UNITS_PER_MAJOR);
    const minorUnits = String(absoluteAmount % MINOR_UNITS_PER_MAJOR).padStart(2, '0');
    const formattedMajorUnits = majorUnits.toLocaleString('en-GB');

    return `${isNegative ? '-' : ''}${symbol} ${formattedMajorUnits}.${minorUnits}`;
}