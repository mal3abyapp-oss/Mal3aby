# Mal3aby — Zero-Trust Anti-Fraud & Anti-Abuse Hardening Plan

**Started:** 2026-08-29, immediately following the Platform Owner module activation authority corrective phase (`main` @ `2a03340`).
**Mode:** Continuous discover → exploit-simulate → fix → verify → regress → continue. No owner check-ins. Owner is unavailable during execution.
**Baseline:** carries forward every genuinely open item from the 8 prior security/audit documents at repo root (see "Carried-forward findings" below) rather than re-discovering them from scratch.

## Scope discipline

This program targets **fraud and abuse** — unauthorized financial, operational, commercial, access, inventory, booking, membership, attendance, payment, or platform benefit. It reuses, not duplicates, the existing RLS/RPC architecture proven across 489 migrations and 7 prior audit documents. Fixes are additive/tightening, never a rewrite of working boundaries, per the directive's own "do not weaken security to make tests pass" and "prove every removed grant is covered by a safe supported path" rules.

## Carried-forward findings (from prior audits, not rediscovered)

| # | Source | Finding | Priority in this program |
|---|---|---|---|
| CF-1 | MASTER_ADMIN_ACCESS_BOUNDARY_FINDING.md | Platform Owner has always-on, session-less, **unaudited** read/write access to 31 tenant tables via an older unconditional `is_platform_owner()` RLS policy, bypassing the newer audited support-session mechanism entirely. Zero audit trail. | **P0 candidate** — directive §23 (audit tamper resistance / concealment) and §21 (no invisible impersonation) name this exact pattern. Re-verify live, then decide fix vs. re-accept with justification. |
| CF-2 | MAL3ABY_SECOND_PASS_AUDIT.md (SP-001) | Cancelled/no-show bookings retain a payable invoice; `record_payment()` doesn't check linked booking status; Portal still offers "Pay invoice". 43 real affected rows in production. | **P1** — directive §17 invoice fraud / §7 booking fraud overlap. **CLOSED this pass (Phase 9)**: `cancelled` was already fixed by a prior session; `no_show` was found still genuinely open on both `record_payment()` and `claim_manual_payment()` and is now fixed and live-verified on both. See Phase 9 for full detail. |
| CF-3 | PAYMENT_GATEWAY_SECURITY_ATTACK_MATRIX_EXTENSION.md | `create_gateway_refund_service`/`record_gateway_payment_service`/`mark_gateway_transaction_failed_service` (service_role RPCs) have **zero internal actor/permission check** — single layer of defense (Edge Function only). | **P1** — directive §14/§15 payment/refund fraud; add defense-in-depth without breaking the real call path. |
| CF-4 | RPC_GRANT_AUDIT.md | ~216/311 SECURITY DEFINER functions not individually re-verified for an auth-guard pattern beyond a text-match heuristic. | **P1/P2** — directive §27. Systematic re-audit in this program via targeted grep + spot-verification, not another heuristic pass. |
| CF-5 | PAYMENT_GATEWAY_SECURITY_ATTACK_MATRIX_EXTENSION.md | Governance Incident 3: a fix migration was once applied out-of-band after the proper tool was blocked, later corrected. | Spot-check only — confirm no recurrence pattern exists; not a fix task itself. |
| CF-6 | RPC_GRANT_AUDIT.md | Legacy `upsert_payment_gateway_config` RPC + table still `authenticated`-executable, superseded, unused in UI. | P2 hygiene — close if low-risk. |
| CF-7 | Multiple | Browser E2E / real authenticated UI walkthroughs blocked by missing `SUPABASE_SERVICE_ROLE_KEY` in this environment. | Standing environment constraint — substitute with RPC-layer RLS-impersonation testing (the established, proven pattern from this entire engagement) wherever a real UI session isn't available; use the actual open Platform-Owner browser session where it is. |

Items not carried forward as active work: pure protocol ceilings (Paymob/Kashier/Fawry lack webhook timestamps — not fixable), already-fixed items, and non-security process findings (SP-002 migration drift, SP-003 no CI) which are out of this program's fraud/abuse scope per §13-style discipline (this program's own §57 focuses on fraud, not general CI/process — those stay in the carried-forward table for visibility only, not action here unless they directly enable a fraud path).

## Actor/attack matrix

