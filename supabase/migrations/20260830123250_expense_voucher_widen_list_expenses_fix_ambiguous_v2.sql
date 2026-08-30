-- PRINTING PRODUCTION ACCEPTANCE (2026-08-30), Section 9: Expenses had
-- zero print surface -- confirmed via grep, list_expenses() also never
-- exposed recorder name, voider name/date, or the linked cash shift,
-- all of which the directive requires "where applicable" on an Expense
-- Voucher. Widening list_expenses() (additive columns only, existing
-- 15-column shape untouched at the front) to surface:
--   - recorded_by_name / voided_by_name (resolved from profiles,
--     matching the established pattern used throughout this codebase
--     e.g. payments.received_by_name)
--   - voided_at (already stored, never returned)
--   - cash_shift_id + a human-readable cash_shift_reference (this
--     product has no serial-number scheme for cash shifts -- opened_at
--     is the only stable human-readable identity, matching how
--     CashShiftPage.tsx itself displays shifts to staff)
-- Postgres refuses to change a RETURNS TABLE shape in place ("cannot
-- change return type of existing function") -- must drop first, same
-- pattern already used throughout this codebase's migration history
-- for every prior return-shape change (e.g. drop_old_*_overload).
drop function if exists public.list_expenses(uuid, date, date, uuid, uuid, text);

create or replace function public.list_expenses(p_club_id uuid, p_start_date date, p_end_date date, p_branch_id uuid DEFAULT NULL::uuid, p_category_id uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text)
 returns table(
   id uuid, branch_id uuid, branch_name text, category_id uuid, category_name text,
   amount numeric, payment_method text, description text, reference text, paid_to text,
   expense_date date, status text, created_by uuid, created_at timestamp with time zone,
   void_reason text, recorded_by_name text, voided_by_name text, voided_at timestamp with time zone,
   cash_shift_id uuid, cash_shift_reference text
 )
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_accessible uuid[];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('expense.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;
  if p_status is not null and p_status not in ('recorded', 'voided') then
    raise exception 'invalid status filter';
  end if;

  v_accessible := public.caller_accessible_branch_ids(p_club_id);
  if p_branch_id is not null and v_accessible is not null and not (p_branch_id = any(v_accessible)) then
    raise exception 'not authorized';
  end if;

  return query
    select
      e.id, e.branch_id, coalesce(b.name, ''), e.category_id, coalesce(c.name_ar, ''),
      e.amount, e.payment_method, e.description, e.reference, e.paid_to,
      e.expense_date, e.status, e.created_by, e.created_at, e.void_reason,
      recorder.full_name, voider.full_name, e.voided_at,
      e.cash_shift_id,
      case when cs.opened_at is not null
        then to_char(cs.opened_at at time zone coalesce((select clb.timezone from public.clubs clb where clb.id = p_club_id), 'Africa/Cairo'), 'YYYY-MM-DD HH24:MI')
        else null
      end
    from public.expenses e
    join public.branches b on b.id = e.branch_id
    left join public.expense_categories c on c.id = e.category_id
    left join public.profiles recorder on recorder.user_id = e.created_by
    left join public.profiles voider on voider.user_id = e.voided_by
    left join public.cash_shifts cs on cs.id = e.cash_shift_id
    where e.club_id = p_club_id
      and e.expense_date >= p_start_date and e.expense_date <= p_end_date
      and (p_branch_id is null or e.branch_id = p_branch_id)
      and (v_accessible is null or e.branch_id = any(v_accessible))
      and (p_category_id is null or e.category_id = p_category_id)
      and (p_status is null or e.status = p_status)
    order by e.expense_date desc, e.created_at desc;
end;
$function$;

-- Re-grant exactly what the original 20260830010000_expenses_feature.sql
-- migration granted (authenticated only) -- the drop above removes all
-- grants, so this must be re-applied explicitly or the widened function
-- becomes unreachable from the client.
grant execute on function public.list_expenses(uuid, date, date, uuid, uuid, text) to authenticated;
