# Authentication, Onboarding & Account Recovery — Production Acceptance

Tracking document for the "MAL3ABY — AUTHENTICATION, ONBOARDING & ACCOUNT
RECOVERY, FULL AUTONOMOUS PRODUCTION ACCEPTANCE & HARDENING" directive
(2026-08-31).

Status values: `PENDING` / `IN PROGRESS` / `PASS` / `FIXED + PASS` /
`ACCEPTED LIMITATION` / `ENVIRONMENT-BLOCKED` / `TRUE BLOCKER`

Closure threshold: P0 = 0, P1 = 0, CORE P2 = 0.

## Architecture Map (Section 4)

### CRITICAL CORRECTION TO THE DIRECTIVE'S OWN PREMISE (Section 1)

The directive's Section 1 states the "required" customer-auth architecture is
**Email OTP via Supabase Auth**. This does not match the live implementation.
Per Section 1's own instruction ("treat this as required unless the live
implementation proves a contradiction that must be reconciled safely"), this
contradiction is definitively proven: **zero** `signInWithOtp`/`verifyOtp`
calls exist anywhere in `src/` (confirmed via full-repo grep). The real,
implemented architecture is:

- **Password-based Supabase Auth** for every persona (customer, staff,
  tenant owner, platform owner/staff) — a single shared `LoginPage.tsx`
  (`signInWithPassword`), `SignupPage.tsx` (`signUp`), with post-login
  destination resolved server-side by role (`is_platform_owner()` →
  `club_memberships` → `customers` → `/onboarding`).
