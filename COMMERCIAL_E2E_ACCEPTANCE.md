# Commercial Module — E2E Acceptance Record

All tests below were executed live against production
(`gxkrtlvpjwxhcqdisyob`) via RLS impersonation, not simulated or
assumed. Evidence labels follow the project's own established
taxonomy — see COMMERCIAL_RISK_REGISTER.md for what remains
environment-blocked and why.

## Mandated accounting scenario (directive Section 116) — LIVE E2E VERIFIED

Product price 500, opening stock 10 → sell 2 → invoice 1000 → pay 1000
→ stock 8 → return 1 → refund 500 → stock 9 → net financial result
500, sale history shows 2 sold / 1 returned, zero double-counting
across `invoices`/`payments`/`invoice_items`/`shop_sale_items`.

**Result: exact match at every step.**

## Security attack matrix — LIVE E2E VERIFIED (all denies confirmed)

| Attack | Result |
|---|---|
| Quantity = 0 or negative | DENIED (`quantity must be positive`) |
| Return quantity exceeding remaining sold | DENIED, exact remaining amount quoted |
| Cross-club product injection into a sale | DENIED (`product not found or inactive`) |
| Cross-club location injection (receive/transfer) | DENIED (`not authorized` / `not found`) |
| Mismatched product/variant pair | DENIED (`variant not found or inactive for this product`) |
| Cross-sale `sale_item_id` injection into a return | DENIED (`this item does not belong to the specified sale`) |
| Direct RPC call with the Shop module disabled | DENIED (`the shop module is not active for this club`) |
| Ordinary club owner calling a platform-only RPC | DENIED (`not authorized`) |
| Price tampering (client sends a fabricated `unit_price`) | IGNORED — server recomputed the real price from the live product row; invoice showed the correct amount, not the tampered one |
| Archived product/variant, attempt to sell | DENIED (`product/variant not found or inactive`) |

## Master Admin + Shop — LIVE E2E VERIFIED

- VIEW-mode support session: Shop reads succeed, Shop mutation denied.
- MANAGE-mode support session: Shop mutation succeeds, audit trail
  correctly shows `acting_as_platform_admin=true` +
  `support_session_id` set — dual-written alongside the normal audit
  row, actor always the real platform owner (never spoofed).
- Cross-club mutation attempted while a Club A support session is
  active: DENIED.

## Platform Staff + Shop — LIVE E2E VERIFIED

A restricted QA Platform Staff role holding only `platform.club.view`
+ `platform.support.start_view` (no `start_manage`):

1. Starts a VIEW support session for a test club: ALLOWED.
2. Reads Shop products via the VIEW session: ALLOWED.
3. Attempts to create a product via the same VIEW session: DENIED.
4. Attempts to start a MANAGE support session: DENIED (`not
   authorized`, no `platform.support.start_manage`).

Matches directive Section 30/58's exact dynamic-enforcement
requirement — proven live, not asserted from code review.

## Idempotency — LIVE E2E VERIFIED

- `create_shop_sale` called twice with an identical idempotency key:
  second call returned the same `sale_id`; exactly one row in
  `shop_sales`/`payments`/`shop_inventory_movements`.
- `return_shop_sale` called twice with an identical idempotency key
  (including a refund on both calls): second call returned the same
  `return_id`; exactly one `shop_sale_returns` row and exactly one
  real `refunds` row.

## Inventory reconciliation — LIVE E2E VERIFIED (and one critical bug found + fixed)

A tracked sequence (receive → receive → sell → return → adjust →
transfer) was verified to reconcile exactly against the movement
ledger's own running total at every step, both before and after fixing
the critical balance-duplication bug documented in
COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 10 and INVENTORY_INVARIANTS.md
Section 5.

## Variant/product lifecycle — LIVE E2E VERIFIED

- Archiving a product mid-session: subsequent sale attempt DENIED
  server-side (not just hidden in the UI).
- Archiving a variant: subsequent sale attempt citing that variant
  DENIED server-side.
- Reactivating either restores sellability.

## Customer 360 — CODE VERIFIED, SERVER VERIFIED

`get_customer_shop_purchases()` reuses the canonical `customers.id`
identity exclusively; permission-gated identically to every other
Customer 360 tab (`customer.view`). Not independently click-through
verified in the live deployed UI (see COMMERCIAL_RISK_REGISTER.md —
AUTH ENVIRONMENT-BLOCKED).

## Build/lint/test gate — PASS, re-verified after every migration batch

`npm run build` (the authoritative `tsc -b` check, not `--noEmit`
alone — this project's own established discrepancy), `npx eslint src
--max-warnings 0` (zero new warnings against the pre-existing 9-warning
baseline, confirmed identical via `git stash` comparison), `npx vitest
run` (106/106 active tests passing throughout), and a secret scan
(`git grep` for a hardcoded service-role key pattern — clean) were all
re-run and confirmed clean after every migration/frontend batch in
this build, not just once at the end.

## Migration parity

Every migration's local filename matches its real applied
`(version, name)` pair in `supabase_migrations.schema_migrations`,
re-verified explicitly before each commit throughout this build.
