-- Phase 4 (Staging + Automated E2E) preparation.
--
-- FINDING (confirmed live, not assumed, via get_club_platform_access()
-- called with a real club-owner caller context): "QA Full Test Club"
-- (id 6ca5315e-e199-4531-9fb1-1df358cda087) -- the ONLY club in this
-- project holding the complete 9-role QA fixture matrix (platform_owner,
-- club_owner, club_manager, branch_manager, receptionist, accountant,
-- academy_manager, coach, scanner, all real auth.users with confirmed
-- emails) -- was structurally unusable for any authenticated E2E test:
--   1. clubs.status = 'suspended' (blocks get_club_platform_access()
--      unconditionally, before subscription state is even checked).
--   2. Its platform_subscriptions row was lifecycle_status = 'trial',
--      end_at = 2026-08-23 (a week in the past relative to today,
--      2026-08-28), grace_period_days_snapshot = 0 -- so even with (1)
--      fixed, get_club_platform_access() would still correctly return
--      'blocked', not a bug in that function, just an expired fixture.
--
-- This migration does two things:
--   A. Adds a small, reusable, platform_owner-gated maintenance RPC
--      (extend_club_qa_subscription) so this class of fixture drift
--      (a QA club's trial silently expiring between sessions) can be
--      fixed going forward without another hand-authored migration --
--      genuinely useful past this one-time repair, not a one-off script.
--   B. Uses it once, here, to bring "QA Full Test Club" back to a
--      healthy, non-expiring-soon state for this phase's E2E suite and
--      any future QA/regression work that needs a real, full-role-matrix
--      authenticated fixture.
--
-- Deliberately NOT touching clubs.status via a raw UPDATE with no audit
-- trail -- the new RPC writes a real audit_logs row (write_audit_log),
-- same discipline as every other admin-shaped mutation in this schema.
-- Deliberately NOT creating a new club/fixture set -- directive
-- instruction is "reuse/extend the existing QA-labeled clubs... rather
-- than inventing a parallel fixture system."

create or replace function public.extend_club_qa_subscription(
  p_club_id uuid,
  p_days integer default 365,
  p_reason text default 'QA fixture maintenance'
)
returns table (
  club_id uuid,
  new_status text,
  new_lifecycle_status text,
  new_end_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_club_status_before text;
  v_sub_id uuid;
  v_new_end_at timestamptz;
begin
  if not public.is_platform_owner() then
    raise exception 'permission denied: platform owner only';
  end if;

  if p_days is null or p_days <= 0 or p_days > 3650 then
    raise exception 'p_days must be between 1 and 3650';
  end if;

  select status into v_club_status_before from public.clubs where id = p_club_id;
  if v_club_status_before is null then
    raise exception 'club not found: %', p_club_id;
  end if;

  v_before := jsonb_build_object('club_status', v_club_status_before);

  -- Un-suspend the club account itself if needed (status gate is
  -- checked first inside get_club_platform_access(), independent of
  -- subscription state).
  update public.clubs
    set status = 'active'
    where id = p_club_id and status != 'active';

  v_new_end_at := now() + (p_days || ' days')::interval;

  -- Reuse the most recent non-cancelled subscription row (extend it in
  -- place, matching this table's existing "one evolving row per
  -- lifecycle, not endless duplicate rows" convention seen in Phase 3b).
  -- Deliberately does NOT synthesize a brand-new row when none exists:
  -- platform_subscriptions requires a real subscription_kind/
  -- price_snapshot/plan pairing (see its NOT NULL + check constraints)
  -- that this fixture-maintenance helper has no business inventing --
  -- every real club (QA fixture or otherwise) already gets its first
  -- subscription row from the real onboarding/trial-grant path
  -- (get_club_platform_access / ADR-039), so "extend the existing row"
  -- is the only case this helper needs to cover.
  select id into v_sub_id
    from public.platform_subscriptions
    where club_id = p_club_id and lifecycle_status != 'cancelled'
    order by start_at desc
    limit 1;

  if v_sub_id is null then
    raise exception 'club % has no existing non-cancelled platform_subscriptions row to extend -- this helper only extends an existing subscription, it does not create one from scratch', p_club_id;
  end if;

  update public.platform_subscriptions
    set lifecycle_status = 'active',
        subscription_kind = case when subscription_kind = 'trial' then 'complimentary' else subscription_kind end,
        end_at = v_new_end_at,
        grace_period_days_snapshot = greatest(coalesce(grace_period_days_snapshot, 0), 7)
    where id = v_sub_id;

  perform public.write_audit_log(
    p_club_id,
    'platform.qa_subscription_extended',
    'platform_subscriptions',
    v_sub_id,
    v_before,
    jsonb_build_object('club_status', 'active', 'lifecycle_status', 'active', 'end_at', v_new_end_at),
    p_reason
  );

  return query select p_club_id, 'active'::text, 'active'::text, v_new_end_at;
end;
$$;

revoke execute on function public.extend_club_qa_subscription(uuid, integer, text) from public;
revoke execute on function public.extend_club_qa_subscription(uuid, integer, text) from anon;
grant execute on function public.extend_club_qa_subscription(uuid, integer, text) to authenticated;

comment on function public.extend_club_qa_subscription(uuid, integer, text) is
  'Platform-owner-only maintenance RPC: un-suspends a club and extends its existing platform_subscriptions row to a healthy active window (a trial-kind row is converted to complimentary, since a QA fixture being kept alive is not a real paid conversion). Built for Phase 4 (Staging + E2E) to repair QA fixture clubs whose trial/subscription state has expired between sessions, without a raw unaudited UPDATE. Requires a pre-existing non-cancelled subscription row -- does not synthesize plan/price data for a brand-new one. Not for general commercial use (real customer subscription changes belong to the actual billing/lifecycle RPCs, not this fixture-maintenance helper).';

-- B. One-time application: repair "QA Full Test Club" (the full 9-role
-- fixture matrix club), called as the real platform_owner-role QA
-- fixture account (mal3aby.qa.platform-owner.20260821@example.com,
-- id 556b515d-fdf9-421a-8e33-563737adb919 -- confirmed via
-- club_memberships.role_id -> roles.key = 'platform_owner' earlier in
-- this session's live investigation), 365 days so it does not silently
-- expire again mid-engagement.
do $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '556b515d-fdf9-421a-8e33-563737adb919', 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.extend_club_qa_subscription(
    '6ca5315e-e199-4531-9fb1-1df358cda087'::uuid,
    365,
    'Phase 4 (Staging + Automated E2E): repair expired QA fixture club (suspended status + expired 0-grace-period trial found blocking get_club_platform_access() for the full 9-role QA fixture matrix)'
  );
end $$;