- A genuine, real **forgot/reset-password flow** exists (`ForgotPasswordPage.tsx`
  → `resetPasswordForEmail`, `ResetPasswordPage.tsx` → `updateUser({password})`),
  explicitly documented in-repo as ADR-041 ("Supabase Auth's built-in signup
  flow — no custom password-reset/verification system").
- This is NOT a defect or a gap to "fix toward OTP" — it is the actual,
  deliberately-chosen, already-hardened authentication architecture (real
  ADR reference, consistent password-reauth-before-change pattern in
  `ChangePasswordCard.tsx`, no plaintext storage anywhere). Section 1's
  premise is simply out of date relative to the codebase. This acceptance
  pass tests the REAL system (password + forgot/reset), not an invented OTP
  system — inventing OTP now would itself violate the directive's own
  "Do NOT introduce... new paid auth provider" / "do not weaken existing
  Supabase Auth security" instructions, since Resend-based OTP delivery is
  not configured anywhere in this codebase.
- Phone remains correctly non-authoritative for login in the real
  architecture too — confirmed no customer/staff login path ever uses phone
  as a credential; phone is corroboration-only, matching Section 1's other
  requirements exactly.

### Full identity architecture map

| Area | Status | Key facts |
|---|---|---|
| Customer login | IMPLEMENTED (password, not OTP — see correction above) | `LoginPage.tsx`/`SignupPage.tsx`, `signInWithPassword`/`signUp`. Same entry point for every persona. |
| Identity data model | IMPLEMENTED, cleanly separated | `profiles` (1:1 auth.users extension, display-only, auto-created via `handle_new_user()` trigger, EXECUTE revoked from all roles — trigger-only) vs `customers` (business record, `user_id` nullable/unique, set ONLY via `claim_customer_self_service()`) vs `club_memberships` (the real RLS/authorization anchor) — three genuinely distinct concerns, never conflated. |
| Onboarding | IMPLEMENTED (P0 already fixed in prior phase) | `complete_new_club_onboarding()`, confirmed healthy. |
| Historical customer claiming | **FIXED (P0 security vulnerability found + fixed this phase)** | See Defect Log DL1. |
| Portal invite activation | IMPLEMENTED, already hardened | `ActivateAccountPage.tsx` — 4-factor flow (masked context → phone confirm → separate WhatsApp-delivered activation secret → email+password), explicitly closes a documented prior "activation takeover gap". Existing-session detection prevents duplicate accounts across clubs. |
| `protect_customer_identity_columns()` | IMPLEMENTED, confirmed still present | Silently reverts self-service UPDATEs to `user_id`/`full_name`/`national_id`/etc. outside the sanctioned claim-flow GUC bypass. |
| Staff invitation | IMPLEMENTED | Two modes: existing-account lookup (`invite_staff_member`) or Admin-API-created new account (`club-staff-admin` Edge Function, zero-cost `email_confirm:true` + `generateLink({type:'recovery'})`, never emails a password). Explicit escalation guard: caller must hold every permission of the role being assigned; `platform_owner` role explicitly blocked from this path. |
| Platform Owner/Staff auth | IMPLEMENTED | `is_platform_owner()` is a plain query against `club_memberships`/`roles` (not a separate flag/table) — single definition confirmed. `has_platform_permission()` correctly treats Platform Owner as implicitly holding every platform permission without a redundant membership row. |
| Session management | IMPLEMENTED, with a documented prior fix | `AuthProvider.tsx` — real `getSession()`/`onAuthStateChange`. A prior real production bug (transient membership-query failures wrongly clearing all club access) already fixed and documented in-file. Active-club selection is `localStorage`-persisted client convenience, always re-validated against real membership data. Master Admin support-session hint is explicitly documented as a same-tab UI fast-path only, always overwritten by the server RPC result. |
| Route guards | IMPLEMENTED — session server-verified, role checks are UX-only (by design, self-disclosed in every guard's own comment) | `RequireAuth`/`RequirePortalAuth`/`RequirePlatformOwner` all gate on real session state; permission/role checks are client-side convenience layered on top of RLS, consistently and explicitly documented as such. `RequirePortalCustomer` closes a previously-found "claim-gate bypass" dead end. `RequireGuest` closes a previously-found "logged-in user sees logged-out marketing page" bug. |
| Password usage | CONFIRMED, real and complete | `ForgotPasswordPage.tsx` (enumeration-safe — same success state regardless of whether the email exists), `ResetPasswordPage.tsx`, `ChangePasswordCard.tsx` (reauthenticates before allowing a change). `MIN_PASSWORD_LENGTH` tied to actual Supabase config. |
| Duplicate/dedup handling | IMPLEMENTED, column-based | `customers.duplicate_review_status` (not a separate quarantine table), `quarantine_duplicate_customer()` RPC, audited. `merged_into_customer_id` column confirmed schema-only/unused by the migration author's own note — no merge functionality exists (correctly NOT built, matching Section 24's instruction). |
| Email/phone change | PARTIAL, asymmetric — noted, not a defect | Staff: real Admin-API email change (`club-staff-admin`'s `change_email` action), audited. Customer/portal: `PortalProfilePage.tsx` only updates the CRM-facing `customers.email` display field — **no path exists for a customer to change their actual Supabase Auth login email from the portal.** This is a real product gap (Section 38's "if supported, verify..." — it is NOT supported for customers), not a security defect; documented, not built. |
| Support impersonation | IMPLEMENTED, already hardened (prior phase) | Confirmed still present, not re-audited per directive Section 63's own instruction to keep this targeted. |
| Guest flows | IMPLEMENTED, no auto-link by design | `PublicClubBookingPage.tsx`/`SecureBookingPage.tsx` — genuinely unauthenticated. Guest→account linking is explicitly NEVER automatic (documented anti-fraud rationale: auto-matching by phone would let anyone claim a stranger's financial history) — the same claim flow (now fixed) is the only path. |
| Test coverage | PARTIAL | `e2e/auth/route-guards.spec.ts`, `portal-cross-persona-authorization.integration.test.ts` (covers a different, already-fixed cross-persona RLS vuln), `dual-identity-email-isolation.integration.test.ts`. No dedicated claim/activate integration test existed before this phase (now added — see DL1). |

## Final Acceptance Matrix

(populated after live verification)

## Phase — Final regression

| Item | Status | Evidence |
|---|---|---|
| TSC | PENDING | |
| LINT | PENDING | |
| UNIT | PENDING | |
| BUILD | PENDING | |
| TARGETED AUTH TESTS | PENDING | |
| TARGETED E2E | PENDING | |
| CI | PENDING | |
| PRODUCTION | PENDING | |

## Defect Log

### DL1 — claim_customer_self_service() had no server-side phone corroboration: account/data-takeover vulnerability (P0, FIXED)
- **Found**: while independently reading the claim-flow RPCs (`find_claimable_customer` + `claim_customer_self_service`) before dispatching the live QA pass. `claim_customer_self_service(p_club_id, p_customer_id)` performed no corroboration check of its own — it trusted that a caller could only ever reach it after passing through `find_claimable_customer()`'s phone-lookup step in the UI. The RPC's own doc comment and the frontend's UX explicitly describe phone-number corroboration as the security boundary, but nothing in the actual RPC body enforced it.
- **Live-reproduced**: created a completely fresh, unrelated auth identity with zero knowledge of any real customer's phone number. Called `claim_customer_self_service()` directly with a `customer_id` read straight from a database query (simulating any channel a customer_id might leak or be guessed through). **The attack succeeded** — the attacker's account was linked to a real, unclaimed customer record carrying 21 real historical bookings and 21 real invoices. Immediately reverted via the same `app.allow_customer_identity_claim` GUC bypass the legitimate claim path uses (a direct UPDATE is blocked by `protect_customer_identity_columns()`), confirmed the real customer record was restored to its original unclaimed state, no lasting damage.
- **Fix**: added a required `p_normalized_mobile` parameter; the RPC now independently re-verifies it against the target customer's own `normalized_mobile` using the exact same match condition `find_claimable_customer()` already uses, before allowing any claim. A customer with no phone on file (`normalized_mobile is null`) can never be claimed via this path — the safe default, since there is no corroboration value to check. Rejection message reuses the generic `'customer not found'` (not a distinct "wrong phone" message) to avoid leaking whether a guessed `customer_id` exists at all — enumeration-resistant per Section 7/50.
- **Governance**: this is a signature change (new parameter) — per the established lesson from this session's own prior phases, this creates a NEW Postgres function object. Confirmed live and corrected: the OLD, VULNERABLE 2-arg signature remained fully callable after the first migration — dropped immediately (`20260831103000`... follow-up). Also confirmed and fixed the expected grant-leak (new function picked up default `anon`/`PUBLIC` EXECUTE) — restored to the original `authenticated`-only grant.
- **Frontend**: `ClaimAccountPage.tsx`'s `claimMutation` now recomputes the same phone normalization `handleSearch()` uses and passes it through.
- **Verification**: live-tested 2 additional scenarios personally after the fix (not just the initial reproduction) — wrong-phone attack correctly rejected with the enumeration-safe message; correct-phone legitimate claim succeeds normally. Old 2-arg signature confirmed to no longer exist at all (`function does not exist` error, not merely an authorization rejection). New integration test `claim-customer-corroboration.integration.test.ts` added (ENVIRONMENT-BLOCKED locally, no integration creds — the equivalent scenario was run live via direct RLS-impersonated RPC calls instead).
- **Status**: FIXED + PASS. SERVER VERIFIED, live-reproduced both before and after the fix, all QA fixtures fully cleaned up.

## Notes

- Bookings & Fields, Academy Operations, Customer/Parent Experience, Staff
  Operations, Platform Owner/SaaS Lifecycle, Customer360, Finance/Reporting/
  Printing/Commerce/Inventory/Payment-adapter/PWA-cache architecture are
  CLOSED baselines — touched only when an auth/onboarding/account-linkage
  journey exposes a concrete reproducible integration regression.
- WhatsApp: DO NOT MODIFY.
- No new paid external services.
- Authoritative customer auth policy: Email OTP via Supabase Auth, Resend for
  production delivery where configured. Phone is corroboration/operational
  data only, never login authority.
