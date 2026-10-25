migrate((app) => {
    for (const name of ['categories', 'expenses', 'category_monthly_totals', 'checkouts']) {
        try {
            app.findCollectionByNameOrId(name);
            throw new Error(`Refusing to overwrite the existing ${name} collection.`);
        } catch (error) {
            if (error?.message?.startsWith('Refusing to overwrite')) throw error;
        }
    }

    let users;
    try {
        users = app.findCollectionByNameOrId('users');
    } catch {
        users = null;
    }

    if (!users) {
        users = new Collection({
            type: 'auth',
            name: 'users',
            listRule: 'id = @request.auth.id',
            viewRule: 'id = @request.auth.id',
            createRule: null,
            updateRule: 'id = @request.auth.id',
            deleteRule: null,
            fields: [
                {
                    type: 'text',
                    name: 'timezone',
                    max: 64,
                    help: 'IANA timezone used to calculate monthly budget periods.'
                }
            ]
        });
        app.save(users);
    } else {
        let timezoneField;
        try {
            timezoneField = users.fields.getByName('timezone');
        } catch {
            timezoneField = null;
        }

        if (!timezoneField) {
            users.fields.add(new TextField({
                name: 'timezone',
                max: 64,
                help: 'IANA timezone used to calculate monthly budget periods.'
            }));
            app.save(users);
        }
    }

    app.save(new Collection({
        type: 'base',
        name: 'categories',
        listRule: 'user = @request.auth.id',
        viewRule: 'user = @request.auth.id',
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            {
                type: 'text',
                name: 'name',
                required: true,
                max: 80,
                presentable: true
            },
            {
                type: 'text',
                name: 'icon',
                max: 32
            },
            {
                type: 'number',
                name: 'monthly_budget_minor',
                min: 0,
                onlyInt: true
            },
            {
                type: 'text',
                name: 'color_code',
                max: 32
            },
            {
                type: 'bool',
                name: 'active'
            },
            {
                type: 'relation',
                name: 'user',
                required: true,
                maxSelect: 1,
                collectionId: users.id,
                cascadeDelete: false
            }
        ],
        indexes: [
            'CREATE INDEX idx_categories_user ON categories (user)',
            'CREATE INDEX idx_categories_active ON categories (user, active)'
        ]
    }));

    app.save(new Collection({
        type: 'base',
        name: 'expenses',
        listRule: 'user = @request.auth.id',
        viewRule: 'user = @request.auth.id',
        createRule: 'user = @request.auth.id && category.user = @request.auth.id',
        updateRule: null,
        deleteRule: 'user = @request.auth.id',
        fields: [
            {
                type: 'text',
                name: 'client_id',
                required: true,
                max: 36,
                pattern: '^[a-fA-F0-9-]{36}$'
            },
            {
                type: 'number',
                name: 'amount_minor',
                required: true,
                min: 1,
                onlyInt: true
            },
            {
                type: 'text',
                name: 'name',
                max: 120
            },
            {
                type: 'relation',
                name: 'category',
                required: true,
                maxSelect: 1,
                collectionId: app.findCollectionByNameOrId('categories').id,
                cascadeDelete: false
            },
            {
                type: 'relation',
                name: 'user',
                required: true,
                maxSelect: 1,
                collectionId: users.id,
                cascadeDelete: false
            },
            {
                type: 'date',
                name: 'client_created_at',
                required: true
            }
        ],
        indexes: [
            'CREATE UNIQUE INDEX idx_expenses_user_client ON expenses (user, client_id)',
            'CREATE INDEX idx_expenses_user_created ON expenses (user, client_created_at DESC)'
        ]
    }));

    app.save(new Collection({
        type: 'base',
        name: 'category_monthly_totals',
        listRule: 'user = @request.auth.id',
        viewRule: 'user = @request.auth.id',
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            {
                type: 'relation',
                name: 'user',
                required: true,
                maxSelect: 1,
                collectionId: users.id,
                cascadeDelete: false
            },
            {
                type: 'relation',
                name: 'category',
                required: true,
                maxSelect: 1,
                collectionId: app.findCollectionByNameOrId('categories').id,
                cascadeDelete: false
            },
            {
                type: 'text',
                name: 'period_key',
                required: true,
                max: 7,
                pattern: '^\\d{4}-\\d{2}$'
            },
            {
                type: 'text',
                name: 'time_zone',
                required: true,
                max: 64
            },
            {
                type: 'number',
                name: 'spent_minor',
                min: 0,
                onlyInt: true
            }
        ],
        indexes: [
            'CREATE UNIQUE INDEX idx_category_monthly_totals_period ON category_monthly_totals (user, category, period_key)',
            'CREATE INDEX idx_category_monthly_totals_user_period ON category_monthly_totals (user, period_key)'
        ]
    }));

    app.save(new Collection({
        type: 'base',
        name: 'checkouts',
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
            {
                type: 'relation',
                name: 'user',
                required: true,
                maxSelect: 1,
                collectionId: users.id,
                cascadeDelete: false
            },
            {
                type: 'text',
                name: 'checkout_id',
                required: true,
                max: 36,
                pattern: '^[a-fA-F0-9-]{36}$'
            },
            {
                type: 'text',
                name: 'request_fingerprint',
                required: true,
                max: 64
            },
            {
                type: 'number',
                name: 'total_minor',
                min: 0,
                onlyInt: true
            },
            {
                type: 'number',
                name: 'items_count',
                min: 0,
                onlyInt: true
            },
            {
                type: 'text',
                name: 'period_key',
                required: true,
                max: 7
            },
            {
                type: 'text',
                name: 'time_zone',
                required: true,
                max: 64
            }
        ],
        indexes: [
            'CREATE UNIQUE INDEX idx_checkouts_user_checkout ON checkouts (user, checkout_id)'
        ]
    }));
}, (app) => {
    for (const name of ['checkouts', 'category_monthly_totals', 'expenses', 'categories']) {
        try {
            app.delete(app.findCollectionByNameOrId(name));
        } catch {
            continue;
        }
    }
});