package pb

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const (
	checkoutRoute        = "/api/ledger/checkout"
	defaultTimeZone      = "Africa/Maseru"
	maximumCartItemCount = 5000
	maximumSafeMinor     = 1<<53 - 1
)

var uuidPattern = regexp.MustCompile(`(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

type checkoutRequest struct {
	CheckoutID         string         `json:"checkout_id"`
	ExpectedTotalMinor int64          `json:"expected_total_minor"`
	ExpectedCart       []checkoutItem `json:"expected_cart"`
}

type checkoutItem struct {
	ClientID    string `json:"client_id"`
	AmountMinor int64  `json:"amount_minor"`
	Category    string `json:"category"`
}

type checkoutResponse struct {
	CheckoutID string `json:"checkout_id"`
	TotalMinor int64  `json:"total_minor"`
	ItemsCount int    `json:"items_count"`
	PeriodKey  string `json:"period_key"`
	TimeZone   string `json:"time_zone"`
}

func RegisterRoutes(app core.App) {
	app.OnServe().BindFunc(func(event *core.ServeEvent) error {
		event.Router.POST(checkoutRoute, handleCheckout).Bind(apis.RequireAuth("users"))
		return event.Next()
	})
}

func handleCheckout(event *core.RequestEvent) error {
	var request checkoutRequest
	if err := event.BindBody(&request); err != nil {
		return event.BadRequestError("Invalid checkout request.", err)
	}
	if !uuidPattern.MatchString(request.CheckoutID) {
		return event.BadRequestError("A valid checkout ID is required.", nil)
	}
	if request.ExpectedTotalMinor < 0 || request.ExpectedTotalMinor > maximumSafeMinor {
		return event.BadRequestError("The confirmed total must be a safe non-negative integer.", nil)
	}
	if len(request.ExpectedCart) == 0 || len(request.ExpectedCart) > maximumCartItemCount {
		return event.BadRequestError("The checkout cart is empty or too large.", nil)
	}

	expectedCart, err := normalizeCart(request.ExpectedCart)
	if err != nil {
		return event.BadRequestError("The checkout cart contains an invalid item.", err)
	}
	expectedTotal, ok := sumCart(expectedCart)
	if !ok || expectedTotal != request.ExpectedTotalMinor {
		return event.BadRequestError("The confirmed cart total does not match its items.", nil)
	}
	fingerprint := fingerprintCart(expectedTotal, expectedCart)

	var result checkoutResponse
	err = event.App.RunInTransaction(func(txApp core.App) error {
		priorRecords, err := txApp.FindRecordsByFilter(
			"checkouts",
			"user = {:user} && checkout_id = {:checkoutId}",
			"",
			1,
			0,
			dbx.Params{"user": event.Auth.Id, "checkoutId": request.CheckoutID},
		)
		if err != nil {
			return err
		}
		if len(priorRecords) > 0 {
			prior := priorRecords[0]
			if prior.GetString("request_fingerprint") != fingerprint {
				return apis.NewApiError(http.StatusConflict, "This checkout ID was already used for a different cart.", nil)
			}
			result = responseFromRecord(prior)
			return nil
		}

		expenses, err := txApp.FindRecordsByFilter(
			"expenses",
			"user = {:user}",
			"-client_created_at",
			0,
			0,
			dbx.Params{"user": event.Auth.Id},
		)
		if err != nil {
			return err
		}
		if len(expenses) == 0 {
			return apis.NewApiError(http.StatusConflict, "The shared cart changed after confirmation. Refresh and retry checkout.", nil)
		}

		currentItems := make([]checkoutItem, 0, len(expenses))
		for _, expense := range expenses {
			currentItems = append(currentItems, checkoutItem{
				ClientID:    expense.GetString("client_id"),
				AmountMinor: int64(expense.GetFloat("amount_minor")),
				Category:    expense.GetString("category"),
			})
		}
		currentCart, err := normalizeCart(currentItems)
		if err != nil {
			return event.InternalServerError("The stored cart contains an invalid item.", err)
		}
		currentTotal, ok := sumCart(currentCart)
		if !ok || fingerprintCart(currentTotal, currentCart) != fingerprint {
			return apis.NewApiError(http.StatusConflict, "The shared cart changed after confirmation. Refresh and retry checkout.", nil)
		}

		timeZone := event.Auth.GetString("timezone")
		if timeZone == "" {
			timeZone = defaultTimeZone
		}
		location, err := time.LoadLocation(timeZone)
		if err != nil {
			return event.BadRequestError("The account timezone is invalid.", err)
		}
		periodKey := time.Now().In(location).Format("2006-01")

		categories, err := txApp.FindRecordsByFilter(
			"categories",
			"user = {:user}",
			"",
			0,
			0,
			dbx.Params{"user": event.Auth.Id},
		)
		if err != nil {
			return err
		}
		categoryIDs := make(map[string]struct{}, len(categories))
		for _, category := range categories {
			categoryIDs[category.Id] = struct{}{}
		}

		totalsByCategory := make(map[string]int64)
		for _, item := range currentCart {
			if _, ok := categoryIDs[item.Category]; !ok {
				return apis.NewApiError(http.StatusConflict, "An item no longer belongs to an account category.", nil)
			}
			if item.AmountMinor > maximumSafeMinor-totalsByCategory[item.Category] {
				return event.InternalServerError("A category total exceeds the supported amount range.", nil)
			}
			totalsByCategory[item.Category] += item.AmountMinor
		}

		totalsCollection, err := txApp.FindCollectionByNameOrId("category_monthly_totals")
		if err != nil {
			return err
		}
		categoryIDsToUpdate := make([]string, 0, len(totalsByCategory))
		for categoryID := range totalsByCategory {
			categoryIDsToUpdate = append(categoryIDsToUpdate, categoryID)
		}
		sort.Strings(categoryIDsToUpdate)

		for _, categoryID := range categoryIDsToUpdate {
			spentMinor := totalsByCategory[categoryID]
			existing, err := txApp.FindRecordsByFilter(
				"category_monthly_totals",
				"user = {:user} && category = {:category} && period_key = {:period}",
				"",
				1,
				0,
				dbx.Params{"user": event.Auth.Id, "category": categoryID, "period": periodKey},
			)
			if err != nil {
				return err
			}

			var totalRecord *core.Record
			var previousSpent int64
			if len(existing) > 0 {
				totalRecord = existing[0]
				previousSpent = int64(totalRecord.GetFloat("spent_minor"))
			} else {
				totalRecord = core.NewRecord(totalsCollection)
			}
			if previousSpent < 0 || spentMinor > maximumSafeMinor-previousSpent {
				return event.InternalServerError("A category total exceeds the supported amount range.", nil)
			}

			totalRecord.Set("user", event.Auth.Id)
			totalRecord.Set("category", categoryID)
			totalRecord.Set("period_key", periodKey)
			totalRecord.Set("time_zone", timeZone)
			totalRecord.Set("spent_minor", previousSpent+spentMinor)
			if err := txApp.Save(totalRecord); err != nil {
				return err
			}
		}

		for _, expense := range expenses {
			if err := txApp.Delete(expense); err != nil {
				return err
			}
		}

		checkoutsCollection, err := txApp.FindCollectionByNameOrId("checkouts")
		if err != nil {
			return err
		}
		receipt := core.NewRecord(checkoutsCollection)
		receipt.Set("user", event.Auth.Id)
		receipt.Set("checkout_id", request.CheckoutID)
		receipt.Set("request_fingerprint", fingerprint)
		receipt.Set("total_minor", currentTotal)
		receipt.Set("items_count", len(currentCart))
		receipt.Set("period_key", periodKey)
		receipt.Set("time_zone", timeZone)
		if err := txApp.Save(receipt); err != nil {
			return err
		}

		result = responseFromRecord(receipt)
		return nil
	})
	if err != nil {
		return err
	}

	return event.JSON(http.StatusOK, result)
}

func normalizeCart(items []checkoutItem) ([]checkoutItem, error) {
	if len(items) == 0 || len(items) > maximumCartItemCount {
		return nil, apis.NewApiError(http.StatusBadRequest, "The checkout cart is empty or too large.", nil)
	}

	seen := make(map[string]struct{}, len(items))
	cart := append([]checkoutItem(nil), items...)
	for _, item := range cart {
		if !uuidPattern.MatchString(item.ClientID) || item.AmountMinor <= 0 || item.AmountMinor > maximumSafeMinor || item.Category == "" {
			return nil, apis.NewApiError(http.StatusBadRequest, "The checkout cart contains an invalid item.", nil)
		}
		if _, exists := seen[item.ClientID]; exists {
			return nil, apis.NewApiError(http.StatusBadRequest, "The checkout cart contains a duplicate item ID.", nil)
		}
		seen[item.ClientID] = struct{}{}
	}

	sort.Slice(cart, func(left, right int) bool {
		return cart[left].ClientID < cart[right].ClientID
	})

	return cart, nil
}

func sumCart(cart []checkoutItem) (int64, bool) {
	var total int64
	for _, item := range cart {
		if item.AmountMinor > maximumSafeMinor-total {
			return 0, false
		}
		total += item.AmountMinor
	}
	return total, true
}

func fingerprintCart(total int64, cart []checkoutItem) string {
	data, _ := json.Marshal(struct {
		ExpectedTotalMinor int64          `json:"expected_total_minor"`
		ExpectedCart       []checkoutItem `json:"expected_cart"`
	}{ExpectedTotalMinor: total, ExpectedCart: cart})
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func responseFromRecord(record *core.Record) checkoutResponse {
	return checkoutResponse{
		CheckoutID: record.GetString("checkout_id"),
		TotalMinor: int64(record.GetFloat("total_minor")),
		ItemsCount: record.GetInt("items_count"),
		PeriodKey:  record.GetString("period_key"),
		TimeZone:   record.GetString("time_zone"),
	}
}