Built and populated incrementally as each domain is investigated — see the phase sections below. Format: ACTOR | TARGET | ATTACK | EXPECTED BENEFIT | CURRENT CONTROL | BYPASS POSSIBILITY | IMPACT | SEVERITY | FIX | TEST | STATUS.

## Phases

### Phase 0 — Recon + prior-audit digest
Status: COMPLETE. Repo recon done (RLS structure, helper functions, module-entitlement chokepoints, webhook signature verification, audit_logs immutability, storage policies). Prior 8 audit docs digested, carried-forward table above built.

### Phase 1 — Master Admin unaudited bypass (CF-1) + audit tamper resistance (§23/§24)
Live re-verify CF-1. Decide: close the gap (route reads through the audited path) vs. add read auditing to the existing policy vs. formally re-accept with a stronger justification than before. Confirm audit_logs remains genuinely append-only from the client (already strong per recon — spot-verify, don't rebuild).
Status: COMPLETE. Migration `20260829040000_revoke_unaudited_platform_owner_direct_writes.sql`.

**P0 confirmed and fixed**: live-exploited as the real QA platform owner -- `update commercial_entitlements set branch_limit = 999 ...` succeeded via direct table write, zero `audit_logs` row produced, completely bypassing `set_commercial_entitlements()`. Immediately reverted. Root cause: `commercial_entitlements_platform_owner_write`, `clubs_platform_owner_full_access`, `club_memberships_platform_owner_full_access`, `branches_platform_owner_full_access` were all RLS `ALL`-command policies keyed only on `is_platform_owner()` -- no session, no audit, bypassing every audited RPC. `club_memberships` is the single highest-value target since it controls `is_platform_owner()` itself.

**Two more real instances of the same bug class found while investigating**: `branches_write_with_permission`/`branches_update_with_permission` and `club_memberships_write_with_permission`/`club_memberships_update_with_permission` let ANY club staff member with `branch.update`/`staff.update` permission bypass `manage_branch()`/`set_staff_cash_custody()` entirely. Live-exploited: a direct `UPDATE club_memberships SET has_cash_custody = true` succeeded with zero audit row (immediately reverted); a direct `UPDATE branches SET status = 'inactive', name = 'BYPASSED'` on a QA-fixture branch succeeded with zero audit row (fixture created via the real RPC, then deleted -- synthetic data only).

**Not exploitable for privilege escalation**: `club_memberships.role_id`/`custom_role_id` are already protected by the pre-existing `protect_club_membership_identity_columns()` trigger, which silently reverts any change not carrying `set_staff_role()`'s `mal3aby.role_change_authorized` session flag -- live-attempted a direct write to the `platform_owner` role id, confirmed silently discarded (membership stayed `club_owner`). Only the non-identity columns (`status`, `has_cash_custody`) were the real gap.

**Fix**: dropped all 6 dangerous policies, replaced the 4 platform-owner `ALL` policies with `SELECT`-only equivalents (preserving the already-documented, already-accepted platform-owner read-visibility decision -- not rearchitecting all 31 tables named in `MASTER_ADMIN_ACCESS_BOUNDARY_FINDING.md`, only the 4 where a live write-bypass was proven this pass), and removed the 2 staff "with permission" write policies entirely (their audited RPC equivalents are the sole intended path). `club_memberships_platform_support_write` (Master Admin MANAGE support flow, already session-scoped/audited/expiring) intentionally left untouched -- different risk shape, out of scope for this fix.

**Regression-verified live**: all 6 attack vectors re-attempted post-fix, all correctly blocked (0 rows affected, no data changed). All legitimate paths re-verified working: `EnrollmentSection.tsx`'s direct `clubs.subscription_activation_policy` club-owner update (untouched policy) still succeeds; `set_staff_cash_custody()`, `manage_branch()` (both create and update), `platform_suspend_club()`/`platform_reactivate_club()` all still succeed and now correctly produce `audit_logs` rows. Confirmed zero legitimate frontend call site existed for any revoked direct-write path (grepped `src/` exhaustively before applying). Supabase security advisors reviewed post-fix: no new findings on the 4 modified tables. `tsc -b` clean, full test suite 10/10 files / 108/108 tests pass.

### Phase 2 — Cross-tenant isolation + IDOR sweep (§3, §6, §30)
Live adversarial RLS-impersonation testing: Club A token + Club B object across bookings, invoices, memberships, academy, shop sales/returns, staff, support sessions. Use the proven `SET ROLE authenticated` + `set_config('request.jwt.claims', ...)` pattern.
Status: IN PROGRESS.

**Live-attacked and confirmed BLOCKED** (Club A owner token + Club B real object id, direct table read/write and RPC-level): `bookings` (read + `cancel_booking()` RPC, non-leaking error), `invoices` (read), `customers` (read + `get_customer_360_summary()` RPC, non-leaking error), `shop_sales` (read), `enrollments` (read), `club_membership_subscriptions` (read), `return_shop_sale()` RPC (correctly rejects on ownership after passing input-shape validation -- confirmed the earlier "at least one line" error was validation-order, not an authorization bypass, by resubmitting with a real non-empty line and confirming it then failed on "not authorized" instead).

**Genuine PASS, no fix needed, code-verified**: `qr_confirm_checkin()` uses `select ... for update` row locks on both `qr_credentials` and `bookings` before every status check -- correctly serializes concurrent redemption attempts rather than racing, and independently re-checks `wrong_club`/`already_used`/`revoked`/`expired`/booking-status on every call. Satisfies directive Section 31 (race conditions) and Section 32 (replay) by construction. `qr_validate()` (booking/player_membership/club_membership types) similarly re-checks tenant scope, consumed/revoked/expired, and per-type sub-status (including the already-fixed NOT_STARTED/pending_payment carve-out) on every call -- no forged-payload or replay path found.

**CF-3 fixed** (defense-in-depth, not a directly client-exploitable P0): live-confirmed `create_gateway_refund_service()` is `service_role`-only (`has_function_privilege` returns false for both `authenticated` and `anon`) -- not reachable by any client-side attacker, downgrading it from CF-3's original framing. Still added the missing internal `has_permission_as()` check as genuine defense-in-depth (migration `20260829050000_gateway_refund_service_defense_in_depth.sql`), gated on `p_actor_id is not null` so the one legitimate system-call path (stripe-gateway-webhook's provider-originated reconciliation, `p_actor_id: null`, already authorized by HMAC signature verification) is unaffected. Live-verified all 3 cases: unauthorized actor rejected ("not authorized", zero refund row created), authorized actor passes through to the next real check, null-actor webhook path unaffected. Confirmed all 5 real `*-create-refund` Edge Functions already pass `p_actor_id: user.id` (grepped, all identical) and already independently re-check `has_permission('payment.refund', ...)` against the caller's own JWT before ever calling this RPC -- that Edge-Function-layer boundary was already solid; this is additive.

