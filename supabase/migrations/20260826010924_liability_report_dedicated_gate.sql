-- CASH LIABILITY PERMISSIONS -- FINAL CLOSURE fix #1.
--
-- get_employee_liability_report() was gated on report.view alone --
-- since this RPC is 100% dedicated to liability data (confirmed: its
-- only caller in the frontend is ReportEmployeeLiabilityPage.tsx, and
-- its entire body is a single liability query, never shared with any
-- other report), this let any report.view holder see liability data
-- regardless of cash.liability.view -- e.g. academy_manager, who the
-- mandated matrix requires DENY.
--
-- Fix: require BOTH report.view (this is still a report, reached from
-- the Reports/Finance nav domain like every other report) AND
-- cash.liability.view (the liability-specific gate). Because this RPC
-- has no other caller, tightening its own gate directly is the correct
-- minimal-blast-radius fix -- no need to split into a second RPC, since
-- there is nothing else sharing this function to protect from a wider
-- change. Same signature/return type -- safe in-place CREATE OR
-- REPLACE, no new overload, grants unaffected.
--
-- Verified live before this change: club_owner/accountant/club_manager/
-- branch_manager already hold both report.view AND cash.liability.view
-- (no role-grant changes needed) -- academy_manager holds report.view
-- but not cash.liability.view (will now correctly DENY) --
-- coach/receptionist/scanner hold neither (already DENY, unchanged).
create or replace function public.get_employee_liability_report(p_club_id uuid, p_start_date date, p_end_date date)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (
    p_club_id in (select public.user_club_ids())
    and public.has_permission('report.view', p_club_id)
    and public.has_permission('cash.liability.view', p_club_id)
  ) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  select jsonb_agg(jsonb_build_object(
    'liability_id', l.id,
    'employee_id', l.employee_id,
    'employee_name', coalesce(pr.full_name, '—'),
    'kind', l.kind,
    'original_amount', l.original_amount,
    'outstanding', l.outstanding,
    'status', l.status,
    'cash_shift_id', l.cash_shift_id,
    'created_at', l.created_at
  ) order by l.created_at desc) into v_result
  from public.employee_cash_liabilities l
  left join public.profiles pr on pr.user_id = l.employee_id
  where l.club_id = p_club_id
    and l.created_at::date between p_start_date and p_end_date;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;
