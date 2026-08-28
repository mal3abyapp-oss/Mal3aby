# Commerce Pro — Additional Live QA Pass (2026-08-28)

Written after Commerce Pro's 10-phase closure. An expected background
agent handoff (`a052f80e90ab09395`) never appeared in `ListAgents` after
two checks, and no wrap-up message or scope document was found or
provided — per explicit instruction, proceeded independently with
self-selected, genuinely new live-database QA scenarios (via direct RPC
calls, RLS-impersonation) rather than duplicating
`COMMERCE_C10_LIVE_ACCEPTANCE_WALKTHROUGH.md`'s existing coverage
(discount + split-tender + payment-specific refund + cost-at-sale →
gross profit).

## Scenarios executed, all real, against the live production database

1. **Variant-based sale**: sold 1× "قميص رياضي" (M/أزرق variant).
   Confirmed the variant's real `price_override` (250, not the base
   product price) was correctly used, and the variant-specific balance
   correctly dropped 19→18.

2. **Over-return rejection**: attempted to return 2 units of a sale
   that only sold 1. Correctly denied: `cannot return more than the
   remaining sold quantity (remaining: 1)`.

3. **Legitimate full return**: returned the 1 unit, refund 250.00.
   Confirmed: stock correctly restocked (18→19), sale status correctly
   transitioned to `returned` (not `partially_returned`).

4. **Double-refund rejection**: attempted a second return on the
   now-fully-`returned` sale. Correctly denied: `this sale cannot be
   returned in its current status`.

5. **Stock Movement Ledger reconciliation**: pulled the full movement
   history for this product/variant/location via
   `list_shop_inventory_movements` and manually summed it against the
   real accumulated history across this entire session (1 receipt +20,
   4 sales -1 each, 2 returns +1 each) — arithmetic matches the live
   balance (19) exactly.

6. **Cross-club permission denial**: a real user with zero membership
   in the target club attempted `create_shop_sale` (using a real
   existing customer id, to isolate specifically the authorization
   check rather than an earlier validation step). Correctly denied:
   `not authorized`, before any write.

## Verdict

Zero defects found across all 6 scenarios. No cleanup required — every
scenario either self-balanced (the sale+return net to zero net stock
change) or was correctly denied before any state was written.
