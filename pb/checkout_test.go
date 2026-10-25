package pb

import (
	"reflect"
	"testing"
)

func TestNormalizeCartSortsClientIDs(t *testing.T) {
	items := []checkoutItem{
		{ClientID: "00000000-0000-4000-8000-000000000002", AmountMinor: 60, Category: "cat_b"},
		{ClientID: "00000000-0000-4000-8000-000000000001", AmountMinor: 40, Category: "cat_a"},
	}

	got, err := normalizeCart(items)
	if err != nil {
		t.Fatalf("normalizeCart() error = %v", err)
	}
	if got[0].ClientID != "00000000-0000-4000-8000-000000000001" {
		t.Fatalf("normalizeCart() first client ID = %q", got[0].ClientID)
	}
	if items[0].ClientID != "00000000-0000-4000-8000-000000000002" {
		t.Fatal("normalizeCart() modified the input cart")
	}
}

func TestNormalizeCartRejectsInvalidItems(t *testing.T) {
	valid := checkoutItem{
		ClientID:    "00000000-0000-4000-8000-000000000001",
		AmountMinor: 1,
		Category:    "cat_a",
	}
	tests := []struct {
		name  string
		items []checkoutItem
	}{
		{name: "empty cart"},
		{name: "invalid UUID", items: []checkoutItem{{ClientID: "invalid", AmountMinor: 1, Category: "cat_a"}}},
		{name: "zero amount", items: []checkoutItem{{ClientID: valid.ClientID, AmountMinor: 0, Category: "cat_a"}}},
		{name: "unsafe amount", items: []checkoutItem{{ClientID: valid.ClientID, AmountMinor: maximumSafeMinor + 1, Category: "cat_a"}}},
		{name: "missing category", items: []checkoutItem{{ClientID: valid.ClientID, AmountMinor: 1}}},
		{name: "duplicate client ID", items: []checkoutItem{valid, valid}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := normalizeCart(test.items); err == nil {
				t.Fatal("normalizeCart() accepted an invalid cart")
			}
		})
	}
}

func TestSumCartEnforcesJavaScriptSafeIntegerLimit(t *testing.T) {
	cart := []checkoutItem{{AmountMinor: maximumSafeMinor}}
	got, ok := sumCart(cart)
	if !ok || got != maximumSafeMinor {
		t.Fatalf("sumCart(maximumSafeMinor) = (%d, %t)", got, ok)
	}

	cart = append(cart, checkoutItem{AmountMinor: 1})
	if _, ok := sumCart(cart); ok {
		t.Fatal("sumCart() accepted a total above the safe integer limit")
	}
}

func TestFingerprintCartMatchesJavaScriptJSON(t *testing.T) {
	cart, err := normalizeCart([]checkoutItem{
		{ClientID: "00000000-0000-4000-8000-000000000002", AmountMinor: 60, Category: "cat_b"},
		{ClientID: "00000000-0000-4000-8000-000000000001", AmountMinor: 40, Category: "cat_a"},
	})
	if err != nil {
		t.Fatalf("normalizeCart() error = %v", err)
	}

	got := fingerprintCart(100, cart)
	want := "f57441386254e0d38159bc19d15c9e72c69c6967cd65170d8af9f80d801e58e1"
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("fingerprintCart() = %q, want %q", got, want)
	}
}
