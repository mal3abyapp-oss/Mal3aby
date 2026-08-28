# Finance Invariants — Live Verification (Phase 4 addendum)

**Status: LIVE VERIFIED.** Written 2026-08-28, part of Phase 4 (Staging +
Automated E2E). Directive requirement: assertions must reach actual
database state (invoice outstanding balance, refund balance), not merely
route-availability. This checks `get_invoice_payment_summary` — the
single RPC every invoice-outstanding-balance UI in the app calls — against
real, existing production rows on "QA Full Test Club"
(`6ca5315e-e199-4531-9fb1-1df358cda087`), which holds 43 real invoices.

## Method

Independently recomputed the expected outstanding balance for every real
invoice on this club using a naive formula (`total - sum(allocations)`)
and diffed it against the RPC's actual live output. 6 of 43 invoices
initially disagreed with the naive formula — each was investigated
individually rather than assumed to be either "all fine" or "a defect."

## Findings

**4 of 6 were the naive formula's own blind spot, not a defect**: all
four were `status = 'void'` invoices. A voided invoice correctly reports
`outstanding = 0` regardless of what was allocated before cancellation —
confirmed directly in the RPC's own source (`case when i.status = 'void'
then 0 ...`). The naive formula didn't account for status; the RPC does.

**1 of 6 was a genuine, correct overpayment**: invoice `e05c0b84-...`
(total ₤220) has ₤221 in real allocations (a ₤220 card payment + a real
₤1 cash payment). The RPC correctly floors outstanding at `0` (never
negative) via `greatest(..., 0)` — matching the same floor semantics
already confirmed in `record_gateway_payment_service` during the Payment
Attack Matrix.

**1 of 6 was the naive formula missing a real refund — the RPC was
correct**: invoice `7052b298-...` (total ₤220) has exactly one real,
fully-matched ₤220 payment allocation. The naive formula said
`outstanding = 0`; the RPC said `outstanding = 50.00`. Investigated
further: a real, `completed` ₤50 refund exists against that same
payment. Read the RPC's actual definition:

```sql
outstanding = greatest(total - paid + refunded, 0)
```

`220 - 220 + 50 = 50` — **exactly matching the RPC's live answer**. This
is deliberate, correct design: a refund genuinely re-opens outstanding
balance (the customer's money was returned, so the invoice is owed again
by that amount), not merely subtracted from a running "paid" total that
never looks back. CODE VERIFIED (read the definition) + LIVE VERIFIED
(the real row's numbers match the formula exactly).

## Verdict

**Zero real defects found.** All 6 apparent discrepancies were the
independent verification formula's own incompleteness (void-status and
refund-awareness), not the RPC's. `get_invoice_payment_summary` computes
outstanding balance correctly across every real case present in
production data today: void invoices, overpayment, and refund-driven
re-opening of balance.

## Fixtures

None created or destroyed — every row checked was real, pre-existing
production/QA-fixture data, read-only throughout.
