# Platform Owner Module Activation Authority — Corrective Phase

**Date:** 2026-08-29.
**Scope:** finite, corrective. Not a re-audit of the prior Platform Owner Autonomous Completion program (`PLATFORM_OWNER_AUTONOMOUS_COMPLETION_PLAN.md`, `PLATFORM_OWNER_CONTROL_PRODUCTION_ACCEPTANCE.md`) — those remain closed and unmodified.

## Problem

Platform Owner could toggle **module entitlement** (`club_modules.entitled`) directly from Club 360, but had no direct path to toggle **module operational activation** (`club_modules.active`) — that RPC (`set_club_module_active`) only authorized the Club Owner (`has_permission('club.update', ...)`) or an active MANAGE support session. Restoring a module Platform Owner had just re-entitled to a fully working state required a Club Owner login or a support session, contradicting the accepted authority model (Platform Owner: entitlement + activation; Club Owner: staff/role permissions within what's allowed).

## Fix

**Backend** (`supabase/migrations/20260829030000_platform_owner_module_activation_authority.sql`):
- `set_club_module_active(p_club_id, p_module_key, p_active, p_reason default null)` now also authorizes `is_platform_owner()` / `has_platform_permission('platform.club.manage')` — the same permission set already used by `set_club_module_entitlement`. The Club Owner / support-session path is unchanged.
- Added an optional `p_reason` parameter (default `null`), matching the existing high-impact-action reason pattern (`set_club_payments_enabled`, `set_club_gateway_provider_policy`).
- The old 3-arg overload was explicitly dropped (Postgres treats a new parameter list as a distinct function, not a true in-place replace) to avoid leaving dead, narrower-authorized surface behind.
- No RLS weakening: still `SECURITY DEFINER` with an explicit fail-closed authorization check, still `set search_path to 'public', 'pg_temp'`, still tenant-scoped, still routes through `write_audit_log()`.
- Fail-closed entitlement rule verified unchanged: `_academy_module_active()`/`_fields_module_active()`/`_shop_module_active()`/`_club_membership_module_active()` all compute `bool_and(entitled) and bool_and(active)` — an `entitled=false, active=true` row (however it arose) still evaluates to unusable.

**Frontend** (`src/features/platform/PlatformClubDetailPage.tsx`'s `ModulesPanel`):
- Each module row now shows three independent facts: **Entitlement** badge (متاحة/غير متاحة), **Operational State** badge (مفعّلة/غير مفعّلة), and a computed **Effective State** badge (`active` / `inactive` / `not_entitled` / `blocked_by_subscription`) — the last one derived client-side from `entitled`, `active`, and the club's already-loaded subscription `access` value (`get_club_platform_access`), not a new persisted column.
- New **Activate**/**Deactivate** buttons alongside the existing **Make Available**/**Remove Availability** buttons, shown only when the module is entitled (matching §5's "not entitled" rule — no button offered for an action that would be immediately rejected server-side).
- Deactivation requires a confirmation dialog with the exact non-destructive wording the directive specifies ("إيقاف الوحدة سيمنع العمليات الجديدة داخلها، مع الاحتفاظ بجميع البيانات والسجلات السابقة"); activation is non-destructive and applies immediately.
- i18n: new AR/EN keys for all of the above; `modulesNotActivated`'s existing copy ("لم يفعّلها النادي بعد" / "Not activated by club yet") was corrected to a neutral "غير مفعّلة" / "Not activated" since Platform Owner can now also be the one who hasn't activated it yet.

## Verification (real, live, TEST-CLUB-2)

- `tsc -b`, `eslint .` (0 errors, same 13 pre-existing unrelated warnings), production `build`, and the full unit/integration suite (10/10 files, 108/108 non-skipped tests) all pass.
- RPC-level: Platform Owner deactivate/reactivate confirmed via RLS-impersonated SQL; Club Owner path reconfirmed unchanged; a club owner from a **different** club correctly rejected (`not authorized`) — cross-tenant isolation holds for the new authority.
- Full A–F test matrix (directive §10) executed live through the real authenticated UI for all four modules (Academy, Fields, Club Memberships, Shop): entitled+active baseline → Platform-Owner deactivate (confirmed via `_X_module_active()=false`) → Platform-Owner activate (confirmed `=true`) → remove entitlement (confirmed `entitled=false, active=false`, matching existing behavior) → make available (`entitled=true, active=false` — the exact "trap" state the directive says must not persist) → activate from the UI (`entitled=true, active=true`). **Zero SQL used for any restoration step; zero Club Owner session used.**
- QA club restored to its exact original state at the end: `academy`/`club_membership`/`fields` all `entitled=true, active=true`, `shop` at its pre-existing `entitled=false, active=false`.
- Audit Log inspected live: every `module.activated`/`module.deactivated`/`module.entitled`/`module.unentitled` action from this session renders as a readable Arabic label with the correct reason text (default localized reason when none was typed, or the real custom reason otherwise) — label mapping was already in place from the prior program's Phase B, unchanged here.
- Responsive: 375 / 768 / 1440 all confirmed zero horizontal overflow; screenshots at 375 and 768 show all three badges and both action buttons fully legible and correctly wrapped.
- Staff/role permission boundary (§7): confirmed architecturally, not just empirically — `set_club_module_active`/`set_club_module_entitlement` only ever write to `club_modules`; neither has ever touched `club_memberships`/`roles`/`role_permissions`, so no code path exists by which this change could alter a staff permission assignment.
- Cross-club isolation reconfirmed: TEST-CLUB-1's modules and TEST-CLUB-2's post-restoration baseline both checked via SQL, completely unaffected by each other.

## Repository

Branch `platform-owner-module-activation-authority`, to be merged to `main` with `--no-ff` and pushed once this document is committed.
