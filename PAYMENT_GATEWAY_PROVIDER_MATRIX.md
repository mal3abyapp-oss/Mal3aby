# Payment Gateway Provider Matrix

Research conducted August 2026 against each provider's live official
documentation (fetched directly, not recalled from training data).
Full per-provider detail with source URLs is preserved in this
session's research artifact; this document summarizes what shapes the
Mal3aby integration design.

## Critical business-model fact (affects which providers are viable per club)

**Stripe does not support Egypt as an account country** — a club would
need a legal entity in a Stripe-supported country to connect Stripe at
all. **PayPal does not support EGP** — PayPal transactions for an
Egypt-based club would settle in a different currency (USD etc.), not
EGP. This means, in practice:

- **Egypt-native EGP settlement**: Paymob, Kashier, Fawry.
- **International/foreign-currency**: Stripe, PayPal — usable only by
  a club with the legal/business standing each provider requires, not
  universally available to every Mal3aby club.

This is exactly why the architecture (Section 26/30) must never assume
"every club can connect every provider" — provider eligibility is a
real, provider-enforced constraint, not just a UI preference.

## Comparison table

| Provider | API version | Hosted checkout | Webhook signature | Idempotency key | EGP support | Refund model | Sandbox |
|---|---|---|---|---|---|---|---|
| **Stripe** | Dated release (e.g. `2026-08-26`), header-overridable | Checkout Sessions (hosted/embedded/Elements) | `Stripe-Signature` header, HMAC-SHA256 over `timestamp.payload` | Native `Idempotency-Key` header, 24h window | Not in documented currency list; Egypt not a supported account country | Full/partial via Refunds API; sync object + async `refund.*` webhook confirmation | Same base URL, `sk_test_`/`pk_test_` keys, instant self-service |
| **PayPal** | Orders API v2 | Orders API + approve link / JS SDK buttons | 5 headers (`PAYPAL-TRANSMISSION-*`, `PAYPAL-CERT-URL`, `PAYPAL-AUTH-ALGO`), RSA-SHA256, verifiable locally or via `verify-webhook-signature` | Native `PayPal-Request-Id` header, ~45-day retention for refunds | EGP absent from documented currency list | `POST /v2/payments/captures/{id}/refund`; partial/time-limit specifics not fully confirmed from fetched docs | Distinct host `api-m.sandbox.paypal.com`, self-service sandbox accounts |
| **Paymob** | Intentions API (v1) | Unified Checkout (redirect) / Pixel (embedded) via `client_secret` | HMAC-SHA512, ordered field concatenation, dashboard-issued HMAC secret (exact field order must be re-confirmed against the live dashboard before implementation) | Not documented — dedup via merchant `special_reference` | Yes — core EGP gateway | Full/partial via dashboard (all methods except Kiosk); programmatic endpoint URL not fully confirmed from primary docs | Test cards/wallet OTP confirmed; sandbox-vs-live base-URL distinction not primary-confirmed |
| **Kashier** | No global version string; `v3` in the Payment Sessions endpoint path | Payment Sessions (`sessionUrl`) / Hosted Checkout Page | `x-kashier-signature` header, HMAC-SHA256 over alphabetically-sorted `signatureKeys` fields, keyed by the Payment API Key | Not documented — order-hash + merchant Order ID for integrity/dedup | Yes — EGP native; also USD/EUR/GBP (secondary-sourced) | Full/partial via `PUT /orders/:orderId/` (REFUND op); synchronous JSON response | Distinct `test-` prefixed base URL + separate test/live key pairs |
| **Fawry (FawryPay)** | No unified version; per-endpoint (e.g. Notification V2) | Express Checkout Link (hosted redirect) | `messageSignature` body field, SHA-256 over fixed field concatenation — no dedicated header | Not documented — relies on merchant `merchantRefNum` uniqueness | Yes — EGP-only in every documented example | Full/partial via `POST /payments/refund`; sync JSON; authorized-but-uncaptured cannot be refunded | Staging domain exists but **credentials require manual merchant registration (~2 business days), not instant signup** |

## Documentation gaps, disclosed honestly

- **Rate limits**: only Stripe documents them explicitly (100 req/s
  live / 25 req/s sandbox + per-resource caps). PayPal, Paymob,
  Kashier, and Fawry document none — treat as undocumented and
  implement conservative client-side backoff regardless.
- **Paymob and Kashier's docs portals are JS SPAs** that 404 on many
  direct deep-link fetches; several secondary details (Paymob's exact
  HMAC field order, Paymob's programmatic refund endpoint URL,
  Kashier's full country/currency list) came from search-result
  synthesis rather than a directly-fetched primary page this session
  — flagged individually, and must be re-verified against each
  provider's live dashboard/API Explorer immediately before writing
  production signing code for that provider.
- **Fawry has no self-service developer signup.** Real sandbox
  credentials require merchant registration and manual approval
  (~2 business days per the docs). This is a real lead-time
  dependency, not something this session can shortcut.

## What this means for the adapter architecture

- Every adapter's `verifyWebhook()` must implement a **provider-specific**
  signature scheme — there is no shared algorithm across providers
  (HMAC-SHA256 header-based for Stripe/Kashier, RSA-SHA256
  multi-header for PayPal, HMAC-SHA512 field-concatenation for
  Paymob, SHA-256 body-field for Fawry). The common `PaymentGatewayAdapter`
  contract abstracts the *interface*, never the *algorithm*.
- Idempotency-key support is genuinely native only for Stripe and
  PayPal. For Paymob/Kashier/Fawry, Mal3aby's own
  `payment_gateway_transactions.idempotency_key` (a Mal3aby-generated
  value checked before creating a new gateway attempt) is the real
  dedup mechanism — not something to assume the provider guarantees.
- None of the 5 providers documents guaranteed exactly-once webhook
  delivery — Stripe explicitly warns of duplicates, and Kashier/Fawry
  both describe retry-until-200 behavior. Webhook idempotency
  (Section 40 of the directive) must be enforced entirely on Mal3aby's
  side for every provider, not assumed from any provider's own claims.