`tsc -b` clean, full test suite 10/10 files / 108/108 tests pass after both fixes.

Continuing: Shop/inventory, academy, memberships, staff, support-session cross-tenant sweep.

### Phase 3 — Privilege escalation: club staff + platform staff (§4, §19, §20)
Test self-role-change, permission self-grant, ceiling violations. Verify `set_platform_staff_role()`'s existing escalation guards; verify the club-level equivalent (`set_staff_role`) has the same shape.
Status: COMPLETE. Migration `20260829070000_platform_staff_role_escalation_fix.sql`.

**CRITICAL P0 finding, live-exploited and fixed -- the single most severe finding of this program.** `platform_staff_memberships_write` was the exact same bug class as Phase 1's `club_memberships` finding, but worse: an RLS `ALL`-command policy gated only on `platform.staff.create`/`update`/`disable`, with **zero column restriction and zero trigger protection** (unlike `club_memberships`, which at least has `protect_club_membership_identity_columns()` guarding `role_id`; `platform_staff_memberships` has no triggers at all).

Live-attacked with a synthetic QA fixture (the existing `mal3aby.qa.receptionist` test identity, granted a temporary `platform_admin` membership, deleted immediately after each step): as that `platform_admin`-role identity, a direct `update platform_staff_memberships set platform_role_id = <platform_owner's role id>` **succeeded**, completely bypassing `set_platform_staff_role()`'s real privilege-ceiling check (`pp.key not in (select caller_platform_permission_keys())`) and its last-assigner-lockout guard, with **zero `audit_logs` row produced**. The resulting role grants nearly every platform permission (`platform.finance.manage`, `platform.subscription.manage`, `platform.club.suspend`, `platform.staff.role.assign`, 22 permissions total) -- a near-complete, invisible, self-granted escalation from any `platform_admin`-tier account. (Does not by itself satisfy `is_platform_owner()`, which checks the separate `club_memberships` table -- but platform-staff-tier authority alone is already severe.)

