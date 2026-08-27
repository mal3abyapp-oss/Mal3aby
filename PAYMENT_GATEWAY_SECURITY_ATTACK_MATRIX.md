# Payment Gateway Security Attack Matrix — Phase 2 Cross-Cutting Pass

**Status: COMPLETE.** Run 2026-08-27/28 against the live hosted
project (`gxkrtlvpjwxhcqdisyob`) by the `security-reviewer` agent,
under `AGENT_ORCHESTRATION_GOVERNANCE.md`. This is the system-level
attack matrix mandated for Phase 2 (Multi-Gateway Online Payments) —
cross-cutting attacks that exploit interactions BETWEEN pieces, not
single-adapter unit correctness (which was already covered per-provider
in `PAYMENT_GATEWAY_WEBHOOK_MODEL.md`/`PAYMENT_GATEWAY_ARCHITECTURE.md`
during the build-and-review cycle).

**Evidence taxonomy** (per the governing directive): LIVE VERIFIED
(actually executed against the real deployed functions/database this
session) / CODE VERIFIED (confirmed by reading the deployed source,
where a live test would require credentials this project does not
have) / CREDENTIAL-BLOCKED (genuinely impossible without a real
provider account).

## Test fixtures used

Two clean, single-tenant test clubs already present in the project,
neither carrying platform-staff access:

- **Club A** = "Mala3by Test Club One" (`57ce89e4-184a-413f-bc47-ee0fdb878727`), owner `12fadb01-c60b-4be7-a330-6c0786a2daa0` (Club Owner role, member of only this club).
- **Club B** = "Mala3by Test Club Two" (`c0b02979-a49e-4338-bcac-d789ca397aeb`), owner `8694a8b8-e1b4-46ee-857f-4bc8e8f72d31` (Club Owner role, member of only this club).

