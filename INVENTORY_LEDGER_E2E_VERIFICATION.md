# Shop Inventory Movement Ledger — Live Verification (Phase 4 addendum)

**Status: LIVE VERIFIED.** Written 2026-08-28, part of Phase 4 (Staging +
Automated E2E). Directive requirement: assertions must reach real
inventory balance / movement ledger state, not merely route-availability.
Checked every real `shop_inventory_balances` row on the Shop module's own
established real-data fixture club (`فايد الرياضي`,
`b9178c0f-00b5-4c71-abec-b8772ffb8682`) against the full
`shop_inventory_movements` ledger for the same product/variant/location.

## Method and a real false alarm, corrected before being reported

Initial check: does `on_hand` equal a flat `sum(quantity)` across every
movement row for that product/variant/location? 2 of 4 balance rows
disagreed with this naive sum (off by `-2` and `-34`).

**Investigated before concluding either "correct" or "defect."** Read
every movement row for both discrepant balances. Found the real
mechanism: `shop_inventory_movements.quantity` is stored as a **positive
magnitude**, not a signed delta — `movement_type` determines direction
(`purchase_receipt`/`sale_return` increase; `sale`/`transfer_out`/`damage`
decrease). My flat-sum formula didn't account for this and was wrong,
not the ledger.

Recomputed sign-aware for both discrepant rows:

- Product `a06cd742-...` / variant `dc04d299-...` / location
  `73559c2f-...`: `purchase_receipt +20, sale -1, sale_return +1` →
  `20 - 1 + 1 = 20`. **Matches the real `on_hand` (20) exactly.**
- Product `e4442bd6-...` (مياه معدنية) / location `8587f0cc-...`:
  `purchase_receipt +100, transfer_out -10, damage -3, sale -2, sale -2,
  sale_return +1` → `100 - 10 - 3 - 2 - 2 + 1 = 84`. **Matches the real
  `on_hand` (84) exactly.**

The other 2 of 4 balance rows already matched a flat sum exactly (no
decrease-type movement existed for those particular product/location
pairs, so the sign distinction didn't come into play).

## Verdict

**Zero real defects found.** Every real `on_hand` balance on this club
is fully explained by, and reconciles exactly against, its own
movement-ledger history once movement direction (not just magnitude) is
accounted for — including a real partial return, a real full return, a
real transfer-out, and a real damage/loss write-off, all genuine
transactions from the Shop Production Acceptance session's own live
testing, not synthetic data created for this check.

## Fixtures

None created or destroyed — every row checked was real, pre-existing
Shop-module test data. Read-only throughout.
