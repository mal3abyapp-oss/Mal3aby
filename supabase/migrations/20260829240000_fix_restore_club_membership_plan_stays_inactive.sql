-- SAAS ACCEPTANCE REVIEW -- Club Owner journey audit finding D5
-- (2026-08-29), P1: restore_club_membership_plan() cleared
-- archived_at but never set is_active back to true -- its sibling
-- archive_club_membership_plan() sets BOTH archived_at = now() AND
-- is_active = false together, but restore only reversed the first
-- one. A restored plan therefore stayed permanently unsellable
-- (is_active = false forever), with no error and no indication
-- anything was wrong -- the owner sees the plan reappear in the
-- non-archived list but it silently can never be sold again.
--
-- Fix: symmetrically set is_active = true on restore, matching
-- archive's own convention exactly.
create or replace function public.restore_club_membership_plan(p_plan_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_plan record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_plan from public.club_membership_plans where id = p_plan_id for update;

  if v_plan.id is null then
    raise exception 'plan not found';
  end if;

  if not (v_plan.club_id in (select public.user_club_ids()) and public.has_permission('club_membership.plan.manage', v_plan.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_plan.archived_at is null then
    raise exception 'plan is not archived';
  end if;

  update public.club_membership_plans
  set archived_at = null, is_active = true, updated_at = now()
  where id = p_plan_id;

  perform public.write_audit_log(
    v_plan.club_id, 'club_membership_plan.restored', 'club_membership_plan', p_plan_id, null, null, null
  );
end;
$function$;
