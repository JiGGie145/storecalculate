# Ledger Flow

A mobile-first, offline-first shopping ledger. It tracks a shared cart against administrator-managed monthly category budgets. Amounts use integer minor units and fixed Lesotho loti (`LSL`, shown as `M`). The account timezone defaults to `Africa/Maseru` and determines the monthly budget period.

## Requirements

- Node.js 22.12 or newer
- Go 1.27 or newer
- PocketBase Go module v0.40.6 (pinned in `go.mod`)

## PocketBase Setup

1. Create a local superuser once:

   ```sh
   go run . --dir pb_data superuser create <admin-email> <admin-password>
   ```

2. Start the custom Go PocketBase app from the project root. It binds to localhost, registers the checkout route in Go, and applies compiled Go migrations:

   ```sh
   go run . --dir pb_data serve --http=127.0.0.1:8090
   ```

   PocketBase applies pending migrations on startup. Open `http://127.0.0.1:8090/_/` to manage users and budgets.
3. The initial Go migration creates the `users`, `categories`, `expenses`, `category_monthly_totals`, and `checkouts` schema and adds `users.timezone`. On a database created by the earlier JavaScript migration, it verifies the existing collections and fields, preserves all records, and records the Go migration without recreating the schema. It refuses partial schemas. Back up existing PocketBase data before deploying migrations.
4. Set each user's `timezone` to a valid IANA timezone, such as `Africa/Maseru`. Create one `categories` record per budget with `name`, `icon`, `monthly_budget_minor`, `color_code`, `active`, and `user`. `monthly_budget_minor` is an integer in LSL thebe (for example, `15000` is `M 150.00`). Set `active` to true and assign the category to its user. Category management is intentionally not available in the app.

To build a Linux binary on macOS, choose the target architecture for the Ubuntu machine (`uname -m` reports `x86_64` for amd64 and `aarch64` for arm64):

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/ledgerflow-linux-amd64 .
```

Use `GOARCH=arm64` and a matching output name for Ubuntu on ARM64. Copy the resulting binary to the Ubuntu host, then run it with `--dir pb_data serve --http=0.0.0.0:8090` (or the desired bind address). Do not run the macOS `bin/pocketbase` executable on Linux.

The checkout route is authenticated and atomic. It verifies the confirmed cart snapshot, aggregates checked-out expenses by account-local month and category, clears the active expenses, and saves a minimal idempotency receipt in one transaction. A changed cart returns `409`; retrying the same confirmed request uses the same checkout ID. Archived categories are hidden from new entry buttons, but already queued expenses remain check-outable while the category still belongs to the account.

## Frontend Setup

1. Install dependencies and configure the PocketBase URL:

   ```sh
   npm install
   cp .env.example .env.local
   ```

2. Set `VITE_POCKETBASE_URL` in `.env.local` (the default local URL is `http://127.0.0.1:8090`).
3. Start the app with `npm run dev`, or run `npm test` and `npm run build` for validation.

The cart and outbox are cached per account in IndexedDB. Adds and removals can queue offline; checkout requires a connection. The service worker caches the app shell and static assets, never PocketBase API responses.

On first sign-in, a one-time importer checks the old `ledger_flow_app_state` localStorage value. It queues only valid LSL cart items that map unambiguously to an active account category. It does not import cash limits, currency settings, or legacy budget allocations. The original localStorage value is removed only after all imported items sync successfully and the stored cart still matches the imported snapshot. Unsupported currency, malformed data, or unmatched categories are left untouched for manual recovery.

`shopping_budget_calculator.html` redirects to the app at `/`. The separate `calculator.html` prototype is unchanged.

## Validation Notes

`go test ./...` covers checkout validation, safe integer bounds, and fingerprints compatible with the previous JavaScript implementation. A Linux amd64 cross-build is supported. `npm test` covers money/budget calculations and legacy import mapping; `npm run build` checks the production frontend bundle. The Go checkout route is authenticated and atomic, and retrying a confirmed request returns its existing receipt.
