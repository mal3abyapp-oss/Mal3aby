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
| CF-2 | MAL3ABY_SECOND_PASS_AUDIT.md (SP-001) | Cancelled/no-show bookings retain a payable invoice; `record_payment()` doesn't check linked booking status; Portal still offers "Pay invoice". 43 real affected rows in production. | **P1** — directive §17 invoice fraud / §7 booking fraud overlap. Fix. |
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
Status: PENDING

### Phase 4 — Branch isolation (§5)
Verify branch-scoped staff cannot read/write another branch's bookings/payments/cash/inventory/POS/memberships/academy/attendance/reports.
Status: PENDING

### Phase 5 — Module & subscription bypass (§35, §34) — re-verify, don't rebuild
Given the recon finding that Academy/Fields/Club-Membership got only 1 migration each (vs Shop's 7+ sweep passes), this is the highest-probability place to find a real entitlement-bypass RPC. Full enumeration of every write RPC in each domain, cross-checked against the `_X_module_active()` call sites found.
Status: PENDING

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
Status: PENDING

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
Status: PENDING

### Phase 15 — Final red-team pass + acceptance report + closure
Adversarial persona pass (§59), full acceptance criteria (§60), `MAL3ABY_ANTI_FRAUD_SECURITY_ACCEPTANCE.md`, final regression, merge + push.
Status: PENDING

---

Continuing immediately into Phase 1.
