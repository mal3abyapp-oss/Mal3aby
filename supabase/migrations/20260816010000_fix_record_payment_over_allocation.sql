-- Stabilization pass (2026-08-16): P1 financial-integrity bug found and
-- fixed via live RPC testing. record_payment() validated p_amount > 0 and
-- a valid method, but never checked the amount against the invoice's
-- actual remaining balance -- a payment far exceeding the invoice total
-- was accepted and fully allocated, producing a nonsensical negative
-- `outstanding` value on outstanding_invoices (confirmed live: a 99999
-- EGP payment against a 200 EGP invoice produced outstanding = -99799.00).
--
-- Fixed by computing the invoice's current outstanding balance (same
-- formula as the outstanding_invoices view: total - allocated + refunded)
-- inside the function and rejecting any payment that would push it
-- negative. This is a tightening of an existing validation function, not
-- a schema/behavior change to any other part of the flow -- record_payment
-- itself, its callers, and every other check inside it are untouched.
create or replace function public.record_payment(p_invoice_id uuid, p_amount numeric, p_method text, p_reference text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice record;
  v_payment_id uuid;
  v_pending_subscription_id uuid;
  v_outstanding numeric;
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

  -- Same formula as public.outstanding_invoices: total minus everything
  -- already allocated, plus anything refunded back out of that allocated
  -- total (a refund reduces how much of the original allocation still
  -- "counts" against the balance).
  select v_invoice.total
    - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = v_invoice.id), 0)
    + coalesce((select sum(r.amount) from public.payment_allocations pa
                join public.refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
                where pa.invoice_id = v_invoice.id), 0)
  into v_outstanding;

  if p_amount > v_outstanding then
    raise exception 'payment amount (%) exceeds the invoice''s outstanding balance (%)', p_amount, v_outstanding;
  end if;

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by)
  values (v_invoice.club_id, v_invoice.branch_id, v_invoice.customer_id, p_method, p_amount, p_reference, auth.uid())
  returning id into v_payment_id;

  perform public.write_audit_log(
    v_invoice.club_id, 'payment.record', 'payment', v_payment_id, null,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'invoice_id', p_invoice_id),
    null
  );

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, p_invoice_id, p_amount);

  select id into v_pending_subscription_id from public.subscriptions
  where invoice_id = p_invoice_id and status = 'pending'
  limit 1;

  if v_pending_subscription_id is not null then
    perform public._activate_subscription_if_due_internal(v_pending_subscription_id);
  end if;

  return v_payment_id;
end;
$$;

revoke execute on function public.record_payment(uuid, numeric, text, text) from public;
revoke execute on function public.record_payment(uuid, numeric, text, text) from anon;
grant execute on function public.record_payment(uuid, numeric, text, text) to authenticated;
