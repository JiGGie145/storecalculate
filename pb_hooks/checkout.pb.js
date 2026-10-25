routerAdd('POST', '/api/ledger/checkout', (e) => {
    const CHECKOUT_ID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
    const CLIENT_ID_PATTERN = CHECKOUT_ID_PATTERN;
    const DEFAULT_TIME_ZONE = 'Africa/Maseru';
    const MAX_CART_ITEMS = 5000;

    function assertSafeMinorAmount(value, minimum = 0) {
        const amount = Number(value);
        if (!Number.isSafeInteger(amount) || amount < minimum) {
            throw new BadRequestError('Money values must be non-negative integer minor units.');
        }
        return amount;
    }

    function normalizeCart(items) {
        if (!Array.isArray(items) || items.length === 0 || items.length > MAX_CART_ITEMS) {
            throw new BadRequestError('The checkout cart is empty or too large.');
        }

        const seenClientIds = new Set();
        const cart = items.map(item => {
            const clientId = String(item?.client_id || '');
            const categoryId = String(item?.category || '');
            const amountMinor = assertSafeMinorAmount(item?.amount_minor, 1);

            if (!CLIENT_ID_PATTERN.test(clientId) || !categoryId || seenClientIds.has(clientId)) {
                throw new BadRequestError('The checkout cart contains an invalid item.');
            }

            seenClientIds.add(clientId);
            return { client_id: clientId, amount_minor: amountMinor, category: categoryId };
        });

        return cart.sort((left, right) => left.client_id.localeCompare(right.client_id));
    }

    function fingerprintCart(totalMinor, cart) {
        return $security.sha256(JSON.stringify({
            expected_total_minor: totalMinor,
            expected_cart: cart
        }));
    }

    function findFirst(app, collection, filter, params) {
        const records = app.findRecordsByFilter(collection, filter, '', 1, 0, params);
        return records.length > 0 ? records[0] : null;
    }

    function checkoutResponse(record) {
        return {
            checkout_id: record.getString('checkout_id'),
            total_minor: record.get('total_minor'),
            items_count: record.get('items_count'),
            period_key: record.getString('period_key'),
            time_zone: record.getString('time_zone')
        };
    }

    const userId = e.auth.id;
    const body = e.requestInfo().body;
    const checkoutId = String(body.checkout_id || '');
    const expectedTotalMinor = assertSafeMinorAmount(body.expected_total_minor);
    const expectedCart = normalizeCart(body.expected_cart);
    const calculatedExpectedTotal = expectedCart.reduce((total, item) => total + item.amount_minor, 0);

    if (!CHECKOUT_ID_PATTERN.test(checkoutId)) {
        throw new BadRequestError('A valid checkout ID is required.');
    }
    if (!Number.isSafeInteger(calculatedExpectedTotal) || calculatedExpectedTotal !== expectedTotalMinor) {
        throw new BadRequestError('The confirmed cart total does not match its items.');
    }

    const fingerprint = fingerprintCart(expectedTotalMinor, expectedCart);
    let result;

    e.app.runInTransaction((txApp) => {
        const priorCheckout = findFirst(
            txApp,
            'checkouts',
            'user = {:user} && checkout_id = {:checkoutId}',
            { user: userId, checkoutId }
        );

        if (priorCheckout) {
            if (priorCheckout.getString('request_fingerprint') !== fingerprint) {
                throw new ApiError(409, 'This checkout ID was already used for a different cart.');
            }
            result = checkoutResponse(priorCheckout);
            return;
        }

        const expenses = txApp.findRecordsByFilter(
            'expenses',
            'user = {:user}',
            '-client_created_at',
            0,
            0,
            { user: userId }
        );
        const currentCart = normalizeCart(expenses.map(expense => ({
            client_id: expense.getString('client_id'),
            amount_minor: expense.get('amount_minor'),
            category: expense.getString('category')
        })));
        const currentTotalMinor = currentCart.reduce((total, item) => total + item.amount_minor, 0);
        const currentFingerprint = fingerprintCart(currentTotalMinor, currentCart);

        if (!Number.isSafeInteger(currentTotalMinor) || currentFingerprint !== fingerprint) {
            throw new ApiError(409, 'The shared cart changed after confirmation. Refresh and retry checkout.');
        }

        const timeZone = e.auth.getString('timezone') || DEFAULT_TIME_ZONE;
        const location = new Timezone(timeZone);
        if (location.string() !== timeZone) {
            throw new BadRequestError('The account timezone is invalid.');
        }

        const now = new DateTime();
        const periodKey = now.time().in(location).format('2006-01');
        const categories = txApp.findRecordsByFilter(
            'categories',
            'user = {:user}',
            '',
            0,
            0,
            { user: userId }
        );
        const categoryIds = new Set(categories.map(category => category.id));
        const totalsByCategory = new Map();

        for (const item of currentCart) {
            if (!categoryIds.has(item.category)) {
                throw new ApiError(409, 'An item no longer belongs to an account category.');
            }
            totalsByCategory.set(item.category, (totalsByCategory.get(item.category) || 0) + item.amount_minor);
        }

        const totalsCollection = txApp.findCollectionByNameOrId('category_monthly_totals');
        for (const [categoryId, spentMinor] of totalsByCategory) {
            const existingTotal = findFirst(
                txApp,
                'category_monthly_totals',
                'user = {:user} && category = {:category} && period_key = {:period}',
                { user: userId, category: categoryId, period: periodKey }
            );
            const previousSpentMinor = existingTotal ? Number(existingTotal.get('spent_minor')) : 0;
            const updatedSpentMinor = previousSpentMinor + spentMinor;

            if (!Number.isSafeInteger(updatedSpentMinor)) {
                throw new RangeError('Monthly total exceeds the supported amount range.');
            }

            const totalRecord = existingTotal || new Record(totalsCollection);
            totalRecord.set('user', userId);
            totalRecord.set('category', categoryId);
            totalRecord.set('period_key', periodKey);
            totalRecord.set('time_zone', timeZone);
            totalRecord.set('spent_minor', updatedSpentMinor);
            txApp.save(totalRecord);
        }

        for (const expense of expenses) {
            txApp.delete(expense);
        }

        const checkoutsCollection = txApp.findCollectionByNameOrId('checkouts');
        const receipt = new Record(checkoutsCollection);
        receipt.set('user', userId);
        receipt.set('checkout_id', checkoutId);
        receipt.set('request_fingerprint', fingerprint);
        receipt.set('total_minor', currentTotalMinor);
        receipt.set('items_count', currentCart.length);
        receipt.set('period_key', periodKey);
        receipt.set('time_zone', timeZone);
        txApp.save(receipt);

        result = checkoutResponse(receipt);
    });

    return e.json(200, result);
}, $apis.requireAuth('users'));