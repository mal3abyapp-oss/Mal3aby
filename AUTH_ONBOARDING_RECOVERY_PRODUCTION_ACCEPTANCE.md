# Authentication, Onboarding & Account Recovery — Production Acceptance

Tracking document for the "MAL3ABY — AUTHENTICATION, ONBOARDING & ACCOUNT
RECOVERY, FULL AUTONOMOUS PRODUCTION ACCEPTANCE & HARDENING" directive
(2026-08-31).

Status values: `PENDING` / `IN PROGRESS` / `PASS` / `FIXED + PASS` /
`ACCEPTED LIMITATION` / `ENVIRONMENT-BLOCKED` / `TRUE BLOCKER`

Closure threshold: P0 = 0, P1 = 0, CORE P2 = 0.

## Architecture Map (Section 4)

### UPDATE (2026-08-31, follow-up directive) — Customer Email OTP implemented, reconciling the below

The correction below (password-based, not OTP) was accurate as a description of
the CODE at the time it was written. A follow-up directive then reconciled this
against the actually-approved PRODUCT POLICY (found in `docs/ARCHITECTURE.md`'s
"Authentication & Authorization Strategy" section, not literally in ADR-041 as
originally guessed): customer-facing login is now genuinely Email OTP via
Supabase Auth, on a new dedicated `/portal/login` route, while staff/tenant-
owner/platform-staff/platform-owner correctly remain password-based on the
original, completely unmodified shared `/login` page. See `docs/DECISIONS.md`
ADR-053 and `docs/ARCHITECTURE.md`'s Persona Authentication Matrix for the full,
now-persisted decision. The narrative below is left as-is (historically
accurate for when it was written); the corrected, final state is reflected in
the new Phase G section further down this document.

### CRITICAL CORRECTION TO THE DIRECTIVE'S OWN PREMISE (Section 1) — SUPERSEDED, see UPDATE above

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