Disposable fixtures created and later fully deleted: a branch,
customer, and 2 invoices for Club B; `club_gateway_connections` rows
for Stripe/Paymob/Fawry/PayPal across both clubs with real
`vault.create_secret()`-backed credentials; real
`payment_gateway_transactions` staged via the real
`start_gateway_checkout()` RPC; real hand-signed webhook deliveries
against the live deployed Edge Functions using each connection's own
real vaulted secret (computed independently in Node.js, matching each
provider's documented signature scheme). All impersonation used the
project's established `set_config('request.jwt.claims', ...)` pattern
against real user ids. Full restored-state confirmation at the end
showed **zero residual rows** in every table/vault secret touched.

## Results — all 20 required attacks

| # | Attack | Test performed | Evidence tier | Outcome |
|---|---|---|---|---|
| 1 | Club A → Club B gateway connection | (a) Direct RLS `select` by Club A's owner on Club B's `club_gateway_connections` row. (b) `start_gateway_checkout()` called by Club A's owner against Club A's own invoice but with `p_connection_id` = Club B's connection. | LIVE VERIFIED | **DENY.** (a) zero rows returned (RLS silently filtered). (b) `P0001: connection not found for this club/provider` — the RPC's own `where id=... and club_id=v_club_id and provider_key=...` predicate makes this structurally impossible, not just RLS-filtered. |
| 2 | Club A → Club B transaction | (a) Direct RLS `select` by Club A's owner on Club B's `payment_gateway_transactions` row. (b) `get_gateway_transaction_status()` called by Club A's owner on Club B's transaction id. | LIVE VERIFIED | **DENY.** (a) zero rows. (b) `P0001: not authorized`. Since every authenticated Edge Function (`*-create-checkout-session`, all 5) re-derives authorization by calling this exact RPC through the caller's own JWT (CODE VERIFIED by reading `stripe-create-checkout-session`, `kashier-create-checkout-session` in full — identical pattern in all 5), this denial propagates to the HTTP layer for all 5 providers. |
| 3 | Forged provider success (all 5 webhooks) | Constructed payloads claiming success with a signature that does not match any real connection's secret, sent to the real deployed `stripe-gateway-webhook`, `paymob-gateway-webhook`, `fawry-gateway-webhook`, `paypal-gateway-webhook`. `kashier-gateway-webhook` verified by identical code-pattern reading (already LIVE VERIFIED in a prior session per `PAYMENT_GATEWAY_WEBHOOK_MODEL.md`). | LIVE VERIFIED (Stripe, Paymob, Fawry, PayPal this session) + CODE VERIFIED (Kashier, matching pattern) | **DENY, all 5.** No payment posted in any case; transactions either untouched or durably marked `failed`. |
| 4 | Invalid webhook signature — "present but wrong" vs. "missing entirely" | Both sub-cases tested live against **Fawry** and **PayPal** specifically (Stripe/Paymob/Kashier's own build-time sessions already covered both sub-cases per the architecture docs). Fawry: forged `messageSignature` value → `400 signature verification failed`; `messageSignature` field absent → `400 missing messageSignature field on notification body` (distinct, correctly-ordered error paths — missing-field check runs before the HMAC comparison). PayPal: all 5 transmission headers absent → `400 missing required paypal transmission headers` (before contacting PayPal); all 5 headers present but garbage, against a real (garbage-credentialed) disposable connection → the function reached PayPal's real `verify-webhook-signature` API and correctly returned `400 signature verification failed` rather than trusting the HTTP 200 PayPal's endpoint returns even on failure. | LIVE VERIFIED | **DENY, both sub-cases, both providers.** Transaction state confirmed unchanged after each attempt. |
| 5 | Duplicate webhook = idempotent | A genuinely valid, freshly-signed Stripe webhook (Club B's real secret) sent twice, identical payload/signature. | LIVE VERIFIED | First delivery posted a real payment; the identical duplicate returned `{"received":true,"duplicate":true}`. DB-confirmed: exactly 1 `payments` row, 1 `payment_allocations` row, 1 `payment_gateway_webhook_events` row. |
| 6 | Replayed webhook = idempotent/rejected (freshness, distinct from #5) | A cryptographically-correctly-signed Stripe payload with a timestamp 1 hour old (outside Stripe's documented 5-minute replay window). | LIVE VERIFIED | **DENY** — `400 timestamp outside replay window`, rejected before signature verification was even attempted. **Disclosed limitation**: Paymob, Kashier, and Fawry's own documented webhook schemes carry no timestamp field at all (confirmed by reading all 3 functions' source) — for those 3, "replay" protection is exact-payload-hash dedup only (test #5's mechanism), not a freshness-window check, because their own provider protocols do not supply a timestamp to check against. This is a property of what each provider's protocol offers, not a Mal3aby implementation gap. PayPal's `PAYPAL-TRANSMISSION-TIME` header exists but freshness enforcement is delegated to PayPal's own `verify-webhook-signature` call (by design — see webhook model doc's rationale for API-based over local verification). |
| 7 | Amount mismatch — shared RPC direct test | `record_gateway_payment_service()` called directly (bypassing any webhook) with a confirmed amount (999.00) not matching the staged amount (400.00). | LIVE VERIFIED | **DENY.** Returned `NULL`; zero `payments` rows created; transaction durably marked `failed` with `failure_reason = 'amount mismatch: staged=400.00 confirmed=999.00'`. |
| 8 | Currency mismatch — shared RPC direct test | Same RPC, correct amount (400.00) but wrong currency (`USD` vs. staged `EGP`). | LIVE VERIFIED | **DENY.** Returned `NULL`; zero payments; `failure_reason = 'currency mismatch: staged=EGP confirmed=USD'`. |
| 9 | Wrong provider | A transaction staged `gateway='stripe'` targeted by a **genuinely, correctly HMAC-signed** Paymob webhook payload (Club A's real Paymob secret, verified to actually pass HMAC verification), with `merchant_order_id` set to the Stripe-staged transaction's own id. | LIVE VERIFIED | **DENY.** HMAC verification succeeded (proving the attack got past authentication) but candidate resolution's `.eq('gateway','paymob')` filter meant the Stripe-staged transaction was never matched — response `{"received":true,"unmatched":true}`. Transaction confirmed unchanged (`status='pending'`, `payment_id=null`) afterward. This is the strongest possible evidence: the defense held even when the attacker held valid credentials for *a* connection, because gateway-scoping is enforced independently of signature validity. |
| 10 | Wrong connection (same provider) | A Stripe webhook payload referencing Club B's transaction (via `metadata.mal3aby_transaction_id`), signed with **Club A's own, different, genuine** Stripe webhook secret. | LIVE VERIFIED | **DENY.** `400 signature verification failed`. Candidate resolution derives which connection's secret to try FROM the targeted transaction (Club B's), never from any attacker claim — so Club A's real secret was never even the one attempted, and verification against Club B's real secret correctly failed for a payload signed with the wrong key. |
| 11 | Transaction reuse | `record_gateway_payment_service()` called a second time against an already-`succeeded` transaction, with a **different** confirmed amount (999.00) than the original (400.00). | LIVE VERIFIED | **DENY (safe idempotent behavior).** The RPC's own guard (`if status='succeeded' and payment_id is not null then return v_txn.payment_id`) ignored the new, potentially-attacker-controlled amount entirely and returned the ORIGINAL payment id unchanged. `payments` table confirmed still contains exactly 1 row at the original 400.00 amount — the reuse attempt could not alter or duplicate anything. |
| 12 | Fake success redirect = no payment | (a) Re-read `GatewayReturnPage.tsx` in full for the current merged state — confirmed zero write-RPC calls; its only data access is `get_gateway_transaction_status()` (`stable`, read-only). (b) Live-called `get_gateway_transaction_status()` three times in a row against a genuinely still-`pending` transaction. | CODE VERIFIED (a) + LIVE VERIFIED (b) | **NO PAYMENT, confirmed both ways.** (a) the component has no path to `record_gateway_payment_service`/`mark_gateway_transaction_failed_service` at all — `?outcome=success` in the URL is explicitly documented and coded as a display hint only. (b) repeated polling left `status='pending'` and `updated_at` unchanged across all 3 calls. |
| 13 | Unauthorized refund | (a) A real user with the **Coach** role (no `payment.refund` grant) — `has_permission('payment.refund', club_id)` called directly under that user's real impersonated session. (b) Cross-tenant: Club A attempting to refund Club B's payment via a transaction-id mismatch (see also #19 below, same mechanism). (c) Code-read confirmed all 5 `*-create-refund` functions gate on `authorized !== true` → `403`, using the caller's own JWT against `has_permission('payment.refund', payment.club_id)` — identical pattern in Stripe/Paymob/Kashier/Fawry/PayPal. | LIVE VERIFIED (a) + LIVE VERIFIED (b, via #19) + CODE VERIFIED (c, all 5) | **DENY.** (a) `has_permission` returned `false` for the Coach role — the exact boolean all 5 refund functions gate on. (b)/(c) see #19: `create_gateway_refund_service`'s same-transaction invariant makes a cross-club/cross-provider refund structurally impossible even if the Edge-Function-layer permission check were somehow bypassed. |
| 14 | Over-refund | `create_gateway_refund_service()` called directly requesting 500.00 against a 400.00 payment with zero prior refunds. | LIVE VERIFIED | **DENY.** `P0001: refund amount exceeds refundable balance (refundable: 400.00)` — exact refundable balance disclosed in the error, no partial/silent acceptance. |
| 15 | Duplicate refund = idempotent | `create_gateway_refund_service()` called twice with the identical `p_idempotency_key`, different `p_reason`/`p_provider_refund_ref` on the retry (simulating a webhook-driven retry after a network timeout). | LIVE VERIFIED | **IDEMPOTENT.** Both calls returned the identical `refund_id`. DB-confirmed: exactly 1 row in `refunds`, amount 150.00 (not double-posted, not overwritten by the retry's different reason/ref). |
| 16 | Provider succeeded / canonical payment missing (reconciliation) | Deliberately broke a disposable fixture: set a `payment_gateway_transactions` row to `status='succeeded', payment_id=NULL` (structurally impossible via the real RPC, only reachable by a direct manual UPDATE — which no client role can perform, confirmed by the pre-existing grant revocation). Called `gateway_reconciliation_report()`. | LIVE VERIFIED | **CAUGHT.** Report correctly returned `{"exception_type":"succeeded_transaction_no_payment","detail":"transaction marked succeeded but has no linked payment"}`. Fixture restored to `pending`/`null` immediately after. |
| 17 | Canonical payment / provider transaction missing | Queried real production data: `payments` rows with `method='card'` and no linked `payment_gateway_transactions` row. | LIVE VERIFIED (real production data query) | **CLEAN — no real anomaly found.** Zero such rows exist. (A separate, unrelated finding: 5 real `cash`/`bank_transfer` payments exist with allocation-sum mismatches — confirmed NOT `method='card'` and NOT linked to any gateway transaction, so out of Phase 2's gateway scope; flagged below as a general-ledger observation, not a gateway defect.) |
| 18 | Payment ↔ allocation mismatch (gateway scope) | Deliberately constructed a disposable `payments`+`payment_gateway_transactions` pair with zero `payment_allocations` rows, then ran the report. Also tested the amount-mismatch variant (payment.amount changed to 999.00 against a 77.00 transaction). | LIVE VERIFIED | **CAUGHT, both variants.** Report returned `payment_no_allocation` ("linked payment has zero allocations") for the first fixture, and `amount_mismatch_transaction_vs_payment` ("transaction amount 77.00 does not match payment amount 999.00") for the second. Both fixtures fully deleted after. |
| 19 | Refund ↔ provider mismatch | (a) Direct RPC test: `create_gateway_refund_service()` called against Club B's real succeeded payment but supplying an **unrelated** `p_transaction_id` (a different, already-failed transaction). (b) Real production data query: every `refunds` row with a non-null `provider_refund_ref`, joined to its transaction's `gateway`. | LIVE VERIFIED | **DENY (a) / CLEAN (b).** (a) `P0001: gateway transaction does not correspond to this payment -- refusing cross-provider refund` — the RPC requires exact equality between the supplied transaction and the payment's own linked transaction, making cross-club and cross-provider refund attempts structurally impossible regardless of what the caller supplies. (b) only one real refund with a `provider_refund_ref` exists in production (this session's own now-deleted test fixture) — no real anomaly. |
| 20 | Settlement ≠ customer payment must not corrupt revenue | Read all 5 webhooks' success-branch amount extraction: Stripe (`amount_total`/`amount_received`, the Checkout Session/PaymentIntent's own gross field, never a Balance Transaction net figure), Paymob (`amount_cents`, the transaction's own charged-amount field), Kashier (`amount`, the documented charged decimal), Fawry (`paymentAmount`, the customer-facing payment field per docs, distinct from and never conflated with `orderAmount`), PayPal (`resource.amount.value` on the **Capture** resource — the gross captured amount, never `seller_receivable_breakdown.net_amount`, which PayPal documents as a separate fee-adjusted field this code never reads). | CODE VERIFIED, all 5 (LIVE VERIFIED indirectly for Stripe/Paymob/Kashier/Fawry via this session's and prior sessions' successful test postings, where the posted `payments.amount` was confirmed to exactly equal the staged/gross amount, not any net figure) | **PASS, all 5.** None of the 5 adapters reads or posts a settlement/net/fee-adjusted amount anywhere in the payment-posting path. Fees are correctly treated as a separate operational concern the ledger never sees. |

## Additional findings surfaced during this pass

### Genuine, disclosed limitation — no timestamp/replay-window check for 4 of 5 providers (see item 6)
Only Stripe's own webhook protocol carries a timestamp field
(`Stripe-Signature: t=...`), which is what enables a freshness-window
check distinct from exact-duplicate dedup. Paymob, Kashier, and Fawry's
own documented callback schemes carry no equivalent field — confirmed
by reading all three functions' source in full this session. This is
not a Mal3aby implementation gap; it is a ceiling imposed by what each
provider's own protocol supplies. All 4 non-Stripe providers still have
exact-payload/exact-event-id dedup (item 5's mechanism), which is the
strongest replay defense their own protocols make possible.

### Minor hygiene finding — dead legacy RPC/table still reachable (not a security defect)
`public.upsert_payment_gateway_config(p_club_id, p_gateway, p_enabled,
p_public_key)` and its backing table `public.payment_gateway_configs`
are a **pre-Phase-2 legacy path** (single-config-per-club,
`stripe`/`paypal` only, no Vault-backed secrets, no environment split),
superseded by `connect_club_gateway()` / `club_gateway_connections`.
Confirmed via `get_advisors` that this RPC is still `authenticated`-
executable, and confirmed via `execute_sql` that the table still holds
2 residual rows. **This is not exploitable** — the RPC independently
re-derives its own `auth.uid()` + `has_permission('payment.methods.manage',
p_club_id)` authorization exactly like every other RPC in this
codebase, so it cannot be used cross-tenant or without proper
permission. It is also confirmed **not called anywhere in the current
UI** — `PaymentGatewayConnectionsCard.tsx` only *mentions* it in a
comment explaining what it replaced; there is no live call site.
Recommendation for a future session (not fixed here — out of this
audit's scope and not a security boundary failure): consider dropping
the legacy RPC/table once confirmed nothing else depends on it, to
remove a dead-but-live write path from the schema surface. Not fixed
in this session since it is not a security defect and dropping
database objects is a higher-blast-radius change than this audit's
mandate covers.

### Real, unrelated pre-existing data observation (see item 17)
5 real `cash`/`bank_transfer` payments (clubs `b9178c0f-...` and
`57ce89e4-...`) have `payment_allocations` sums that do not equal their
`payments.amount` (e.g. a 200.00 payment with only 190.00 allocated).
These are **not** gateway (`method='card'`) payments and are entirely
outside `gateway_reconciliation_report`'s scope (which only ever joins
from `payment_gateway_transactions`). This looks like a legitimate
partial-allocation/credit-balance state in the general Finance ledger,
not a Phase 2 gateway defect — flagged here only because item 17's
instructions explicitly asked to check real data, not to imply a
gateway-scope problem. Not investigated further as it is out of this
audit's mandate (gateway security, not general ledger reconciliation).

## Cleanup confirmation

Every disposable fixture created this session was deleted in dependency
order (refunds → payment_allocations → webhook_events →
payment_gateway_transactions → payments → invoice_verification_tokens →
invoices → club_gateway_connections → vault.secrets → customers →
branches). Final restored-state query confirmed **zero** residual rows
across every table and vault secret touched, and confirmed Club A's
two genuinely pre-existing (disabled, historical, not created by this
session) connections were left untouched.

## Overall verdict

**No CRITICAL or unexpected cross-tenant/cross-provider access was
found.** Every one of the 20 mandated attacks was denied, rejected, or
correctly flagged by the system's own layered defenses — tenant
isolation (RLS + RPC-internal `has_permission`/`user_club_ids` checks),
signature verification (all 5 providers, both "wrong" and "missing"
sub-cases), gateway-scoped candidate resolution (proven to hold even
against a genuinely valid signature for a different provider),
connection-scoped signature-secret resolution (proven to hold even
against a genuinely valid signature for a different connection),
amount/currency cross-checks at the shared RPC layer, refund
same-transaction/refundable-balance/idempotency invariants, and the
reconciliation report's own exception detection (proven against 3
deliberately-constructed broken fixtures, not just read by inspection).

No real defect was found requiring a fix. No file changes were made to
the repository as part of this audit — this document is the only new
file. The two minor findings above (dead legacy RPC/table; unrelated
cash-ledger allocation mismatches) are disclosed for completeness and
recommended as follow-up items for a future session, not treated as
release blockers for Phase 2's security posture.

**Phase 2 security readiness: the cross-cutting attack matrix supports
proceeding.** The remaining gaps for a full production-readiness
verdict are the same CREDENTIAL-BLOCKED items already disclosed
throughout `PAYMENT_GATEWAY_ARCHITECTURE.md` and
`PAYMENT_GATEWAY_WEBHOOK_MODEL.md` — genuine provider-hosted checkout
completions and genuine provider-originated webhook deliveries for all
5 providers, none of which can be exercised without real merchant
accounts this project does not have. Those gaps are about proving
integration correctness against each provider's real infrastructure,
not about the security boundaries this document was scoped to test —
which held in every case attempted.
