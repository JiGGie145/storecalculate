package migrations

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

var zero = float64(0)
var one = float64(1)

var managedCollectionNames = []string{
	"categories",
	"expenses",
	"category_monthly_totals",
	"checkouts",
}

var requiredFields = map[string][]string{
	"categories":              {"name", "icon", "monthly_budget_minor", "color_code", "active", "user"},
	"expenses":                {"client_id", "amount_minor", "name", "category", "user", "client_created_at"},
	"category_monthly_totals": {"user", "category", "period_key", "time_zone", "spent_minor"},
	"checkouts":               {"user", "checkout_id", "request_fingerprint", "total_minor", "items_count", "period_key", "time_zone"},
}

func init() {
	m.Register(upSchema, nil, "20261025000000_initial_ledger_schema.go")
}

func upSchema(app core.App) error {
	existingCollections := make(map[string]*core.Collection, len(managedCollectionNames))
	for _, name := range managedCollectionNames {
		collection, err := app.FindCollectionByNameOrId(name)
		if err == nil {
			existingCollections[name] = collection
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	if len(existingCollections) != 0 && len(existingCollections) != len(managedCollectionNames) {
		return fmt.Errorf("refusing to modify a partial existing Ledger Flow schema")
	}

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		users = core.NewAuthCollection("users")
		users.ListRule = types.Pointer("id = @request.auth.id")
		users.ViewRule = types.Pointer("id = @request.auth.id")
		users.CreateRule = nil
		users.UpdateRule = types.Pointer("id = @request.auth.id")
		users.DeleteRule = nil
	}

	if len(existingCollections) == len(managedCollectionNames) {
		for name, collection := range existingCollections {
			for _, fieldName := range requiredFields[name] {
				if collection.Fields.GetByName(fieldName) == nil {
					return fmt.Errorf("refusing to modify an incomplete %s collection: missing %s field", name, fieldName)
				}
			}
		}
	}

	if users.Fields.GetByName("timezone") == nil {
		users.Fields.Add(&core.TextField{
			Name: "timezone",
			Max:  64,
			Help: "IANA timezone used to calculate monthly budget periods.",
		})
		if err := app.Save(users); err != nil {
			return err
		}
	}
	if len(existingCollections) == len(managedCollectionNames) {
		return nil
	}
	if err := app.Save(users); err != nil {
		return err
	}

	categories := core.NewBaseCollection("categories")
	categories.ListRule = types.Pointer("user = @request.auth.id")
	categories.ViewRule = types.Pointer("user = @request.auth.id")
	categories.Fields.Add(
		&core.TextField{Name: "name", Required: true, Max: 80, Presentable: true},
		&core.TextField{Name: "icon", Max: 32},
		&core.NumberField{Name: "monthly_budget_minor", Min: &zero, OnlyInt: true},
		&core.TextField{Name: "color_code", Max: 32},
		&core.BoolField{Name: "active"},
		&core.RelationField{Name: "user", Required: true, MaxSelect: 1, CollectionId: users.Id, CascadeDelete: false},
	)
	categories.Indexes = []string{
		"CREATE INDEX idx_categories_user ON categories (user)",
		"CREATE INDEX idx_categories_active ON categories (user, active)",
	}
	if err := app.Save(categories); err != nil {
		return err
	}

	expenses := core.NewBaseCollection("expenses")
	expenses.ListRule = types.Pointer("user = @request.auth.id")
	expenses.ViewRule = types.Pointer("user = @request.auth.id")
	expenses.CreateRule = types.Pointer("user = @request.auth.id && category.user = @request.auth.id")
	expenses.DeleteRule = types.Pointer("user = @request.auth.id")
	expenses.Fields.Add(
		&core.TextField{Name: "client_id", Required: true, Max: 36, Pattern: `^[a-fA-F0-9-]{36}$`},
		&core.NumberField{Name: "amount_minor", Required: true, Min: &one, OnlyInt: true},
		&core.TextField{Name: "name", Max: 120},
		&core.RelationField{Name: "category", Required: true, MaxSelect: 1, CollectionId: categories.Id, CascadeDelete: false},
		&core.RelationField{Name: "user", Required: true, MaxSelect: 1, CollectionId: users.Id, CascadeDelete: false},
		&core.DateField{Name: "client_created_at", Required: true},
	)
	expenses.Indexes = []string{
		"CREATE UNIQUE INDEX idx_expenses_user_client ON expenses (user, client_id)",
		"CREATE INDEX idx_expenses_user_created ON expenses (user, client_created_at DESC)",
	}
	if err := app.Save(expenses); err != nil {
		return err
	}

	monthlyTotals := core.NewBaseCollection("category_monthly_totals")
	monthlyTotals.ListRule = types.Pointer("user = @request.auth.id")
	monthlyTotals.ViewRule = types.Pointer("user = @request.auth.id")
	monthlyTotals.Fields.Add(
		&core.RelationField{Name: "user", Required: true, MaxSelect: 1, CollectionId: users.Id, CascadeDelete: false},
		&core.RelationField{Name: "category", Required: true, MaxSelect: 1, CollectionId: categories.Id, CascadeDelete: false},
		&core.TextField{Name: "period_key", Required: true, Max: 7, Pattern: `^\d{4}-\d{2}$`},
		&core.TextField{Name: "time_zone", Required: true, Max: 64},
		&core.NumberField{Name: "spent_minor", Min: &zero, OnlyInt: true},
	)
	monthlyTotals.Indexes = []string{
		"CREATE UNIQUE INDEX idx_category_monthly_totals_period ON category_monthly_totals (user, category, period_key)",
		"CREATE INDEX idx_category_monthly_totals_user_period ON category_monthly_totals (user, period_key)",
	}
	if err := app.Save(monthlyTotals); err != nil {
		return err
	}

	checkouts := core.NewBaseCollection("checkouts")
	checkouts.Fields.Add(
		&core.RelationField{Name: "user", Required: true, MaxSelect: 1, CollectionId: users.Id, CascadeDelete: false},
		&core.TextField{Name: "checkout_id", Required: true, Max: 36, Pattern: `^[a-fA-F0-9-]{36}$`},
		&core.TextField{Name: "request_fingerprint", Required: true, Max: 64},
		&core.NumberField{Name: "total_minor", Min: &zero, OnlyInt: true},
		&core.NumberField{Name: "items_count", Min: &zero, OnlyInt: true},
		&core.TextField{Name: "period_key", Required: true, Max: 7},
		&core.TextField{Name: "time_zone", Required: true, Max: 64},
	)
	checkouts.Indexes = []string{
		"CREATE UNIQUE INDEX idx_checkouts_user_checkout ON checkouts (user, checkout_id)",
	}
	return app.Save(checkouts)
}
