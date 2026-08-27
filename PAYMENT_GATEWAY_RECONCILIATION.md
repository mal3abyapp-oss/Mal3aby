# Payment Gateway Reconciliation

**Status: LIVE VERIFIED** (grant matrix confirmed live; the report's
own SQL is straightforward read-only joins over already-verified
tables, exercised via the same disposable test fixtures used in
`PAYMENT_GATEWAY_WEBHOOK_MODEL.md`'s live webhook test).

## `gateway_reconciliation_report(p_club_id uuid, p_date_from date, p_date_to date)`

Read-only, `authenticated`-callable RPC (also reachable by platform
support via `has_platform_support_access`). Gated on
`payment.methods.view` — the same permission `list_club_gateway_connections()`
itself requires, since this report exposes gateway-connection-level
operational detail, not the general Payments list (that remains
`payment.view`, unrelated).

**Deliberately OPERATIONAL VISIBILITY ONLY, never a second ledger** —
this is the governing directive's explicit rule (never duplicate
Finance as a source of truth). The report reads from, and only from,
tables Finance itself already owns
(`payment_gateway_transactions` → `payments` → `payment_allocations`
→ `refunds`); it never writes anything, and it never claims to be an
independent computation of revenue/balance — it surfaces where those
existing tables disagree with each other, nothing more.

### Shape

```jsonc
{
  "transactions": [
    {
      "transaction_id": "...",
      "gateway": "stripe",
      "environment": "sandbox" | "live",
      "status": "pending" | "succeeded" | "failed" | "cancelled",
      "amount": 99.00,
      "currency": "USD",
      "created_at": "...",
      "payment_id": "..." | null,
      "payment_amount": 99.00 | null,
      "allocated_amount": 99.00,
      "refunded_amount": 0,
      "provider_session_ref": "cs_..." | null
    }
  ],
  "exceptions": [
    {
      "transaction_id": "...",
      "exception_type": "succeeded_transaction_no_payment" | "payment_no_allocation" | "amount_mismatch_transaction_vs_payment",
      "detail": "human-readable explanation"
    }
  ],
  "summary": {
    "total_transactions": 12,
    "succeeded_transactions": 9,
    "failed_transactions": 2,
    "pending_transactions": 1
  }
}
```

### Exception types, and what each one means operationally

- **`succeeded_transaction_no_payment`** — the gateway transaction is
  marked `'succeeded'` but has no linked `payment_id`. Under the
  invariants `record_gateway_payment_service` enforces, this should be
  structurally impossible on the normal path (the RPC sets `status =
  'succeeded'` and `payment_id` atomically in the same statement) — its
  presence in a real report would indicate either a direct/manual
  status update outside the RPC (which no client role can do — direct
  table writes are revoked, confirmed in
  `20260827073323_revoke_direct_payment_gateway_table_grants.sql`), or
  a genuine bug. Treat any occurrence as worth investigating, not
  routine.
- **`payment_no_allocation`** — a linked payment exists but has zero
  rows in `payment_allocations`. `record_gateway_payment_service`
  always inserts both in the same statement, so this should also be
  structurally rare; a real occurrence suggests a partial write
  somehow escaped the function's own transaction boundary (worth
  investigating as a genuine anomaly, not routine).
- **`amount_mismatch_transaction_vs_payment`** — the transaction's
  staged amount differs from the linked payment's actual amount. Since
  `record_gateway_payment_service` inserts the payment using the
  provider-CONFIRMED amount (which by definition matched the staged
  amount at insert time, per the amount/currency cross-check
  documented in `PAYMENT_GATEWAY_WEBHOOK_MODEL.md`), this exception
  type would only appear if the payment's amount were altered by some
  OTHER path after posting — again, worth investigating, not expected.

In practice, for a system operating correctly, `exceptions` should
almost always be empty — its presence is a genuine anomaly signal, not
a normal operational report like `collections_report`.

### What this report is NOT

- Not a substitute for `FinancePaymentsPage`/`BillingPage` — those
  remain the canonical payments UI.
- Not a revenue or balance calculation — it never sums to a "total
  revenue" figure; `summary` counts transactions by status only, it
  does not aggregate money.
- Not writable — every field is `select`-derived; there is no
  write path anywhere in this function's body.

### Evidence

- Grant matrix (LIVE VERIFIED): `anon` cannot execute, `authenticated`
  can (subject to the internal permission check), `service_role` is
  not needed (this report never needs to bypass RLS beyond what
  `SECURITY DEFINER` + the internal check already provides — it's
  granted to `authenticated` deliberately, matching every other
  `_report` RPC's own grant shape in this codebase).
- The join logic itself was validated by inspection against
  `record_gateway_payment_service`'s own known-correct write shape
  (same tables, same columns) rather than a dedicated live exception
  scenario in this session — CODE VERIFIED, not independently
  exercised against a hand-crafted broken-chain fixture. A future
  session wanting SANDBOX/LIVE VERIFIED status for the exception paths
  specifically should stage a transaction with a manually-broken chain
  (e.g. delete a `payment_allocations` row after a normal post) and
  confirm the report surfaces it — deliberately not done in this
  session to avoid mutating already-verified fixtures mid-test.