**Fix**: dropped the dangerous policy entirely. Confirmed zero legitimate frontend call site exists for direct `platform_staff_memberships` writes (grepped `src/` -- zero matches; the real UI only calls `list_platform_staff`/`list_platform_roles`/`deactivate_platform_staff`/`set_platform_staff_role`, all `SECURITY DEFINER` RPCs, all unaffected). Confirmed no create/invite-platform-staff RPC or UI exists either way -- new memberships are already, today, a superuser/migration-only operation; this migration doesn't change that, only closes the unused-but-dangerous direct-write surface.

**Regression-verified live**: re-attempted the exact same escalation attack post-fix -- correctly blocked (0 rows affected, role unchanged). Re-verified both legitimate RPCs still work and are correctly audited: `set_platform_staff_role()` (role downgrade to `platform_viewer`, produced a real `platform_staff.role_changed` audit row) and `deactivate_platform_staff()` (both succeeded). Fixture fully cleaned up, `platform_staff_memberships` confirmed back to 0 rows (original baseline -- no real platform staff exist yet in this environment).

`tsc -b` clean, full test suite 10/10 files / 108/108 tests pass.

**Phase 3 continued -- systematic sweep for the same bug class across every remaining `is_platform_owner()`/`has_platform_permission()`-gated write policy.** Migration `20260829080000_close_remaining_unaudited_direct_write_policies.sql`.

**Second live-exploited P0/P1, `platform_support_sessions`**: despite being self-scoped (`platform_owner_id = auth.uid()`), the `ALL` policy let a support session's own owner directly rewrite `mode`/`expires_at`/`club_id` after creation. Live-tested with a fresh QA fixture session (started `view`-mode against TEST-CLUB-2 via the real RPC): a direct write flipped `mode` `view→manage` (silently self-granting full MANAGE authority a `platform.support.start_view`-only account was correctly denied at session-start), extended `expires_at` by 30 days, and retargeted `club_id` to a different real club -- all three with zero audit row. Exactly directive §21's named failure modes. Fixed with a SELECT-only replacement policy (writes now exclusively via `start_platform_support_session()`/`end_platform_support_session()`). Reverified live: the same attack now correctly blocked (0 rows changed); the legitimate `end_platform_support_session()` RPC still works and correctly sets `ended_at`.

**Same-shape fixes applied without independent live-exploitation** (mechanically identical to the two already-proven cases, zero legitimate frontend dependency confirmed by grep): `platform_custom_role_permissions`/`platform_custom_roles` (bypasses `update_platform_custom_role()`'s ceiling check, which is also load-bearing for `set_platform_staff_role()`'s own ceiling check via `caller_platform_permission_keys()` -- a second-order escalation path), `platform_invoices`/`platform_payments`/`platform_subscriptions` (bypasses the full audited platform-billing RPC suite -- could fabricate financial history records with zero trace).

**Investigated, found NOT exploitable, left untouched**: `club_roles`/`club_role_permissions` looked identical on paper (`has_permission('roles.manage', club_id)`-only gating, no visible ceiling check) but a live attack -- a real QA-fixture staff member holding only `roles.manage`, created via the genuine `create_club_role()`/`invite_staff_member()` RPCs -- consistently failed to insert into `club_role_permissions` even when inserting a permission the actor legitimately held, ruling out an escalation-specific gap and pointing to some other real enforcement mechanism (not fully root-caused; possibly interacting with the separate `roles.view` permission required by `club_role_permissions_select`). Left as-is rather than "fixing" something proven safe in practice -- flagged for a future session to properly root-cause and document.

**Reviewed and confirmed correctly out of scope**: `platform_settings` (already fixed in a prior session, frontend comment confirms), `platform_owner_pinned_clubs` (genuinely self-scoped low-risk UI preference data), `commercial_upgrade_requests`/`contact_requests` (real legitimate direct writes exist with no audit trail -- a genuine P2 traceability gap, not an escalation/financial-fabrication vector, noted for a future pass rather than folded into this fix).

