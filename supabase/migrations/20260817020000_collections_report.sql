-- Gate 13 task #58: employee/branch collections report.
--
-- Builds on #57 (employee financial attribution audit), which confirmed
-- payments.received_by is always correctly, non-spoofably populated.
-- This is the report-layer deliverable that actually surfaces it in
-- aggregate: "how much did each staff member collect, and how much did
-- each branch collect" over a date range -- the natural next question
-- once attribution is trustworthy. Follows the exact convention of
-- get_revenue_report() (same auth/permission checks, same date-range
-- and optional branch filter, same jsonb_build_object shape).
create or replace function public.get_collections_report(
  p_club_id uuid,
  p_start_date date,
  p_end_date date,
  p_branch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  select jsonb_build_object(
    'total_collected', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at::date between p_start_date and p_end_date
        and (p_branch_id is null or p.branch_id = p_branch_id)
    ), 0),
    'by_employee', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', e.user_id,
        'full_name', e.full_name,
        'amount', e.amount,
        'payment_count', e.payment_count
      ) order by e.amount desc)
      from (
        select p.received_by as user_id, coalesce(pr.full_name, '—') as full_name,
               sum(p.amount) as amount, count(*) as payment_count
        from public.payments p
        left join public.profiles pr on pr.user_id = p.received_by
        where p.club_id = p_club_id and p.status = 'completed'
          and p.received_at::date between p_start_date and p_end_date
          and (p_branch_id is null or p.branch_id = p_branch_id)
        group by p.received_by, pr.full_name
      ) e
    ), '[]'::jsonb),
    'by_branch', coalesce((
      select jsonb_agg(jsonb_build_object(
        'branch_id', b.branch_id,
        'branch_name', b.branch_name,
        'amount', b.amount,
        'payment_count', b.payment_count
      ) order by b.amount desc)
      from (
        select p.branch_id, br.name as branch_name,
               sum(p.amount) as amount, count(*) as payment_count
        from public.payments p
        join public.branches br on br.id = p.branch_id
        where p.club_id = p_club_id and p.status = 'completed'
          and p.received_at::date between p_start_date and p_end_date
          and (p_branch_id is null or p.branch_id = p_branch_id)
        group by p.branch_id, br.name
      ) b
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_collections_report(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_collections_report(uuid, date, date, uuid) to authenticated;

comment on function public.get_collections_report(uuid, date, date, uuid) is
  'Gate 13 #58: total collections broken down by collecting employee and by branch, for a date range. Same report.view permission gate as the other reports/* RPCs.';
