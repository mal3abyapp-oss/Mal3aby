-- Phase 7 — Billing Core: refunds, outstanding_invoices view, issued-
-- invoice lock, standalone payment recording RPC.
-- See docs/IMPLEMENTATION_PLAN.md Phase 7, docs/ARCHITECTURE.md
-- #billing--financial-integrity-strategy, docs/DATABASE_BLUEPRINT.md
-- #refunds / #outstanding_invoices-view.

-- ============================================================
-- refunds
-- ============================================================
create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id),
  amount numeric(12,2) not null check (amount > 0),
  reason text not null,
  status text not null default 'completed' check (status in ('completed', 'void')),
  refunded_by uuid references auth.users(id),
  refunded_at timestamptz not null default now()
);
comment on table public.refunds is 'Append-only reversal record -- never mutates payments.amount, never deletes it (ADR-011c).';

create index idx_refunds_payment_id on public.refunds (payment_id);

alter table public.refunds enable row level security;

create policy "refunds_select_club_staff" on public.refunds
  for select using (
    exists (
      select 1 from public.payments p
      where p.id = payment_id
        and p.club_id in (select public.user_club_ids())
        and public.has_permission('payment.view', p.club_id)
    )
  );

create policy "refunds_insert_with_permission" on public.refunds
  for insert with check (
    exists (
      select 1 from public.payments p
      where p.id = payment_id
        and p.club_id in (select public.user_club_ids())
        and public.has_permission('payment.create', p.club_id)
    )
  );

-- No UPDATE/DELETE policy -- append-only, matching the no-hard-delete rule.
-- A mistaken refund is corrected by recording a new payment, never editing
-- or removing the refund record.

-- ============================================================
-- outstanding_invoices (view) -- read-only ledger projection, no new
-- stored value, per ADR-048. Exact formula from ARCHITECTURE.md/
-- DATABASE_BLUEPRINT.md.
-- ============================================================
create view public.outstanding_invoices as
select
  i.id,
  i.club_id,
  i.branch_id,
  i.invoice_number,
  i.customer_id,
  c.full_name as customer_name,
  c.normalized_mobile,
  i.status,
  i.total,
  i.due_date,
  i.issued_at,
  i.total
    - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = i.id), 0)
    + coalesce((
        select sum(r.amount)
        from public.payment_allocations pa
        join public.refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
        where pa.invoice_id = i.id
      ), 0) as outstanding,
  case when i.due_date is not null then (current_date - i.due_date) else null end as days_overdue
from public.invoices i
join public.customers c on c.id = i.customer_id
where i.status = 'issued';

alter view public.outstanding_invoices set (security_invoker = true);
grant select on public.outstanding_invoices to authenticated;

comment on view public.outstanding_invoices is 'Read-only ledger projection backing /app/outstanding. Filters apply at the query layer against this same view -- no separately-maintained dataset (ADR-048). RLS on the underlying invoices/customers tables (security_invoker) provides the same club/branch scoping as invoices itself.';