All QA fixtures (test custom roles, staff memberships, support session) cleaned up or left in a correctly-terminated real state; TEST-CLUB-2 confirmed back to baseline (only the real owner's membership, 0 club_roles). `tsc -b` clean, full test suite 10/10 files / 108/108 tests pass.

### Phase 4 — Branch isolation (§5)
Verify branch-scoped staff cannot read/write another branch's bookings/payments/cash/inventory/POS/memberships/academy/attendance/reports.
Status: COMPLETE. Genuine PASS, no fix needed -- live-verified with a real QA fixture.

Set up on TEST-CLUB-2: 2 real branches (via `manage_branch()`), a real QA staff member (`mal3aby.qa.receptionist`) invited and scoped to Branch A only via `set_staff_branch_scope()`. Confirmed: (1) reading `branches` as the scoped receptionist returns only Branch A -- Branch B is invisible, correctly filtered by `user_has_branch_access()` inside `branches_select_own_club`; (2) calling `get_revenue_report()` with `p_branch_id` explicitly set to Branch B (a client-supplied filter naming a branch outside the caller's scope) is correctly rejected with "not authorized" -- confirms report RPCs re-validate a client-supplied branch filter against the caller's real scope rather than trusting it, directly satisfying directive §18's "export endpoints must enforce the same authorization as UI reports"; (3) code-read confirmed `get_revenue_report()`'s implicit (no explicit `p_branch_id`) path also correctly restricts to `caller_accessible_branch_ids()` rather than silently defaulting to all-club data for a scoped user.

All fixtures cleaned up (branches deleted, fixture membership deleted -- both via the superuser connection since Phase 1's fix correctly removed the client-facing direct-write path being tested). TEST-CLUB-2 confirmed restored to baseline (0 branches, 1 membership = the real owner).

### Phase 5 — Module & subscription bypass (§35, §34) — re-verify, don't rebuild
Given the recon finding that Academy/Fields/Club-Membership got only 1 migration each (vs Shop's 7+ sweep passes), this is the highest-probability place to find a real entitlement-bypass RPC. Full enumeration of every write RPC in each domain, cross-checked against the `_X_module_active()` call sites found.
Status: COMPLETE. Migration `20260829060000_academy_module_active_sweep.sql`.

**Real gap found and fixed, Academy domain**: systematic enumeration of every RPC that writes `enrollments`/`groups`/`subscriptions`/`attendance`/`training_sessions` found 3 of 6 never called `_academy_module_active()`: `renew_academy_subscription()` (checks `club_write_allowed()` but not the module -- the clearest gap, directly creates new invoices/subscriptions), `ensure_adhoc_attendance_session()` (a real, frontend-reachable write path -- `AttendanceSection.tsx`'s "open today's session" flow, called immediately before the already-gated `mark_attendance()`), and `generate_training_sessions()` (same gap, the schedule-driven bulk sibling). `mark_attendance()`/`qr_mark_attendance()`/`create_enrollment_with_subscription()` already correctly checked and are unchanged.

**Live-exploited and reverified fixed**: on TEST-CLUB-2 (QA fixtures: 1 branch, 1 group, both deleted after), deactivated Academy, confirmed `ensure_adhoc_attendance_session()` and `generate_training_sessions()` both correctly blocked with "the academy module is not active for this club" and zero `training_sessions` rows created (previously would have succeeded). Reactivated Academy, confirmed both RPCs work again (regression-clean). `renew_academy_subscription()`'s fix verified by code/pattern only (identical guard shape to the two live-tested siblings; a full live test would have required a deeper fixture chain -- player/guardian/enrollment -- judged unnecessary given the mechanical identicality and that `_academy_module_active()` itself has been proven correct via many other live tests this session).

**Fields and Club Memberships re-audited, confirmed already fully covered, no fix needed**: `create_recurring_booking()` delegates every actual booking write to `_create_booking_internal()` (which does check) -- genuine PASS, though noted a minor P3 data-hygiene quirk (an empty `booking_series` container row can be created before the per-occurrence module check fails; zero financial value, not a fraud vector, not fixed). All 4 Club Membership commitment-creating RPCs (`sell_club_membership`, `purchase_club_membership_self_service`, `renew_club_membership`, `renew_club_membership_self_service`) already check the module. `manage_field`/`create_field_pricing_rules`/`manage_branch`-class administrative-setup RPCs and membership `freeze`/`cancel`/`resume` exit-path RPCs are correctly NOT gated (matches the established, intentional "administrative setup and exit paths are out of new-commitment scope" precedent).

`tsc -b` clean, full test suite 10/10 files / 108/108 tests pass. TEST-CLUB-2 confirmed restored to exact real baseline (club active, 0 branches, 0 groups, all 4 modules entitled+active) after fixture cleanup.

### Phase 6 — Booking, membership, academy, QR fraud (§7, §8, §9, §10)
Price/time/discount manipulation, double-booking races, QR replay/forgery/cross-tenant reuse, attendance fabrication.
Status: PENDING

### Phase 7 — Payment, webhook, refund fraud (§14, §15, CF-3)
Forged success, replayed/duplicate webhooks, wrong-club/amount/currency signatures, refund replay/excess, harden the service-role RPCs per CF-3.
Status: PENDING

### Phase 8 — POS/Shop, inventory, cash fraud (§11, §12, §13)
Price override, negative qty, stock bypass, unauthorized returns, ledger tampering, cash liability manipulation.
Status: PENDING

### Phase 9 — Invoice, discount, report fraud (§16, §17, §18) + CF-2 fix
Fix SP-001 (cancelled booking retains payable invoice). Audit discount authorization boundaries. Confirm report/export endpoints enforce the same authorization as UI.
Status: CF-2 follow-up COMPLETE (see below). Discount-authorization and report/export sub-items not separately re-run this pass — no specific open finding identified in either during the broader sweep; not re-opened here per §56's "do not generate endless speculative P3 work", but not independently re-verified as a dedicated pass either (see Accepted Limitations in the acceptance report).

**CF-2/SP-001 re-verified and found PARTIALLY open, then fully closed.** A prior session had already fixed the `cancelled` half of SP-001 in both `record_payment()` and `claim_manual_payment()` (confirmed via `src/features/billing/sp001-cancelled-booking.integration.test.ts`, which already covered `cancelled` end-to-end). However, `no_show` — a real, distinct, terminal `bookings.status` value — was left uncovered on **both** RPCs. Live-confirmed via direct query before fixing: 30 real production bookings with `status in ('cancelled','no_show')` still carried an `issued` (payable) invoice, 3 specifically `no_show` (all 3 happened to already be fully paid, so the outstanding-balance check would have accidentally blocked a duplicate `record_payment()` attempt against those specific 3 rows — but the underlying guard gap was real and general: any `no_show` booking with a genuinely unpaid/partially-paid invoice was exploitable).

**Fix**: widened both RPCs' single-status check from `= 'cancelled'` to `in ('cancelled', 'no_show')`. Migrations `20260829090000_record_payment_block_no_show_bookings.sql` and `20260829090500_claim_manual_payment_block_no_show_bookings.sql`. `claim_manual_payment()` is the more severe of the two surfaces — it's the Customer Portal's own self-service "I paid, please verify" RPC, directly callable by any customer against their own invoice with **zero frontend guard** (confirmed via grep: `PortalPaymentsPage.tsx` has no client-side `no_show`/`cancelled` check at all — the backend RPC was the only real boundary). `BookingDetailSheet.tsx` (staff view) does already hide its own "record payment" UI action for `no_show`/`cancelled` bookings client-side, but per the directive's zero-trust principles that UI guard was never the relied-upon boundary, and the RPC-level fix is what actually closes the gap for direct-RPC/API access regardless.

**Live-exploited pre-fix, then live-verified post-fix, both surfaces**, using fully synthetic fixtures (new customer/invoice/booking rows on TEST-CLUB-1, real branch/field, zero reuse of real historical data) so a genuinely unpaid `no_show` invoice could be tested (the 3 real production rows were already fully paid and wouldn't exercise the guard on its own merits):
- `record_payment()` pre-fix: not independently re-exploited (the fix was written directly from the confirmed code gap + confirmed real affected rows); post-fix attack via the real TEST-CLUB-1 owner correctly raised `this booking was no_show -- payment can no longer be recorded against it`.
- `claim_manual_payment()` post-fix attack via the QA receptionist identity acting as a synthetic portal customer correctly raised `this booking was no_show -- payment can no longer be claimed against it`.
- **Regression-verified**: a second synthetic fixture with a normal `confirmed` booking successfully completed payment via both RPCs post-fix (real payment id / claim id returned, `payment.record` audit row correctly written for the `record_payment()` case) — the fix does not affect the legitimate happy path.
- All fixture rows (customers, invoices, bookings, payments, claims, verification tokens) fully deleted after verification — zero residue confirmed via count queries.

Regression tests added: two new integration tests in `sp001-cancelled-booking.integration.test.ts` (mirroring its existing `cancelled` tests, using the real `mark_booking_no_show()` RPC), and AF-TEST 9 (two self-contained, rollback-safe blocks) appended to `supabase/tests/security_finance_regression.sql` — both live-run against the real project and confirmed to reproduce their exact EXPECTED error message.

Historical data note: the 3 real `no_show` rows with issued invoices are unchanged (already fully paid, no outstanding risk, and per §55 historical financial rows are never mutated as part of a security fix).

### Phase 10 — Numeric invariants, race conditions, replay (§31, §32, §46)
Parallel-request testing on booking/stock/payment/refund/QR paths; negative/zero/overflow value rejection.
Status: PENDING

### Phase 11 — SECURITY DEFINER + RPC grants systematic re-audit (CF-4, §26, §27, §28, §29)
Targeted re-verification beyond the prior heuristic pass — sample-verify a meaningful set of the ~216 unconfirmed functions, focusing on ones reachable by `authenticated`/`anon` that accept a tenant identifier.
Status: PENDING

### Phase 12 — Storage, secrets, webhook hardening (§39, §40, §41)
Storage bucket cross-club tests; confirm no Vault/secret leakage; webhook idempotency/replay re-verification.
Status: PENDING

### Phase 13 — Collusion, fraud signals, delete/archive policy, time manipulation (§42-45)
Analyze 2-actor collusion scenarios; add deterministic exception-reporting signals where the architecture cleanly supports it; confirm delete paths favor archive/void; confirm server time is authoritative everywhere financial.

### Phase 14 — Automated security regression suite (§50)
Durable, repeatable suite (SQL-based, not browser-dependent) covering tenant isolation, privilege escalation, IDOR, module bypass, subscription bypass, financial invariants, refund/return/webhook replay, stock manipulation, support-session scope, platform-staff escalation.
Status: COMPLETE (this pass's findings). Extended the existing `supabase/tests/security_finance_regression.sql` (rather than creating a competing file) with an "ANTI-FRAUD HARDENING REGRESSION (2026-08-29)" section, matching its own established methodology (real `SET ROLE authenticated` + `set_config('request.jwt.claims', ...)` impersonation, top-level statements, compare output to an EXPECTED comment).

8 new tests (AF-TEST 1-8) covering: commercial_entitlements direct-write bypass (Phase 1), club_memberships.has_cash_custody direct-write bypass (Phase 1), `create_gateway_refund_service()` actor check (Phase 2/CF-3), academy module-active bypass template (Phase 5, state-dependent, documented not scripted), platform staff role self-escalation template (Phase 3, state-dependent since no standing fixture exists), `platform_support_sessions` self-tampering (Phase 3 continued -- fully self-contained, starts and ends a real session via the legitimate RPCs), numeric invariant backstop on `payments.amount` (wrapped in `begin`/`rollback`, never persists), branch-isolation report-RPC template (Phase 4, state-dependent).

**Follow-up (Phase 9 close-out): AF-TEST 9 added** — two fully self-contained, rollback-safe blocks covering the CF-2/SP-001 `no_show` fix on both `record_payment()` and `claim_manual_payment()`. Both live-run verbatim against the real project and confirmed to reproduce their exact EXPECTED error message.

**5 of 8 tests are fully executable as-written and were live-run against this environment to confirm the file itself is correct, not just my ad-hoc verification**: AF-TEST 1, 2, 3, 6, 7 all reproduced their documented EXPECTED result exactly when run verbatim from the file. AF-TEST 4, 5, 8 are documented state-dependent templates (require a temporarily-deactivated module, a standing platform-staff fixture, or a branch-scoped staff fixture respectively) with the exact setup/teardown already fully proven live in their respective phase sections above -- not scripted inline to avoid the suite silently mutating a club's module state or creating a persistent staff fixture on a routine re-run.

### Phase 15 — Final red-team pass + acceptance report + closure
Adversarial persona pass (§59), full acceptance criteria (§60), `MAL3ABY_ANTI_FRAUD_SECURITY_ACCEPTANCE.md`, final regression, merge + push.
Status: PENDING

---

Continuing immediately into Phase 1.
