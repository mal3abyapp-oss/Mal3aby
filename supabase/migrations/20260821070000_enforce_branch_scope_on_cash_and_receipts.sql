-- P1 financial isolation fix. Cash shifts, employee liabilities and official
-- receipts remained club-scoped after the core RLS hardening. In addition,
-- SECURITY DEFINER write RPCs bypass table RLS. A row trigger therefore
-- enforces branch scope for every authenticated write path, including RPCs.

drop policy if exists cash_shifts_select_own_club on public.cash_shifts;
create policy cash_shifts_select_own_club on public.cash_shifts for select using (
  club_id in (select public.user_club_ids())
  and public.user_has_branch_access(club_id, branch_id)
);

drop policy if exists ecl_select_own_club on public.employee_cash_liabilities;
create policy ecl_select_own_club on public.employee_cash_liabilities for select using (
  club_id in (select public.user_club_ids())
  and public.user_has_branch_access(club_id, branch_id)
);

drop policy if exists ocr_select_club_staff on public.official_collection_receipts;
create policy ocr_select_club_staff on public.official_collection_receipts for select using (
  club_id in (select public.user_club_ids())
  and public.has_permission('payment.view', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);
drop policy if exists ocr_insert_club_staff on public.official_collection_receipts;
create policy ocr_insert_club_staff on public.official_collection_receipts for insert with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('payment.create', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);

create or replace function public.enforce_authenticated_branch_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
begin
  -- Direct trusted database maintenance has no JWT. Service-role integrations
  -- are explicitly trusted and must keep operating. Every end-user/RPC call
  -- carries auth.uid() and is checked below.
  if v_role = 'service_role' or (auth.uid() is null and current_user in ('postgres', 'supabase_admin')) then
    return new;
  end if;

  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not public.user_has_branch_access(new.club_id, new.branch_id) then
    raise exception 'not authorized for this branch';
  end if;

  if tg_op = 'UPDATE'
     and not public.user_has_branch_access(old.club_id, old.branch_id) then
    raise exception 'not authorized for the original branch';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_authenticated_branch_scope() from public, anon, authenticated;

drop trigger if exists enforce_fields_branch_scope on public.fields;
create trigger enforce_fields_branch_scope before insert or update on public.fields
for each row execute function public.enforce_authenticated_branch_scope();

drop trigger if exists enforce_bookings_branch_scope on public.bookings;
create trigger enforce_bookings_branch_scope before insert or update on public.bookings
for each row execute function public.enforce_authenticated_branch_scope();

drop trigger if exists enforce_invoices_branch_scope on public.invoices;
create trigger enforce_invoices_branch_scope before insert or update on public.invoices
for each row execute function public.enforce_authenticated_branch_scope();

drop trigger if exists enforce_payments_branch_scope on public.payments;
create trigger enforce_payments_branch_scope before insert or update on public.payments
for each row execute function public.enforce_authenticated_branch_scope();

drop trigger if exists enforce_cash_shifts_branch_scope on public.cash_shifts;
create trigger enforce_cash_shifts_branch_scope before insert or update on public.cash_shifts
for each row execute function public.enforce_authenticated_branch_scope();

drop trigger if exists enforce_employee_liabilities_branch_scope on public.employee_cash_liabilities;
create trigger enforce_employee_liabilities_branch_scope before insert or update on public.employee_cash_liabilities
for each row execute function public.enforce_authenticated_branch_scope();

drop trigger if exists enforce_official_receipts_branch_scope on public.official_collection_receipts;
create trigger enforce_official_receipts_branch_scope before insert or update on public.official_collection_receipts
for each row execute function public.enforce_authenticated_branch_scope();

comment on function public.enforce_authenticated_branch_scope() is
  'Defense-in-depth branch authorization for authenticated writes, including SECURITY DEFINER RPCs that intentionally bypass RLS. Trusted service-role and direct postgres maintenance remain allowed.';
