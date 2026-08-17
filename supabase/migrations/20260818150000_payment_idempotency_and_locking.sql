-- FINAL AUTONOMOUS REMEDIATION -- Finance P0 (C3 from
-- MAL3ABY_PRODUCTION_READINESS.md's confirmed CRITICAL findings): a
-- real payment-duplication risk in record_payment(), confirmed live
-- (a near-duplicate payment pattern -- two identical 100 EGP payments
-- on the same invoice 0.29 seconds apart -- was found in this
-- project's own live data during the readiness assessment).
--
-- TWO SEPARATE BUGS, ONE FIX EACH:
--
-- (a) RACE CONDITION (concurrency): record_payment() computed
-- v_outstanding via a plain SELECT with no row lock, then later
-- inserted a payment based on that read. Two concurrent calls against
-- the same invoice (e.g. outstanding=100, two browser tabs/requests
-- both submitting payment=100 at the same instant) can both read the
-- SAME pre-payment v_outstanding, both pass the "amount <= outstanding"
-- check, and both insert -- overpaying the invoice by up to 2x with no
-- error. Fixed with `select ... for update` on the invoice row, which
-- serializes concurrent record_payment() calls against the same
-- invoice: the second call blocks until the first commits, then
-- re-reads the now-updated outstanding balance and correctly rejects
-- if it would overpay.
--
-- (b) RETRY / DOUBLE-CLICK (idempotency): even single-threaded, a
-- network timeout followed by a client retry, or a genuine
-- accidental double-click before the button's disabled state commits
-- in the browser, sends the exact same logical payment request twice.
-- With no idempotency key, both requests are indistinguishable at the
-- database layer -- both succeed as two separate real payments. Fixed
-- with a new optional p_idempotency_key parameter: when provided, a
-- partial unique index on payments(club_id, idempotency_key) makes a
-- second insert with the SAME key a no-op that returns the ALREADY-
-- EXISTING payment's id instead of creating a new row (matching this
-- codebase's own established idempotency pattern already used for
-- notification_queue.dedup_key). The frontend generates a fresh
-- UUID once per payment-collection attempt (not per click) and
-- resends the SAME key on any retry of that same attempt.
--
-- p_idempotency_key defaults to null (backward compatible -- any
-- existing caller that doesn't pass it keeps working exactly as
-- before, just without idempotency protection on that particular
-- call path until it's updated to pass one). The row-lock fix (a)
-- applies unconditionally regardless of whether a key is passed --
-- that part requires no caller changes and is not optional.

alter table public.payments add column if not exists idempotency_key uuid;

-- Partial unique index: only enforces uniqueness when a key is
-- actually provided, so historical rows (idempotency_key is null) and
-- future callers that don't pass one are unaffected.
create unique index if not exists payments_club_idempotency_key_unique
  on public.payments (club_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.payments.idempotency_key is
  'Optional client-generated key (one per logical payment-collection attempt, reused verbatim on retry of that same attempt). A second record_payment() call with the same (club_id, idempotency_key) returns the existing payment instead of creating a duplicate. Security P0 fix, MAL3ABY_PRODUCTION_READINESS.md C3.';

create or replace function public.record_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice record;
  v_payment_id uuid;
  v_existing_payment_id uuid;
  v_pending_subscription_id uuid;
  v_outstanding numeric;
  v_event_id uuid;
  v_new_outstanding numeric;
  v_pending_booking_id uuid;
  v_club_name text;
  v_customer_name text;
  v_booking_ref text;
  v_invoice_token text;
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

  -- Idempotency check happens BEFORE the row lock and BEFORE any
  -- mutation: a retried request with a key that already exists for
  -- this club returns the original payment's id immediately, with no
  -- side effects re-run (no second audit log entry, no second
  -- notification queued, no second attempt to auto-confirm a booking).
  if p_idempotency_key is not null then
    select id into v_existing_payment_id
    from public.payments
    where club_id = v_invoice.club_id and idempotency_key = p_idempotency_key;

    if v_existing_payment_id is not null then
      return v_existing_payment_id;
    end if;
  end if;

  if not public.club_write_allowed(v_invoice.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  if v_invoice.status != 'issued' then
    raise exception 'can only record payment against an issued invoice';
  end if;

  -- Row lock: serializes concurrent record_payment() calls against
  -- THIS invoice specifically (other invoices are unaffected -- this
  -- is a per-row lock, not a table lock). A second concurrent call
  -- blocks here until the first transaction commits or rolls back,
  -- then proceeds with a fresh, correct outstanding-balance read.
  perform 1 from public.invoices where id = p_invoice_id for update;

  select v_invoice.total
    - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = v_invoice.id), 0)
    + coalesce((select sum(r.amount) from public.payment_allocations pa
                join public.refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
                where pa.invoice_id = v_invoice.id), 0)
  into v_outstanding;

  if p_amount > v_outstanding then
    raise exception 'payment amount (%) exceeds the invoice''s outstanding balance (%)', p_amount, v_outstanding;
  end if;

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by, idempotency_key)
  values (v_invoice.club_id, v_invoice.branch_id, v_invoice.customer_id, p_method, p_amount, p_reference, auth.uid(), p_idempotency_key)
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

  v_new_outstanding := greatest(v_outstanding - p_amount, 0);

  if v_new_outstanding <= 0 then
    select id into v_pending_booking_id from public.bookings
    where invoice_id = p_invoice_id and status = 'pending_payment'
    limit 1;

    if v_pending_booking_id is not null then
      update public.bookings set status = 'confirmed' where id = v_pending_booking_id;

      perform public.write_audit_log(
        v_invoice.club_id, 'booking.auto_confirmed_on_full_payment', 'bookings', v_pending_booking_id, null,
        jsonb_build_object('invoice_id', p_invoice_id, 'triggering_payment_id', v_payment_id),
        null
      );
    end if;
  end if;

  select name into v_club_name from public.clubs where id = v_invoice.club_id;
  select full_name into v_customer_name from public.customers where id = v_invoice.customer_id;
  select 'MB-' || upper(substring(id::text, 1, 8)) into v_booking_ref
    from public.bookings where invoice_id = p_invoice_id limit 1;

  v_invoice_token := public._mint_invoice_token_internal(p_invoice_id, v_invoice.club_id, auth.uid());

  v_event_id := public.emit_notification_event(
    v_invoice.club_id, 'payment.received', 'payment', v_payment_id,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'customer_id', v_invoice.customer_id, 'invoice_id', p_invoice_id, 'remaining_outstanding', v_new_outstanding)
  );

  perform public.queue_whatsapp_notification(
    v_invoice.club_id, v_event_id, v_invoice.customer_id, 'payment-received', 'payment_confirmations',
    jsonb_build_object(
      'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
      'payment_status', case when v_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
      'remaining_outstanding', v_new_outstanding, 'method', p_method,
      'club_name', v_club_name, 'customer_name', v_customer_name, 'booking_ref', v_booking_ref,
      'invoice_token', v_invoice_token
    ),
    'transactional', 'payment.received:' || v_payment_id::text
  );

  return v_payment_id;
end;
$$;

revoke execute on function public.record_payment(uuid, numeric, text, text, uuid) from public;
revoke execute on function public.record_payment(uuid, numeric, text, text, uuid) from anon;
grant execute on function public.record_payment(uuid, numeric, text, text, uuid) to authenticated;

-- Drop the old 4-argument overload explicitly -- CREATE OR REPLACE
-- with a new default-valued trailing parameter does NOT replace the
-- old signature in Postgres (same overload-identity pitfall this
-- project has hit twice before with _create_booking_internal). Every
-- existing frontend call site omits p_idempotency_key positionally
-- (uses named params via supabase-js, not positional), so they will
-- resolve to the new 5-arg overload correctly once the old 4-arg one
-- is gone -- but leaving both live would silently let an un-updated
-- caller keep hitting the OLD unprotected function forever.
drop function if exists public.record_payment(uuid, numeric, text, text);
