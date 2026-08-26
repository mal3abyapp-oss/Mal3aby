# Commercial Risk Register

Honest accounting of what remains unverified or intentionally
deferred, as of this closure. Not a list of known bugs — every item
below is either a genuine environment limitation or an explicit,
documented scope decision, not a defect left unaddressed.

## Environment-blocked verification

| Item | Status | Why |
|---|---|---|
| Live click-through of the deployed Shop UI (POS, product/inventory screens) as a real authenticated staff member | **AUTH ENVIRONMENT-BLOCKED** | No legitimate credential exists for this session to authenticate as a real staff member, and this session will never type/submit a password supplied by the user regardless of directness (a standing rule enforced earlier this same session against a real pasted credential). Every sanctioned alternative was exhausted instead: full backend RPC layer live-tested via RLS impersonation (not just reviewed), `npm run build`/lint/vitest all green, deployed-shell console/overflow checked at 375px with no errors, and every RTL-sensitive class in the new code manually audited (zero physical-direction `text-left`/`text-right`/`ml-`/`mr-`/`pl-`/`pr-` classes found — logical `text-start`/flex utilities only, matching the codebase's own established convention). |
| Full 6-breakpoint (1440/1280/1024/768/375/320) visual QA of the actual rendered Shop screens | **AUTH ENVIRONMENT-BLOCKED** (same root cause) | Structural/code-level responsive review was completed (no fixed-width containers, `overflow-x-auto` used correctly on horizontally-scrollable nav strips, DataTable's own existing responsive pattern reused unmodified) but real pixel-level rendering at each breakpoint was not observed. |
| True parallel/simultaneous concurrent-write demonstration | **ARCHITECTURALLY CONCURRENCY VERIFIED**, not LIVE CONCURRENT VERIFIED | The SQL tool used for all live testing this session executes sequentially; two truly simultaneous requests were never issued. The underlying mechanism (`SELECT ... FOR UPDATE` row locking) is a standard, well-understood Postgres guarantee, and sequential depletion-to-zero-then-denied was verified, which exercises the same code path a concurrent writer would. |

## Explicitly deferred (documented, not silently dropped)

See COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 10 for the full list and
reasoning:

- Stock reservation (`reserved`/`available` balance split) — no
  current consumer in this phase (no unpaid/invoice-first sale flow
  exists yet); column-compatible to add later without a breaking
  migration.
- Full procurement/accounts-payable beyond a minimal `shop_suppliers`
  lookup table.
- COGS/gross-profit reporting — `unit_cost` is captured on receipt
  movements for future use, but no report claims it as authoritative
  profit yet (the directive's own explicit caution against showing
  "fake profit" from an unreliable cost basis).
- Automated reorder/purchasing beyond a lightweight `reorder_level`
  threshold field.
- Physical Stock Count sessions (draft/in-progress/completed workflow
  with system-vs-counted variance) — not built in this phase; the
  existing `adjustment_in`/`adjustment_out`/`stock_count_adjustment`
  movement types exist in the ledger's own type catalog so a future
  Stock Count feature can slot in without a schema change, but no UI
  or dedicated RPC exists yet.

## Fixed during this session (not risks — resolved defects, documented for continuity)

- **Critical**: `return_shop_sale` had a live `anon`/`PUBLIC` EXECUTE
  grant leak. Adding `p_idempotency_key` to its signature made
  Postgres treat it as a genuinely new function identity, applying
  Postgres's own default EXECUTE-to-PUBLIC grant on creation — and
  the idempotency migration's own `create or replace function` block
  never included the explicit revoke/grant statements every other
  Shop RPC migration in this session correctly included. Caught by
  this session's own final grant-hygiene sweep (the same audit this
  project runs after every signature change, per its own migration
  history precedent) before any exploitation was possible. Also found
  an orphaned old 5-argument overload left behind from the same
  signature change, itself still carrying its own stale PUBLIC/anon
  grants. Fixed in two migrations: dropped the orphaned overload, then
  explicitly revoked `public`/`anon` and granted `authenticated` only
  on the current signature. Live-reverified: `anon` role now gets
  `permission denied for function` (denied at the grant layer, not
  merely the internal permission check), while a real authenticated
  club owner call still succeeds identically to before.
- **Critical**: `shop_inventory_balances` NULL-variant uniqueness bug
  — found by adversarial testing, already corrupting live data,
  fixed and live-reverified. See INVENTORY_INVARIANTS.md Section 5.
- **Medium**: `return_shop_sale()` had no idempotency protection —
  found by the same adversarial pass, fixed and live-reverified,
  including the refund+idempotency combination specifically (a fresh
  sale, returned+refunded twice with the identical idempotency key,
  confirmed to produce exactly one `shop_sale_returns` row and exactly
  one real `refunds` row). See INVENTORY_INVARIANTS.md Section 9.
- The original architecture assumed walk-in sales without a customer
  were possible; live testing immediately hit `invoices.customer_id
  NOT NULL` (a real, project-wide invariant). Corrected the same
  session, before the incorrect assumption ever reached a UI.

## What was NOT tested this session (honest gap, not a known defect)

- Multi-payment-method combinations on a single shop sale (this phase's
  `create_shop_sale` accepts exactly one payment method per sale, by
  design — a multi-payment shop sale was never a requirement and was
  not built or tested).