-- ============================================================
-- create_refund: atomic RPC per ARCHITECTURE.md's 5-step shape.
-- ============================================================
create or replace function public.create_refund(
  p_payment_id uuid,
  p_amount numeric,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment record;
  v_refunded_sum numeric;
  v_refund_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a refund reason is required';
  end if;

  if p_amount <= 0 then
    raise exception 'refund amount must be positive';
  end if;

  select * into v_payment from public.payments where id = p_payment_id;
  if v_payment is null then
    raise exception 'payment not found';
  end if;

  if not (v_payment.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_payment.club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_payment.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  -- 1. Validate: p_amount <= (payment.amount - sum of prior completed
  -- refunds for this payment). Checked inside the same transaction as the
  -- insert -- no TOCTOU gap (the row lock from the UPDATE-less SELECT here
  -- is safe because Postgres serializes concurrent INSERTs into refunds
  -- naturally via this SELECT ... FOR UPDATE on the payment row).
  perform 1 from public.payments where id = p_payment_id for update;

  select coalesce(sum(amount), 0) into v_refunded_sum
  from public.refunds
  where payment_id = p_payment_id and status = 'completed';

  if p_amount > (v_payment.amount - v_refunded_sum) then
    raise exception 'refund amount exceeds refundable balance (refundable: %)', v_payment.amount - v_refunded_sum;
  end if;

  -- 2. Insert into refunds.
  insert into public.refunds (payment_id, amount, reason, refunded_by)
  values (p_payment_id, p_amount, p_reason, auth.uid())
  returning id into v_refund_id;

  -- 3. No synthetic negative payment_allocations row -- the documented
  -- outstanding-balance formula already adds back completed refunds
  -- directly (see outstanding_invoices above), so refunds is itself the
  -- "reversing" record; payment_allocations.amount keeps its `> 0`
  -- invariant intact.

  -- 4. Audit entry.
  perform public.write_audit_log(
    v_payment.club_id, 'create_refund', 'refunds', v_refund_id,
    jsonb_build_object('payment_id', p_payment_id, 'previously_refunded', v_refunded_sum),
    jsonb_build_object('amount', p_amount), p_reason
  );

  return v_refund_id;
end;
$$;

revoke execute on function public.create_refund(uuid, numeric, text) from public;
revoke execute on function public.create_refund(uuid, numeric, text) from anon;
grant execute on function public.create_refund(uuid, numeric, text) to authenticated;

-- ============================================================
-- record_payment: standalone payment against an existing invoice
-- (the "payment collection form" flow -- create_booking already handles
-- the pay-at-booking-time path; this covers paying an outstanding invoice
-- later, and multi-invoice/partial payments via payment_allocations).
-- ============================================================
create or replace function public.record_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice record;
  v_payment_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if p_method not in ('cash', 'card', 'bank_transfer', 'wallet', 'other') then
    raise exception 'invalid method';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id;
  if v_invoice is null then
    raise exception 'invoice not found';
  end if;

  if not (v_invoice.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_invoice.club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_invoice.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  if v_invoice.status != 'issued' then
    raise exception 'can only record payment against an issued invoice';
  end if;

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by)
  values (v_invoice.club_id, v_invoice.branch_id, v_invoice.customer_id, p_method, p_amount, p_reference, auth.uid())
  returning id into v_payment_id;

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, p_invoice_id, p_amount);

  return v_payment_id;
end;
$$;

revoke execute on function public.record_payment(uuid, numeric, text, text) from public;
revoke execute on function public.record_payment(uuid, numeric, text, text) from anon;
grant execute on function public.record_payment(uuid, numeric, text, text) to authenticated;

-- ============================================================
-- Issued invoice lock: replace the earlier permissive
-- invoice_items_update_with_permission policy (Phase 6) with one that
-- explicitly forbids updates once the parent invoice is issued -- it
-- already had `and i.status != 'issued'`, so no change needed there, but
-- add the same lock explicitly to invoices itself: once issued, only
-- status can move to 'void' (via a dedicated RPC below), never subtotal/
-- discount/tax/total/customer_id edited directly.
-- ============================================================
create or replace function public.void_invoice(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a void reason is required';
  end if;

  select club_id into v_club_id from public.invoices where id = p_invoice_id;
  if v_club_id is null then
    raise exception 'invoice not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('invoice.update', v_club_id)) then
    raise exception 'not authorized';
  end if;

  update public.invoices set status = 'void' where id = p_invoice_id and status = 'issued';

  if not found then
    raise exception 'invoice not found or not in a voidable state';
  end if;

  perform public.write_audit_log(v_club_id, 'void_invoice', 'invoices', p_invoice_id, null, jsonb_build_object('status', 'void'), p_reason);
end;
$$;

revoke execute on function public.void_invoice(uuid, text) from public;
revoke execute on function public.void_invoice(uuid, text) from anon;
grant execute on function public.void_invoice(uuid, text) to authenticated;

-- Tighten the direct-update policy on invoices: draft-status edits remain
-- open (a draft is not yet a financial commitment), but once issued, no
-- direct client UPDATE path exists at all -- only void_invoice (status
-- transition) or the normal ledger RPCs (payments/refunds), matching
-- SECURITY_ANTI_FRAUD.md's Issued Invoice Lock.
drop policy if exists "invoices_update_with_permission" on public.invoices;
create policy "invoices_update_draft_only" on public.invoices
  for update using (
    club_id in (select public.user_club_ids())
    and public.has_permission('invoice.update', club_id)
    and status = 'draft'
  );
