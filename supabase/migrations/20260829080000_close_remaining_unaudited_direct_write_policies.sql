-- ZERO-TRUST ANTI-FRAUD HARDENING -- Phase 3 continued (2026-08-29)
--
-- Following the Phase 1 (club_memberships/clubs/branches/
-- commercial_entitlements) and Phase 3 (platform_staff_memberships)
-- findings, a systematic sweep of every RLS ALL/INSERT/UPDATE/DELETE
-- policy gated on is_platform_owner()/has_platform_permission() found
-- the same bug class recurring across several more tables -- an
-- unaudited direct-write RLS policy coexisting with a fully-built,
-- properly-guarded, audited RPC that the real frontend already
-- exclusively uses. Confirmed via grep: zero legitimate frontend
-- call site exists for a direct write to ANY of the tables below.
--
-- Highest-severity of this batch, LIVE-EXPLOITED this pass:
-- platform_support_sessions_owner_all -- despite being self-scoped
-- (platform_owner_id = auth.uid()), this let a support session's
-- OWNER directly rewrite their own session's mode/expires_at/club_id
-- after creation, bypassing every safeguard start_platform_support_session()
-- has. Live-tested with a real fresh QA fixture session (started as
-- 'view' mode against TEST-CLUB-2 via the real RPC, deleted immediately
-- after):
--   - mode: 'view' -> 'manage' succeeded directly -- a support agent who
--     only holds platform.support.start_view (and was correctly denied
--     platform.support.start_manage at session-start time) can silently
--     grant themselves full MANAGE authority after the fact.
--   - expires_at: extended by 30 days directly -- defeats the entire
--     time-boxed design of the support-session feature.
--   - club_id: retargeted to a DIFFERENT real club directly -- a
--     session legitimately approved to view Club A can be silently
--     redirected to Club B, which was never approved.
-- All three with ZERO audit_logs row. This is exactly the "session used
-- against wrong club... session remains usable after permission
-- revocation... support access not audited" failure mode the anti-fraud
-- directive's Section 21 names explicitly.
--
-- Also closed in this batch (same shape, same "RPC exists, is properly
-- guarded and audited, zero frontend dependency on the raw table"
-- evidence, not independently live-exploited given the lower/no real
-- data at risk and the mechanical identicality to the two already
-- live-proven cases above and in the prior migration):
--   - platform_custom_role_permissions / platform_custom_roles:
--     update_platform_custom_role() already has the correct ceiling
--     check (cannot grant a permission you don't hold) -- a direct
--     write bypasses it, letting a platform_admin-tier account edit a
--     custom role's permission set arbitrarily, which would then also
--     widen caller_platform_permission_keys() for anyone holding that
--     role (used by set_platform_staff_role()'s own ceiling check --
--     a second-order escalation path).
--   - platform_invoices / platform_payments / platform_subscriptions:
--     fully covered by create_platform_subscription/
--     record_platform_payment/renew_platform_subscription/
--     change_platform_plan/reverse_platform_payment/
--     cancel_platform_subscription/complete_new_club_onboarding, all
--     audited. A direct write here could fabricate a platform invoice/
--     payment/subscription history entry with no trace -- billing/
--     financial record integrity, directive Section 17 territory.
--
-- INVESTIGATED, NOT TOUCHED: club_roles / club_role_permissions have
-- the exact same-looking gap on paper (club_roles_insert/
-- club_role_permissions_insert are gated only on has_permission(
-- 'roles.manage', club_id), with no visible permission_set_escalates()
-- equivalent in the policy text) -- but a live attack (QA fixture: the
-- mal3aby.qa.receptionist identity granted a real custom role holding
-- ONLY roles.manage, via the real create_club_role()/invite_staff_member()
-- RPCs) found this is NOT practically exploitable: a direct INSERT into
-- club_role_permissions consistently failed RLS ("new row violates row-
-- level security policy"), even when inserting a permission the actor
-- DID hold (roles.manage itself), which rules out an escalation-specific
-- block and points to some other enforcement mechanism genuinely working
-- (not fully root-caused -- possibly related to club_role_permissions_select
-- requiring the separate roles.view permission, which this fixture actor
-- did not hold, interacting with how PostgREST/Postgres reports a
-- WITH CHECK failure). Given the real, repeated, consistent live-test
-- result was "blocked", this pair of tables is left untouched by this
-- migration -- fixing something already empirically safe risks breaking
-- it. Flagged for a future session to properly root-cause and document
-- the actual mechanism, not to weaken it.
--
-- NOT touched by this migration (reviewed and confirmed genuinely
-- lower-risk, correctly scoped, or already the intended write path):
--   - platform_settings: already fixed in a prior session (frontend
--     comment confirms -- "used to be a bare table .update(), now
--     routed through update_platform_settings()"); the direct-write
--     policy is now unused, but its own severity is lower (a single
--     global settings row, not per-tenant financial/access data) --
--     left as-is this pass, not a regression, can be swept in a future
--     hygiene-only pass if desired.
--   - platform_owner_pinned_clubs: genuinely self-scoped low-risk UI
--     preference data (which clubs a platform owner pinned to their own
--     dashboard) -- even a direct write only affects the writer's own
--     pins, no privilege/financial impact.
--   - commercial_upgrade_requests: a real, legitimate direct write
--     exists (PlatformClubDetailPage.tsx's approve/dismiss action) with
--     no audit trail -- noted as a real P2 traceability gap (approving/
--     dismissing a request is not itself a limit change, which remains
--     separately audited via set_commercial_entitlements()) and left
--     for a follow-up phase rather than folded into this migration,
--     which is scoped to the confirmed escalation/financial-fabrication
--     class of bug.
--   - contact_requests: the anon INSERT is the intended public contact
--     form; the platform-owner UPDATE (status resolution) has no
--     escalation/financial shape -- same low-severity traceability
--     profile as commercial_upgrade_requests, not touched this pass.

-- platform_support_sessions has no separate SELECT policy (the ALL
-- policy being dropped was its only access path) -- replace with a
-- SELECT-only equivalent, self-scoped exactly like the original (a
-- platform owner/support staff can read their own session rows; writes
-- now exclusively via start_platform_support_session()/
-- end_platform_support_session()).
drop policy if exists platform_support_sessions_owner_all on public.platform_support_sessions;
create policy platform_support_sessions_owner_select on public.platform_support_sessions
  for select
  using (
    platform_owner_id = auth.uid()
    and (public.is_platform_owner() or public.has_platform_permission('platform.support.start_view') or public.has_platform_permission('platform.support.start_manage'))
  );

drop policy if exists platform_custom_role_permissions_write on public.platform_custom_role_permissions;
drop policy if exists platform_custom_roles_write on public.platform_custom_roles;

drop policy if exists platform_invoices_platform_owner_full_access on public.platform_invoices;
create policy platform_invoices_platform_owner_select on public.platform_invoices
  for select
  using (public.is_platform_owner());

drop policy if exists platform_payments_platform_owner_full_access on public.platform_payments;
create policy platform_payments_platform_owner_select on public.platform_payments
  for select
  using (public.is_platform_owner());

drop policy if exists platform_subscriptions_platform_owner_full_access on public.platform_subscriptions;
create policy platform_subscriptions_platform_owner_select on public.platform_subscriptions
  for select
  using (public.is_platform_owner());
