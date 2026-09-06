# Mal3aby — Sales Claims Matrix

Written 2026-09-06, Final Sell-Readiness Mission. What can honestly be
claimed to a prospective customer, what cannot yet, and the evidence
behind each line. Use this before writing sales copy, a pitch deck, or
answering a prospect's direct question. Where a claim is marked "DO NOT
CLAIM," that is not a suggestion to soften language — it means the
underlying capability does not exist yet, and claiming it would be false.

| Claim | Status | Evidence |
|---|---|---|
| Fields and academy programs can run together in one club | **VERIFIED** (post-fix) | Four real production clubs already run both simultaneously. The academy/booking double-booking gap that would have disproven this claim (academy sessions were invisible to the booking engine's conflict detection) was found and fixed this session (`supabase/migrations/20260906150000_close_academy_booking_double_booking.sql`), applied to production, and verified live: the new `EXCLUDE` constraint is active, cross-table conflict checks are wired into every booking/session-creation path, and both availability RPCs now correctly subtract academy sessions from free slots. |
| QR check-in for bookings | **VERIFIED WORKING** | 148 active QR credentials in production with real scan volume, backed by `verify_booking_qr_public()`/`qr_confirm_checkin()` RPCs (`src/features/verify/SecureBookingPage.tsx`). |
| QR verification for invoices/payments | **VERIFIED WORKING** | 103 active verification tokens in production with real usage. |
| QR for club membership | **VERIFIED WORKING** | Real, low-volume usage confirmed in production. |
| QR attendance tracking for academy | **DO NOT CLAIM ACTIVE USE** | The feature is correctly implemented and wired into the scanner UI, but every one of the 33 existing attendance rows in production shows `method='manual'` — zero show `'qr'`. It is safe to say "academy attendance QR scanning is built into the product"; it is not honest to say clubs are actively using it today. |
| Invoices / official receipts | **VERIFIED**, with specific safe wording | Reports and invoices reconcile exactly to raw SQL on real data. Refund idempotency is enforced by real database unique constraints (not app-level checks); over-refund and cross-tenant refund are both correctly blocked. Safe wording: "organized, printable official receipts" / "الإيصال الرسمي" (the product's own existing Arabic copy, already honest). **Do not** describe this as "government e-invoicing," "tax-authority integration," or "ETA compliance" — this is confirmed to be an internal receipt-tracking ledger only (serial numbers, atomic transactions, a reversal lifecycle), with zero HTTP/webhook calls to any government system. |
| Reports / analytics | **VERIFIED** | Reports were confirmed to reconcile exactly to raw SQL queried directly against real production data — no discrepancy found. |
| WhatsApp notifications | **VERIFIED ARCHITECTURE / NOT YET LIVE WITH REAL CUSTOMERS** | The integration is architecturally complete and well-hardened — a real circuit breaker, rate limiting, quiet hours, consent re-validation, and correct tenant isolation (two historical cross-tenant leaks reconfirmed fixed), correctly wired into booking/payment/academy notification events. But only 2 WhatsApp accounts exist in production, both on test-fixture clubs, both currently `logged_out`/`qr_required` — no real customer has ever connected a real WhatsApp number. This is accurate pre-launch framing, not a defect to hide: say "WhatsApp notifications are built and ready to connect" rather than "our clubs use WhatsApp today." |
| Customer self-service portal | **VERIFIED SAFE** | Portal cross-persona and account-takeover vectors were closed and confirmed via live adversarial testing this session. A customer cannot see another customer's or another tenant's data through the portal. |
| Multi-branch support | **VERIFIED** | Branch/field/academy hard limits are enforced correctly by table-level triggers with row locking (no bypass, no race condition possible) per the plan's entitlements, matching the intended truth table exactly. |
| Staff permissions / role-based access | **VERIFIED, server-enforced**, with one open caveat | Permission enforcement is real and server-side (RLS + `has_permission()`-gated RPCs), not merely hidden in the UI — confirmed via live adversarial role-boundary testing. One open, narrow caveat: `players.medical_notes` currently has no column-level RLS enforcement on SELECT (write-side is correctly gated). It is not exploitable through the shipped UI today (no frontend call site selects that column), but a direct API query from certain roles holding `player.view` but not `player.medical_notes.view` would succeed. Do not claim medical/sensitive player fields are fully access-controlled at every layer until this is fixed — do not volunteer this caveat unprompted in a sales conversation either; it is a real but narrow, non-customer-facing gap, not a live breach. |
| Automated data migration from another system | **DO NOT CLAIM EXISTS** | No import/CSV/bulk-import tooling for customers, players, or facility data exists anywhere in this repository — confirmed by direct search across the codebase and migrations. If a prospect asks about migrating from a spreadsheet or another system, this is an unplanned scope discussion to have honestly, not a feature to imply already exists. |
| Trial / free-trial signup flow | **VERIFIED, now fixed** | The self-serve onboarding wizard and the sales-conversion RPC path both previously had a P0 defect where the trial never actually started (an owner would be created and then immediately locked out with zero access). Both paths were fixed this session, applied to production, and verified live. It is now safe to claim "start a free trial in minutes" without qualification. |
| Founding-customer discount offer (first 5 customers, 50% off 3 months) | **DO NOT CLAIM AS SELF-SERVE AVAILABLE** | The offer is correctly built and atomic at the database level (`claim_founding_customer_slot()`), but has zero frontend entry point anywhere in the product today — a customer cannot claim it themselves through any screen. If offering this commercially, it must currently be granted manually via direct database/RPC access, not advertised as something a customer can activate on their own. |
| Grace-period handling for staff/active-player soft limits | **DO NOT CLAIM AS FULLY AUTOMATED** | The grace-period design exists and is real, but `refresh_commercial_grace_state()` — the only writer of that state — is never invoked by anything (no scheduler, no frontend caller). A tenant's grace status cannot currently advance to `over_limit` on its own. Do not claim the platform automatically manages soft-limit overages end-to-end until this scheduler gap is closed. |

## How to use this document

Treat every "VERIFIED" row as safe to state plainly in sales
conversations, pitch decks, and the demo script
(`MAL3ABY_10_MINUTE_DEMO_RUNBOOK.md`). Treat every "DO NOT CLAIM" row as a
hard boundary, not a nuance to soften with hedging language — either don't
raise the topic, or if a prospect asks directly, answer honestly using
the wording given above rather than implying more maturity than exists.
Re-check this matrix before any major sales collateral refresh, since
several of the "not yet" rows (founding offer, grace-period scheduler,
academy QR adoption) are expected to change status as real usage
accumulates after the first customers come on board.
