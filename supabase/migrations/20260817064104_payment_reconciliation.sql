-- Master Payment Directive task #87: payment-method reporting +
-- reconciliation.
--
-- Audit before implementing (REUSE/EXTEND/NORMALIZE): get_revenue_report()
-- already returns a by_method breakdown (task #13/Phase 13) -- reused
-- as-is for the reporting half, not duplicated. Cash already has full
-- reconciliation via cash_shifts (task #62: opening float, closing
-- count, expected_cash, variance, computed and frozen at shift close).
-- The genuine gap is every OTHER payment method (card/bank_transfer/
-- wallet/other): there is currently no way for staff to confirm "the
-- system says X was collected via bank transfer this week, and I've
-- checked the bank statement -- it matches" (or doesn't). Cash's own
-- drawer-count model doesn't apply here (there's no physical count for
-- a bank transfer) -- the natural equivalent is a manual confirmation
-- against an external source of truth (bank statement, POS terminal
-- batch report), not a recomputation of anything already in this
-- schema.
--
-- Design: one row per (club, branch, method, period) marking that
-- period's total for that method as reconciled, with an optional note
-- (e.g. a bank statement reference) and who/when. The reconciled TOTAL
-- itself is captured at confirmation time (frozen, same principle as
-- cash_shifts' expected_cash) rather than recomputed live later, so a
-- reconciliation record stays meaningful even if new payments are
-- later recorded that would change a live sum for that same period.

create table public.payment_reconciliations (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid references public.branches(id),
  method text not null check (method in ('cash', 'card', 'bank_transfer', 'wallet', 'other')),
  period_start date not null,
  period_end date not null,
  -- Frozen at confirmation time from the same payments-minus-refunds
  -- formula get_revenue_report() uses -- not a live recomputation, so
  -- this record stays a stable statement of what was reconciled even
  -- if later corrections change the live total for the same period.
  reconciled_total numeric not null,
  note text,
  reconciled_by uuid not null references auth.users(id),
  reconciled_at timestamptz not null default now(),
  constraint payment_reconciliations_period_check check (period_end >= period_start)
);

create index payment_reconciliations_club_method_idx on public.payment_reconciliations (club_id, method, period_start);

alter table public.payment_reconciliations enable row level security;

create policy "payment_reconciliations_select_own_club" on public.payment_reconciliations
  for select using (club_id in (select public.user_club_ids()) and public.has_permission('report.view', club_id));

-- No direct client INSERT/UPDATE policy -- written only by
-- confirm_payment_reconciliation() (SECURITY DEFINER), which freezes
-- reconciled_total from the real payments data at confirmation time
-- rather than trusting a client-supplied number, so a reconciliation
-- record can never claim a total that does not match what the system
-- actually recorded.
alter table public.payment_reconciliations force row level security;

comment on table public.payment_reconciliations is
  'Task #87: manual confirmation that a payment method''s recorded total for a period has been checked against its external source of truth (bank statement, POS batch report) and matches. Cash already has full reconciliation via cash_shifts (opening/closing/variance) -- this table covers every OTHER method, where there is no physical drawer count to reconcile against, only an external statement. reconciled_total is frozen server-side at confirmation time, never client-supplied.';

-- ============================================================
-- confirm_payment_reconciliation: staff confirms a method+period's
-- recorded total matches its external statement. Computes the real
-- total itself (same formula as get_revenue_report(), reused via a
-- direct query rather than calling that jsonb-returning function, to
-- get a plain numeric value) -- never trusts a client-supplied amount.
-- ============================================================
create or replace function public.confirm_payment_reconciliation(
  p_club_id uuid,
  p_method text,
  p_period_start date,
  p_period_end date,
  p_branch_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total numeric;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_method not in ('cash', 'card', 'bank_transfer', 'wallet', 'other') then
    raise exception 'invalid payment method';
  end if;

  if p_period_end < p_period_start then
    raise exception 'p_period_end must be on or after p_period_start';
  end if;

  select coalesce(sum(p.amount), 0)
    - coalesce((
        select sum(r.amount) from public.refunds r
        join public.payments rp on rp.id = r.payment_id
        where rp.club_id = p_club_id and rp.method = p_method and r.status = 'completed'
          and r.refunded_at::date between p_period_start and p_period_end
          and (p_branch_id is null or rp.branch_id = p_branch_id)
      ), 0)
  into v_total
  from public.payments p
  where p.club_id = p_club_id and p.method = p_method and p.status = 'completed'
    and p.received_at::date between p_period_start and p_period_end
    and (p_branch_id is null or p.branch_id = p_branch_id);

  insert into public.payment_reconciliations (club_id, branch_id, method, period_start, period_end, reconciled_total, note, reconciled_by)
  values (p_club_id, p_branch_id, p_method, p_period_start, p_period_end, v_total, p_note, auth.uid())
  returning id into v_id;

  perform public.write_audit_log(
    p_club_id, 'payment.reconciliation_confirmed', 'payment_reconciliations', v_id, null,
    jsonb_build_object('method', p_method, 'period_start', p_period_start, 'period_end', p_period_end, 'reconciled_total', v_total),
    p_note
  );

  return v_id;
end;
$$;

revoke execute on function public.confirm_payment_reconciliation(uuid, text, date, date, uuid, text) from public, anon;
grant execute on function public.confirm_payment_reconciliation(uuid, text, date, date, uuid, text) to authenticated;

comment on function public.confirm_payment_reconciliation(uuid, text, date, date, uuid, text) is
  'Task #87: confirms a payment method''s recorded total for a period matches its external statement. reconciled_total is computed server-side from real payments/refunds data (same formula as get_revenue_report()), never a client-supplied number -- a staff member cannot record a reconciliation for an amount that does not match what the system actually shows.';