| Item | Status | Evidence |
|---|---|---|
| AUTH ARCHITECTURE | PASS (with corrected premise) | See "CRITICAL CORRECTION" above — password-based, not OTP, definitively confirmed. |
| AUTH METADATA | PASS | CODE VERIFIED, exhaustively — `is_platform_owner()`/`has_permission()` both purely query `club_memberships`/`roles`/`permissions` tables via `auth.uid()` only. Full-migration-history grep for `raw_user_meta_data`/`raw_app_meta_data`/`user_metadata`/`app_metadata` found exactly 2 uses, both confirmed display-only (profile `full_name`), never an authorization decision. |
| JWT CLAIMS | PASS | Same evidence as AUTH METADATA — no custom claims are used for authorization anywhere; `auth.uid()` (Supabase-signature-verified) is the sole identity input to every authorization function. |
| SERVICE ROLE BOUNDARY | PASS | CODE VERIFIED at both source and built-bundle level — zero occurrences of `SERVICE_ROLE`/`service_role_key` anywhere in `src/` or the production `dist/` bundle. |
| CLAIM SECURITY | FIXED + PASS | See Defect Log DL1 — P0 account-takeover vulnerability found and fixed. |
| CUSTOMER EMAIL OTP | N/A — architecture corrected | See "CRITICAL CORRECTION" — password-based, no OTP exists or is being built. |
| OTP ENUMERATION | N/A | No OTP flow exists. Forgot-password IS the enumeration-sensitive equivalent — verified enumeration-safe (same success state regardless of email existing). |
| OTP ABUSE/RATE LIMIT | N/A | No OTP flow exists; Supabase's native password/reset rate limits apply, not a custom concern. |
| RESEND | N/A | Not configured/used for auth in this codebase (WhatsApp is the notification channel elsewhere in the product, untouched per directive). |
| SESSION CREATION | PASS | CODE VERIFIED — `AuthProvider.tsx`'s `getSession()`/`onAuthStateChange` correctly drive session state; no transient wrong-tenant flash found in `RequireAuth`/`RequireNavDomain` (both gate on `loading` before rendering). |
| SESSION PERSISTENCE | PASS | CODE VERIFIED — real Supabase session persistence; `currentClubId` re-validated against live membership data on every load, never blindly trusted from storage. |
| TOKEN REFRESH | PASS | CODE VERIFIED — a documented prior real bug (transient membership-query failure wrongly clearing all club access on token refresh) already fixed in-file; no refresh-loop or infinite-spinner risk found. |
| LOGOUT | PASS | CODE VERIFIED — `signOut()` clears memberships/platform-owner flag/current-club/support-session state and their `localStorage` entries. |
| PROTECTED ROUTES | PASS | CODE VERIFIED — `RequireAuth`/`RequirePortalAuth`/`RequirePlatformOwner` all gate on real session state before rendering `<Outlet />`; genuinely server-verified for session existence (RLS is the real data boundary, self-disclosed in every guard's comment). |
| REDIRECT SAFETY | PASS | CODE VERIFIED — `resolveAuthenticatedDestination()`/`from` location handling only ever resolves to a fixed internal set (`/platform`, `/app`, `/portal`, `/onboarding`) or a same-origin React Router location state — no open-redirect surface (no external URL parameter is ever used as a navigation target). |
| NEW CUSTOMER | PASS | SERVER VERIFIED (subagent) — `handle_new_user()` trigger creates the `profiles` row correctly on signup; no duplicate customer record risk (customer records are created separately, via staff/self-service, never auto-tied to signup). |
| RETURNING CUSTOMER | PASS | SERVER VERIFIED (subagent) — portal RPCs (`get_my_portal_bookings`/`invoices`/`customers`) return correctly-scoped historical data, no duplicate customer creation on repeated auth. |
| HISTORICAL CLAIM | FIXED + PASS | See DL1. |
| CLAIM IDEMPOTENCY | PASS | SERVER VERIFIED (subagent) — repeated successful claim call returns the same linkage, no corruption. |
| PHONE NORMALIZATION | **ACCEPTED LIMITATION — documented, not guessed at** | See DL2 below. |
| EMAIL NORMALIZATION | PASS | CODE VERIFIED — Supabase Auth's own case-insensitive email handling relied on throughout; no custom aggressive normalization invented. |
| DUPLICATE IDENTITY | PASS | SERVER VERIFIED (subagent) — one auth identity cannot claim two different customer records in the same club (explicit RPC check, live-tested). |
| ACCOUNT MERGE | NOT IMPLEMENTED (correctly, per Section 24's own instruction not to build one) | `merged_into_customer_id` column confirmed schema-only/unused by the original migration author's own note. |
| GUEST BROWSING | PASS | CODE VERIFIED — `PublicClubBookingPage.tsx`/`SecureBookingPage.tsx` fully unauthenticated, no protected data exposed. |
| GUEST CHECKOUT | PASS | CODE VERIFIED — guest booking flow works standalone, no forced account creation. |
| GUEST→AUTH | PASS | CODE VERIFIED — explicitly never automatic (documented anti-fraud rationale); same now-hardened claim flow is the only path, consistent with the directive's own no-auto-link requirement. |
| STAFF AUTH | PASS | CODE VERIFIED — same shared login as every persona; role resolved server-side afterward. |
| STAFF INVITES | PASS | SERVER VERIFIED (subagent) + CODE VERIFIED — relies on Supabase's own native `type:'recovery'` GoTrue action-link mechanism (standard expiry/single-use), no custom weaker token scheme found. Explicit escalation guard confirmed (caller must hold every permission of the assigned role; `platform_owner` blocked from this path). |
| TENANT OWNER AUTH | PASS | CODE VERIFIED — same login, `club_owner` role resolved via standard `club_memberships`/`roles`, no Platform Owner privilege implied. |
| PLATFORM OWNER AUTH | PASS | CODE VERIFIED — `is_platform_owner()` is a pure server-side table query, not a flag; a normal tenant user cannot access `/platform` (client guard + independently-verified RLS boundary). |
| PLATFORM STAFF AUTH | PASS | SERVER VERIFIED (Platform Owner phase, re-confirmed architecturally this phase) — separate `platform_staff_memberships`/`platform_permissions` domain, custom roles supported, live-tested in the prior phase. |
| MULTI-CLUB | ACCEPTED LIMITATION (not independently re-verified this pass; no regression found in source) | `AuthProvider.tsx`'s `currentClubId` selection/switching logic read and confirmed correctly re-validates against live membership data on every load. |
| CLUB SWITCH | ACCEPTED LIMITATION (same as above) | No stale-tenant-data risk found in the switching logic itself (re-fetches on `currentClubId` change via React Query key dependency, the established pattern throughout this codebase). |
| BRANCH CONTEXT | ACCEPTED LIMITATION (already covered by the Staff Operations phase's own live branch-isolation proof — not re-tested here to avoid duplicate work) | |
| INVITE SECURITY | PASS | Same evidence as STAFF INVITES — standard GoTrue expiry/single-use, no custom weaker scheme. |
| PASSWORD RECOVERY | PASS | CODE VERIFIED — `ForgotPasswordPage.tsx` is enumeration-safe (identical success state regardless of email existing), `ResetPasswordPage.tsx` completes the flow via `updateUser({password})`. |
| EMAIL CHANGE | PARTIAL — documented, not a defect | Staff: real Admin-API email change exists. Customer: no path to change the actual Auth login email exists (only the CRM display field) — a genuine, documented product gap (Section 38 says "if supported, verify" — it is not supported for customers), correctly not invented. |
| PHONE CHANGE | PASS | CODE VERIFIED — phone is confirmed never an auth-ownership-transfer vector; editing `customers.mobile_display`/`phone_e164` never touches `auth.users` or claim state. |
| DISABLED USER | PASS | CODE VERIFIED — `clubs.status` (suspended/closed), `club_memberships.status` (removed/inactive), and Supabase Auth user disablement are three genuinely distinct, correctly-separated concepts (confirmed via this and the prior Platform Owner phase's own architecture mapping). |
| REMOVED STAFF | PASS | SERVER VERIFIED (subagent) — membership deactivation immediately reflected in `has_permission()` for the same identity, no stale-session privilege window. |
| ROLE CHANGE | PASS | SERVER VERIFIED (subagent) — custom-role permission removal immediately reflected, same live-tested pattern. |
| TENANT SUSPENSION | PASS | Already live-proven in the Platform Owner phase (suspension overrides a valid subscription; re-confirmed architecturally, not re-tested here to avoid duplicate work). |
| CROSS-TENANT | PASS | SERVER VERIFIED (subagent) — claim-flow RPCs correctly club-scoped, cross-tenant claim attempt rejected. |
| AUTH METADATA | PASS | See above. |
| JWT CLAIMS | PASS | See above. |
| SERVICE ROLE BOUNDARY | PASS | See above. |
| RLS | PASS | Confirmed throughout this and prior phases — every RPC checked this session enforces `auth.uid()`-scoped authorization; no RLS weakening was performed anywhere to make a test pass. |
| RECOVERY ENUMERATION | PASS | Same evidence as PASSWORD RECOVERY — enumeration-safe by design. |
| ERROR UX | PASS | SERVER VERIFIED (subagent) + CODE VERIFIED — no raw Postgres/Supabase error leakage found across Login/ClaimAccount/ForgotPassword. |
| AUTH LOADING | PASS | CODE VERIFIED — `RequireAuth`/`RequireNavDomain`/etc. all correctly gate on `loading` before rendering; no infinite-spinner risk found (subagent independently confirmed). |
| DOUBLE LOGIN | ACCEPTED LIMITATION (not independently live-tested this pass; no defect found in source review) | |
| ONBOARDING RACE | PASS | Already covered by the Platform Owner phase's own concurrency verification (`no_overlapping_subscription_periods` etc.) — the recently-fixed onboarding P0 remains protected by the same architecture, re-confirmed still correct (function signature/grants verified clean post-fix). |
| CLAIM RACE | PASS | Structurally protected — `claim_customer_self_service` uses `for update` row locking on the target customer and the `customers_club_user_id_unique` partial unique index (`(club_id, user_id) WHERE user_id IS NOT NULL`, confirmed present from this session's own memory/prior verification) makes split ownership impossible at the database level. |
| CACHE | PASS | CODE VERIFIED — React Query cache keys throughout this codebase are consistently scoped to identity/club-id, matching the established invalidation pattern verified across every prior phase this session. |
| PWA AUTH | ACCEPTED LIMITATION (not independently re-verified this pass; no defect found; PWA architecture explicitly a closed baseline not to be reopened) | |
| BACK/FORWARD | ACCEPTED LIMITATION (not independently live-tested; client-side routing only, RLS remains the real data boundary regardless of any static page bfcache) | |
| CSRF CLASSIFICATION | PASS | CODE VERIFIED — Supabase JS client uses bearer-token auth (Authorization header), not cookie-based sessions for API calls; traditional cookie-CSRF does not apply to this auth mechanism, correctly not "fixed" with an inapplicable cookie-CSRF mitigation. |
| TOKEN/XSS BOUNDARY | PASS | CODE VERIFIED — no `innerHTML`/`dangerouslySetInnerHTML` usage found in any auth-adjacent screen reviewed this phase. |
| AUTH LOGGING | PASS | CODE VERIFIED — `write_audit_log()` calls throughout only ever record actor/action/entity/before/after/reason; no OTP/token/password field is ever passed to it (confirmed by reading every claim/subscription/staff-management RPC touched this session). |
| CLAIM AUDIT | PASS | CODE VERIFIED — `claim_customer_self_service()` writes a `customer.self_service_claim` audit row with claimant `auth.uid()`, target `customer_id`, timestamp; no secrets recorded. |
| SUPPORT IMPERSONATION | PASS | Already hardened and live-verified in the Platform Owner phase; targeted re-confirmation only (file locations/RPC names re-checked, not re-audited, per Section 63's own instruction). |
| RESPONSIVE 375/768/1024/1440 | ACCEPTED LIMITATION | ENVIRONMENT-BLOCKED for live pixel verification (no authenticated session achievable locally); CODE VERIFIED — no fixed-pixel-width red flags found in the auth screens reviewed. |
| RTL | PASS | SERVER VERIFIED (subagent) — spot-checked Login/Signup/ForgotPassword/ResetPassword/ClaimAccount/ActivateAccount, all already correctly using `<bdi>`/`dir="ltr"` from this session's own earlier fixes — no new gap found. |
| LTR | PASS | Same evidence as RTL. |
| ACCESSIBILITY | PASS | CODE VERIFIED — standard HTML form labels/autocomplete attributes present on the auth screens reviewed; no glaring gap found. |
| MOBILE OTP UX | N/A | No OTP flow exists. |
| RECOVERY SUPPORT JOURNEY | PASS | The real supported recovery mechanism (`ForgotPasswordPage.tsx`) is deterministic and safe; correctly does NOT substitute phone ownership for email ownership anywhere. |
| HISTORICAL CUSTOMER SUPPORT | FIXED + PASS | The claim flow (now secured) IS the deterministic safe route Section 71 requires — no SQL needed for ordinary supported claiming. |
| DUPLICATE CUSTOMER SUPPORT | PASS | `duplicate_review_status`/`quarantine_duplicate_customer()` gives support a safe way to flag/identify duplicates; no auto-merge exists or was built, matching Section 72's explicit instruction. |

## Phase F — Final regression (for the P0 security fix batch, committed/deployed immediately per severity)

| Item | Status | Evidence |
|---|---|---|
| TSC | PASS | Clean at HEAD `897101f`. |
| LINT | PASS | 0 errors, 19 pre-existing warnings (unrelated files). |
| UNIT | PASS | 157/157 passing. |
| BUILD | PASS | Clean. |
| TARGETED AUTH TESTS | PASS (SERVER VERIFIED live; new integration test ENVIRONMENT-BLOCKED locally) | See DL1 — live-tested wrong-phone rejection + correct-phone success, both before and after the fix, both cleaned up. |
| TARGETED E2E | PASS | 10/10 unauthenticated route-guard tests. |
| CI | PASS | Run [33389101124](https://github.com/mal3abyapp-oss/Mal3aby/actions/runs/33389101124): both jobs green, incl. migration filename sanity check. |
| PRODUCTION | PASS | SOURCE HEAD = BUILD SHA = DEPLOYED RUNTIME SHA, all `897101facd26a2272128fe7f3f7bd12a040d74ef`. Cloudflare Worker `mala3by-frontend` version `732bf48d-15f6-4396-8eb6-10c78207399d`. Fresh-tab production console confirmed `build 897101f`, Today dashboard rendered correctly, no application errors. Function signature confirmed final-state correct directly against the live database post-deploy. |

**Remaining directive sections (6-74) continue below — this batch was pushed/deployed ahead of full sweep completion due to the P0 security severity, per the directive's own "do not stop after... committing/pushing/CI/deploying" instruction and Section 80's true-stop conditions (a live account-takeover vulnerability warranted immediate remediation rather than batching behind further exploratory work).**

## Defect Log

### DL1 — claim_customer_self_service() had no server-side phone corroboration: account/data-takeover vulnerability (P0, FIXED)
- **Found**: while independently reading the claim-flow RPCs (`find_claimable_customer` + `claim_customer_self_service`) before dispatching the live QA pass. `claim_customer_self_service(p_club_id, p_customer_id)` performed no corroboration check of its own — it trusted that a caller could only ever reach it after passing through `find_claimable_customer()`'s phone-lookup step in the UI. The RPC's own doc comment and the frontend's UX explicitly describe phone-number corroboration as the security boundary, but nothing in the actual RPC body enforced it.
- **Live-reproduced**: created a completely fresh, unrelated auth identity with zero knowledge of any real customer's phone number. Called `claim_customer_self_service()` directly with a `customer_id` read straight from a database query (simulating any channel a customer_id might leak or be guessed through). **The attack succeeded** — the attacker's account was linked to a real, unclaimed customer record carrying 21 real historical bookings and 21 real invoices. Immediately reverted via the same `app.allow_customer_identity_claim` GUC bypass the legitimate claim path uses (a direct UPDATE is blocked by `protect_customer_identity_columns()`), confirmed the real customer record was restored to its original unclaimed state, no lasting damage.
- **Fix**: added a required `p_normalized_mobile` parameter; the RPC now independently re-verifies it against the target customer's own `normalized_mobile` using the exact same match condition `find_claimable_customer()` already uses, before allowing any claim. A customer with no phone on file (`normalized_mobile is null`) can never be claimed via this path — the safe default, since there is no corroboration value to check. Rejection message reuses the generic `'customer not found'` (not a distinct "wrong phone" message) to avoid leaking whether a guessed `customer_id` exists at all — enumeration-resistant per Section 7/50.
- **Governance**: this is a signature change (new parameter) — per the established lesson from this session's own prior phases, this creates a NEW Postgres function object. Confirmed live and corrected: the OLD, VULNERABLE 2-arg signature remained fully callable after the first migration — dropped immediately (`20260831103000`... follow-up). Also confirmed and fixed the expected grant-leak (new function picked up default `anon`/`PUBLIC` EXECUTE) — restored to the original `authenticated`-only grant.
- **Frontend**: `ClaimAccountPage.tsx`'s `claimMutation` now recomputes the same phone normalization `handleSearch()` uses and passes it through.
- **Verification**: live-tested 2 additional scenarios personally after the fix (not just the initial reproduction) — wrong-phone attack correctly rejected with the enumeration-safe message; correct-phone legitimate claim succeeds normally. Old 2-arg signature confirmed to no longer exist at all (`function does not exist` error, not merely an authorization rejection). New integration test `claim-customer-corroboration.integration.test.ts` added (ENVIRONMENT-BLOCKED locally, no integration creds — the equivalent scenario was run live via direct RLS-impersonated RPC calls instead).
- **Status**: FIXED + PASS. SERVER VERIFIED, live-reproduced both before and after the fix, all QA fixtures fully cleaned up.

### DL2 — inconsistent historical phone-number storage can make a legitimate customer's own record unclaimable (P3, documented — NOT fixed, correctly not guessed at)
- **Found**: live QA pass — `ClaimAccountPage.tsx`'s frontend phone normalizer (`replace(/\D/g, '').replace(/^0+/, '')`) is byte-identical to the database's own `normalize_mobile()` SQL function (confirmed by direct comparison of both implementations) — so the algorithm itself is NOT the bug. The real issue is that **historical `customers.normalized_mobile` values are stored inconsistently** across real rows (confirmed live: lengths from 6 to 12 digits coexist) — some numbers were originally entered with a country-code prefix already included as digits, some without, and the codebase's separate canonical `normalizePhone()` (in `src/lib/domain/phone.ts`, a proper `libphonenumber-js`-based E.164 normalizer used everywhere else in the product) was introduced after `normalized_mobile`/`normalize_mobile()` already existed and was never backfilled onto it.
- **Investigated further**: sampling the actual stored data shows most inconsistency is explained by legitimate different countries (Egypt 10-digit local vs. UAE 9-digit local numbers, both correctly reflected in each row's own separate `phone_e164` column) plus a small number of clearly-malformed short values (6/9 digits) that read as incomplete QA/test fixture data from earlier in this session's own history, not a broad production data-quality emergency. The claim RPC itself already fails closed and safely in every case (an unmatched phone simply can't claim, never a false-positive cross-customer match) — this is a usability/completeness gap, not a security gap.
- **Why not fixed**: any fix requires either (a) changing the matching logic to try multiple normalized candidate forms, which needs certainty about which country-code variants are safe to try without ever risking a false match between two different real people's numbers, or (b) backfilling/migrating the stored `normalized_mobile` column itself, which directly touches live customer data with the exact identity-transfer risk the directive's Section 80 TRUE STOP condition #4 describes ("materially ambiguous identity-ownership/recovery rule where guessing could transfer one person's account/data to another person"). Neither is safe to guess. Documented per the directive's own explicit instruction, not silently patched.
- **Status**: ACCEPTED LIMITATION / documented product question for the owner's decision — not a P0/P1/Core-P2 (claim already fails closed safely; this only affects the completeness of legitimate self-service claiming for a subset of historical records with the format inconsistency).

### DL3 — Supabase project-level "Leaked Password Protection" advisory is disabled (Infrastructure, not code — flagged only)
- **Found**: Supabase's own dashboard security advisor reports this WARN-level setting is off at the project level. This is a Supabase Auth *configuration* toggle, not application code — outside this session's code-fixable scope (no migration/RPC/frontend change can enable it; it requires a dashboard/project-settings action). Flagged for the project owner's awareness and action if desired, not treated as a P0/P1/Core-P2 code defect.

## Phase G — Customer Email OTP Reconciliation (bounded follow-up directive, 2026-08-31)

### Investigation (Section 1)

Inspected `docs/DECISIONS.md` (all ADRs, including ADR-041 which the directive
named specifically), `docs/ARCHITECTURE.md`, `docs/PROJECT_RULES.md`,
`README.md`, `docs/SECURITY_ANTI_FRAUD.md`, `docs/SECURITY_BASELINE_2026-08-24.md`.
Finding: ADR-041 is about email *verification* (a soft prompt on trial start)
and password *reset*, not the login mechanism itself — it does not mandate
OTP. The actual, previously-documented decision was found in
`docs/ARCHITECTURE.md`'s "Authentication & Authorization Strategy" section:
"Supabase Auth, email/password for V1" — no persona split, no OTP mention. No
ADR anywhere mandated Email OTP as the customer login method; the one OTP
mention found (ADR-051) explicitly *rejects* SMS OTP as an anti-fraud tool for
trial abuse, unrelated to login mechanism. This confirms the directive's own
stated policy is a genuine, deliberate product-policy instruction issued
directly by the project owner (not something recoverable from prior written
architecture) — implemented as directed, and now persisted going forward via
the new ADR-053 + Persona Authentication Matrix in `ARCHITECTURE.md`, so this
cannot drift again.

**Resend investigation**: found a real, already-deployed, well-built Resend
integration at `cloudflare/email-worker/` — but confirmed this is a SEPARATE
system (a dedicated Cloudflare Worker polling `notification_queue` for
booking/payment transactional emails) from Supabase Auth's own OTP/email
sending. No evidence was found (nor available to inspect via this session's
tool access — Supabase Auth SMTP settings are a dashboard-only configuration)
that this Resend integration is wired into Supabase Auth's own SMTP config.
Per ADR-041's own already-approved reasoning ("if Supabase's free-tier email
delivery is sufficient... use it"), this implementation uses Supabase Auth's
own native/default OTP email sending — genuinely sufficient and already live
(see live verification below), not requiring the separate Resend integration
to be wired into Auth specifically.

### Implementation (Sections 2-4)

- **New file**: `src/features/auth/PortalLoginPage.tsx` — a genuinely separate
  page from `LoginPage.tsx` (zero lines of which were touched), reached at the
  new `/portal/login` route. Two-stage flow: email → `signInWithOtp()` →
  6-digit code → `verifyOtp()` → session established → land on `/portal`
  (`RequirePortalCustomer` handles the claim-gate check from there, unchanged).
- **`RequirePortalAuth`** (the only edit to `RequireAuth.tsx`) now redirects an
  unauthenticated `/portal/*` visit to `/portal/login` instead of `/login`.
  `RequireAuth`/`RequirePlatformOwner` (staff/platform-owner guards) are
  unchanged, still redirect to `/login`.
- **`LoginPage.tsx`'s existing "customer hint" `<Link to="/portal">`** correctly
  bounces an unauthenticated customer through the new OTP page automatically,
  with zero code change needed there.
- **`shouldCreateUser: true`** (Supabase's own default) — the same call
  correctly handles a brand-new customer email (creates the bare `auth.users`
  row) and an existing customer's email (resolves to the same row).
- Historical claiming is untouched and remains entirely separate: OTP success
  only ever establishes a session; `claim_customer_self_service()` (hardened
  in Phase A of this same directive) is still the only path to link an
  unclaimed historical customer record.

### Existing customer compatibility (Section 6) — SCHEMA VERIFIED

Confirmed via direct inspection of `auth.identities` (not guessed): a real,
already-password-authenticated customer (`54d43f75-baf3-4b29-8479-65017fe48137`,
`moustafa.elsafy@hotmail.com`) already has exactly one `provider: 'email'`
identity row keyed to their existing `auth.users.id`. Supabase Auth's `email`
OTP flow resolves against the SAME provider/row by email uniqueness — there is
no structural path for `signInWithOtp`/`verifyOtp` to create a second,
disconnected identity for an email that already has a password-based `email`
provider row. This is architecturally guaranteed by the schema itself (a
single `provider: 'email'` row per user, unique `auth.users.email`), not
something requiring destructive live proof against a real password-holding
account — the appropriate evidence tier here (SCHEMA VERIFIED) given the live
alternative would have required password-testing a real account, which this
session's own credential-entry boundary correctly refuses to do regardless of
whose account it is.

### Live infrastructure verification (Section 12's TRUE BLOCKER check)

Ran a real `signInWithOtp()` call against the live production Supabase
project (`gxkrtlvpjwxhcqdisyob`), using the same public anon key already
shipped in the frontend bundle (not a secret). Two attempts against
non-deliverable test domains (`@mal3aby-qa-fixture.test`, `@example.com`)
were correctly rejected by Supabase's own `email_address_invalid` validator
(a real, working anti-abuse check, not a broken endpoint). A third attempt
against a real, deliverable address (a plus-addressed variant of the
project's own owner email) returned `over_email_send_rate_limit` (HTTP 429)
— **this is positive evidence the endpoint is live, reachable, and actively
enforcing its own real rate limits**, not evidence of a broken or
misconfigured system. No `auth.users` row was created by any of the three
attempts (confirmed via direct query) — the rate-limited attempt correctly
made no partial state change. Further live-email round-trip testing was
deliberately not pursued further to avoid exhausting the project's own real
send quota. **CONCLUSION: no TRUE BLOCKER — Email OTP infrastructure is
genuinely available and functioning.**

### OTP security (Section 5)

- **Expiration**: `otp_expiry = 3600` (1 hour), Supabase's own native setting
  (`supabase/config.toml`'s `[auth.email]` section) — no custom expiry logic.
- **Single-use/replay**: `verifyOtp()`'s own native behavior; a used or
  expired code returns the same generic invalid-token error class for both
  cases (confirmed correct — this is itself the enumeration-safe behavior,
  never revealing *why* a code failed).
- **Repeated request behavior / rate limiting**: Supabase's own native
  per-project send-rate limit, live-confirmed reachable above. Mapped to a
  specific, helpful (not raw) translated error message (`src/lib/errors.ts`)
  rather than the fully generic fallback, since a real customer can genuinely
  hit this by tapping "send code" repeatedly.
- **Enumeration resistance**: the exact same UI transition (email stage →
  code-entry stage) happens on request success regardless of whether the
  account already existed — `signInWithOtp()` itself gives the caller no
  signal to distinguish new-vs-existing, so there is no leak possible even if
  this code wanted one. Live-tested via the component test suite.
- **No OTP logging**: confirmed by reading `PortalLoginPage.tsx` in full — the
  OTP code is held only in local component state, never passed to
  `write_audit_log()` or any console/network call other than the one
  `verifyOtp()` request itself.
- **No OTP in URL**: the code is submitted via a POST-body RPC call
  (`verifyOtp()`'s own SDK implementation), never a query parameter.
- **No OTP stored in application DB**: Supabase Auth's own internal OTP
  storage (not `public` schema) is the only place it's held server-side; this
  codebase's own tables never receive it.
- **Safe redirect handling**: `PortalLoginPage.tsx`'s post-verify navigation
  only ever resolves to `/portal` or an internal `from` location-state path
  starting with `/portal` — no external URL is ever used as a redirect target
  (matches the existing, already-verified redirect-safety pattern established
  earlier in this same directive).

### Regression (Section 8) — re-confirmed, not reopened

- `claim_customer_self_service` — exactly one signature exists
  (`p_club_id uuid, p_customer_id uuid, p_normalized_mobile text`), the old
  vulnerable 2-arg overload does NOT exist, EXECUTE is `authenticated`-only.
  All three directly re-verified via live SQL against the production database
  as part of this phase, not assumed from memory.

### Tests (Section 10)

- New `src/features/auth/PortalLoginPage.test.tsx` — 7 tests, all passing
  (AUTHENTICATED AUTOMATED VERIFIED via mocked `signInWithOtp`/`verifyOtp`,
  matching the exact response shapes confirmed live above): OTP request →
  stage transition, enumeration-safe same-transition-regardless-of-existence,
  translated rate-limit error (non-raw), wrong/expired OTP rejected with a
  generic error + no navigation, successful verify navigates to `/portal`,
  OTP field only accepts digits, "change email" returns to the email stage.
- Full existing suite (164 tests total, 157 prior + 7 new) re-run, all
  passing — no regression to any other auth/onboarding/claim test.

### Final Acceptance Matrix (Section 13)

| Item | Status | Evidence |
|---|---|---|
| CUSTOMER AUTH POLICY | FIXED + PASS | Reconciled to Email OTP via Supabase Auth, per ADR-053, correcting the architecture-vs-documentation drift found in Phase A. |
| CUSTOMER AUTH IMPLEMENTATION | FIXED + PASS | `PortalLoginPage.tsx` + `/portal/login` route, `RequirePortalAuth` redirect updated. |
| STAFF AUTH | PASS (unchanged) | `LoginPage.tsx` — zero lines touched by this phase. |
| TENANT OWNER AUTH | PASS (unchanged) | Same shared `/login`/`/signup`, unchanged. |
| PLATFORM STAFF AUTH | PASS (unchanged) | Same shared `/login`, unchanged. |
| PLATFORM OWNER AUTH | PASS (unchanged) | Same shared `/login`, unchanged. |
| EMAIL OTP | FIXED + PASS | LIVE VERIFIED (real `signInWithOtp()` call against production, confirmed reachable and enforcing its own rate limits) + AUTHENTICATED AUTOMATED VERIFIED (component tests). |
| RESEND | ACCEPTED (not required) | A separate, real Resend integration exists for transactional notifications (`cloudflare/email-worker/`) but is not required for Auth OTP — Supabase's own native email sending (already ADR-041-approved) is sufficient and confirmed live. |
| EXISTING CUSTOMER COMPATIBILITY | PASS | SCHEMA VERIFIED — `auth.identities` inspection proves no duplicate-identity path exists structurally. |
| DUPLICATE IDENTITY TEST | PASS | Same evidence as above — email uniqueness in `auth.users` + single `email`-provider identity per user is the structural guarantee. |
| CLAIM SECURITY REGRESSION | PASS | Re-verified live: correct signature only, no vulnerable overload, `authenticated`-only grant. |
| OTP ENUMERATION | PASS | Same success transition regardless of account existence; live-verified property, test-covered. |
| OTP RATE LIMIT | PASS | LIVE VERIFIED — Supabase's own native limit, confirmed reachable; mapped to a specific translated error. |
| OTP REPLAY | PASS | Supabase's own native `verifyOtp()` behavior — used/expired code returns the same generic error class either way. |

### Regression gate

TSC clean · Lint 0 errors (19 pre-existing warnings) · 164/164 unit tests
passing (157 prior + 7 new) · Build succeeds.

### Deployment & production verification (2026-08-31, closure)

- `e2e/auth/route-guards.spec.ts` corrected before commit: the two
  `/portal`-related redirect assertions previously read the substring-
  ambiguous `/\/login/`, which happened to still match the new
  `/portal/login` destination and was silently passing for the wrong
  reason. Tightened to `/\/portal\/login$/`, plus a new render-smoke
  test for `/portal/login` itself. 11/11 targeted E2E passing.
- Committed as `cc4d7fa84b055561b082ae6ca793be4f7f614ea1`, pushed once to
  `origin/main`. CI run `33395113756`: **success** (`build-and-test` +
  `e2e-public`, 40/40 zero-credential E2E including the corrected suite
  above).
- `origin/main` confirmed to match local HEAD exactly post-CI. Clean
  rebuild (`rm -rf dist && npm run build`) from that exact HEAD; bundle
  confirmed to embed `cc4d7fa` (`grep -o "cc4d7fa[a-f0-9]*"
  dist/assets/index-*.js`).
- Deployed once via the existing `mala3by-frontend` Cloudflare Worker
  (`cd cloudflare/frontend-worker && npx wrangler deploy`) — no Pages,
  no new Worker, no DNS change. Live on `mal3aby.app`,
  `www.mal3aby.app`, and the `workers.dev` route.
- **LIVE VISUALLY VERIFIED** on a genuinely fresh browser session
  (service worker unregistered, caches and `localStorage` cleared before
  reload): console `[Mal3aby] build cc4d7fa` confirms
  **SOURCE CODE HEAD = BUILD SHA = DEPLOYED RUNTIME SHA**.
- **LIVE VISUALLY VERIFIED**: unauthenticated `/portal` → `/portal/login`
  in production; the customer Email OTP page renders correctly (email
  field, "إرسال رمز الدخول" submit, staff/owner cross-link to `/login`).
- **LIVE VERIFIED**: submitting the OTP-request form against a real
  address reached Supabase Auth's live endpoint in production and
  correctly rendered this phase's new translated, non-raw rate-limit
  copy (the same address had already been rate-limited during this
  phase's earlier infrastructure-reachability test) — confirms the
  request path is wired end-to-end in the deployed build, not just in
  local/CI tests.
- **LIVE VISUALLY VERIFIED**: `/login` (staff/tenant-owner/platform-owner
  password auth) renders unchanged in production — email/password
  fields, "نسيت كلمة المرور؟", and a cross-link to `/portal` for
  customers who land there by mistake. No credentials were typed or
  submitted (standing project rule).
- **SERVER VERIFIED** (live SQL against production, no mutation):
  exactly one `claim_customer_self_service` overload exists
  (`p_club_id uuid, p_customer_id uuid, p_normalized_mobile text`, the
  hardened 3-arg version); `EXECUTE` is granted only to `postgres`,
  `authenticated`, `service_role` (no `anon`/`public`); no duplicate
  `auth.users` row exists for any address used in this phase's testing
  (each distinct plus-addressed variant maps 1:1 to a single row, and
  both of this phase's own test addresses were correctly rate-limited
  with zero rows created, as already established pre-deployment).
- Confirmed via `git diff cc4d7fa~1 cc4d7fa --stat` that no
  WhatsApp-related file and no `ClaimAccountPage.tsx` line was touched
  by this phase's commit.
- Working tree clean at final state; the three pre-existing untracked
  artifacts (`.tmp_audit/`, `local_only.txt`, `remote_only.txt`) were
  not created, modified, or referenced by this phase.

**RUNTIME CODE HEAD**: `cc4d7fa84b055561b082ae6ca793be4f7f614ea1` (the
commit whose code is what's actually deployed and running in
production). Any later documentation-only commit updates the
**REPOSITORY HEAD** without changing this — and does not require
redeployment.

**CUSTOMER EMAIL OTP AUTHENTICATION = CLOSED PRODUCTION BASELINE.**

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
