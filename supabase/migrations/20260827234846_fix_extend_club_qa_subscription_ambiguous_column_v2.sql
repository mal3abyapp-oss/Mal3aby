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
-- This migration adds a small, reusable, platform_owner-gated
-- maintenance RPC (extend_club_qa_subscription) so this class of
-- fixture drift (a QA club's trial silently expiring between sessions)
-- can be fixed going forward without another hand-authored migration --
-- genuinely useful past this one-time repair, not a one-off script.
--
-- Deliberately NOT touching clubs.status via a raw UPDATE with no audit
-- trail -- this RPC writes a real audit_logs row (write_audit_log),
-- same discipline as every other admin-shaped mutation in this schema.
-- Deliberately NOT creating a new club/fixture set -- directive
-- instruction is "reuse/extend the existing QA-labeled clubs... rather
-- than inventing a parallel fixture system."
--
-- NOTE (orchestrator, applied 2026-08-28): the subagent's original
-- version of this function referenced a bare `club_id` column inside
-- its own body, which is ambiguous against its own `returns table
-- (club_id uuid, ...)` output column -- the exact "ambiguous column"
-- bug class this project has hit and fixed before (e.g.
-- get_gateway_transaction_status earlier this session). Fixed here by
-- table-qualifying every reference to platform_subscriptions.club_id
-- before this migration was ever applied -- this file reflects the
-- CORRECTED version that is actually live, not the subagent's original
-- (which was never applied -- Postgres DDL is transactional, so the
-- failed first attempt left no partial state).
--
-- The one-time repair of "QA Full Test Club" itself was applied
-- separately via execute_sql (using the same set_config +
-- `set local role authenticated` RLS-impersonation pattern established
-- throughout this whole session) rather than a `do $$ ... $$` block
-- inside this migration, since `is_platform_owner()`'s own auth.uid()
-- resolution requires the ACTUAL Postgres role to be `authenticated`,
-- not merely a JWT claim set under the migration-runner's own role --
-- confirmed live: club 6ca5315e-e199-4531-9fb1-1df358cda087 is now
-- status='active', platform_subscriptions.lifecycle_status='active',
-- end_at='2027-08-27 23:49:00+00', grace_period_days_snapshot=7.
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

  select c.status into v_club_status_before from public.clubs c where c.id = p_club_id;
  if v_club_status_before is null then
    raise exception 'club not found: %', p_club_id;
  end if;

  v_before := jsonb_build_object('club_status', v_club_status_before);

  update public.clubs
    set status = 'active'
    where id = p_club_id and status != 'active';

  v_new_end_at := now() + (p_days || ' days')::interval;

  select ps.id into v_sub_id
    from public.platform_subscriptions ps
    where ps.club_id = p_club_id and ps.lifecycle_status != 'cancelled'
    order by ps.start_at desc
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
