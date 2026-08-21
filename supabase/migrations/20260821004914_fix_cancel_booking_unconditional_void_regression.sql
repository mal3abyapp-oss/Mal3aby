-- SP-001 follow-up: a concurrent session's own fix for the same P1
-- (20260821004357_void_invoice_on_booking_cancellation) landed 80
-- seconds after this session's own fix
-- (20260821004237_block_payment_on_cancelled_booking) and overwrote
-- cancel_booking()/record_payment_proof_upload()/claim_manual_payment()
-- with a version that voids ANY issued invoice on cancellation
-- UNCONDITIONALLY, regardless of paid amount -- including invoices
-- that already had real payments recorded. Its own backfill
-- (`do $backfill$`) then retroactively voided every cancelled+issued
-- invoice in production, which flipped 25 ALREADY-PAID invoices'
-- status to 'void' (confirmed live: paid amounts of 99999, 350, 300,
-- 250, 220, 200x3, 190x5, 150x8, 100x4 across those 25 rows).
--
-- Real consequence, confirmed by inspection: get_invoice_payment_summary()
-- (the single source of truth every screen reads) reports
-- payment_status='void' for status='void' regardless of actual paid
-- amount -- so a genuinely-paid, cancelled booking's invoice now
-- displays as "void" everywhere (Customer 360, Finance, Portal,
-- WhatsApp/invoice verification links) instead of "paid". Several
-- downstream queries additionally filter `status not in ('draft',
-- 'void')` (get_customer_360_summary, get_customer_financial_account,
-- the outstanding_invoices view's WHERE status='issued'), which makes
-- these 25 paid invoices DISAPPEAR from the customer's financial
-- ledger and Finance reports entirely -- a real regression against
-- the explicit "if historical invoice remains visible, show its
-- financial/history status clearly" / "paid history must remain"
-- requirements. The underlying payments/payment_allocations/refunds
-- rows were never touched by either migration -- no money was lost,
-- only the invoice's own status label was wrongly overwritten.
--
-- Fix, forward-only (never revert the other session's work wholesale
-- -- its core intent, blocking further collection, is correct and
-- already independently guaranteed by this session's own
-- record_payment() hard block, untouched by the other migration):
--   1. Restore the 'issued' status on every invoice that was voided
--      by the unconditional backfill despite having paid > 0 -- this
--      is the safe direction to correct, since 'issued' is the
--      state that was true before either migration ran and its
--      payment history was always accurate.
--   2. Re-apply the paid=0 guard to cancel_booking() so this cannot
--      recur on the next cancellation of an already-paid booking.
--   3. Leave record_payment_proof_upload()/claim_manual_payment() as
--      the other session left them -- their own status-check logic
--      (v_invoice_status != 'issued' / not 'issued') is actually
--      CORRECT for a genuinely-void invoice and poses no risk now
--      that step 1 has restored the wrongly-voided paid invoices back
--      to 'issued' -- no further change needed there.

-- ============================================================
-- Step 1: restore paid invoices that were incorrectly voided by the
-- unconditional backfill. Scoped precisely: only invoices currently
-- status='void', linked to a cancelled booking, with real paid
-- amount > 0. Each restoration gets its own audit entry.
-- ============================================================
do $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select i.id as invoice_id, i.club_id, b.id as booking_id, s.paid
    from public.invoices i
    join public.bookings b on b.invoice_id = i.id
    cross join lateral public.get_invoice_payment_summary(array[i.id]) s
    where i.status = 'void' and b.status = 'cancelled' and coalesce(s.paid, 0) > 0
  loop
    update public.invoices set status = 'issued', updated_at = now() where id = v_row.invoice_id;
    v_count := v_count + 1;

    perform public.write_audit_log(
      v_row.club_id, 'invoice.restored_after_incorrect_void', 'invoices', v_row.invoice_id,
      jsonb_build_object('status', 'void'), jsonb_build_object('status', 'issued'),
      format('SP-001 correction: this invoice had a real paid amount of %s and was incorrectly voided by an unconditional backfill (booking %s) -- restored to issued so its payment history displays correctly. Further collection against it remains blocked by record_payment()''s own booking-status hard check.', v_row.paid, v_row.booking_id)
    );
  end loop;

  raise notice 'SP-001 correction: restored % incorrectly-voided paid invoice(s) to issued', v_count;
end $$;

-- ============================================================
-- Step 2: re-apply the paid=0 guard to cancel_booking(), preserving
-- everything else the concurrent session's version already has
-- correct (the idempotent status='issued' WHERE guard, its own audit
-- action naming). Full body otherwise identical to the currently-live
-- version.
-- ============================================================
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_customer_id uuid;
  v_field_id uuid;
  v_field_name text;
  v_start_at timestamptz;
  v_event_id uuid;
  v_invoice_id uuid;
  v_paid numeric;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancellation reason is required';
  end if;

  select club_id, customer_id, field_id, start_at, invoice_id
    into v_club_id, v_customer_id, v_field_id, v_start_at, v_invoice_id
  from public.bookings where id = p_booking_id;
  if v_club_id is null then
    raise exception 'booking not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.cancel', v_club_id)) then
    raise exception 'not authorized';
  end if;

  update public.bookings
  set status = 'cancelled', cancelled_reason = p_reason, cancelled_by = auth.uid(), cancelled_at = now()
  where id = p_booking_id and status in ('pending_payment', 'confirmed');

  if not found then
    raise exception 'booking not found or not in a cancellable state';
  end if;

  -- SP-001: void the invoice so it is no longer collectible through
  -- any payment path -- but ONLY when it has zero paid amount. An
  -- invoice with real payment history is deliberately left
  -- status='issued' -- voiding it would make get_invoice_payment_summary()
  -- report payment_status='void' instead of 'paid'/'partially_paid',
  -- hiding real financial history from Customer 360/Finance/Portal.
  -- Its remaining balance (if any) is made non-collectible instead by
  -- record_payment()'s own hard booking-status check -- never by
  -- rewriting the invoice's status once money has actually moved.
  if v_invoice_id is not null then
    perform 1 from public.invoices where id = v_invoice_id for update;

    select coalesce(sum(pa.amount), 0) into v_paid
    from public.payment_allocations pa where pa.invoice_id = v_invoice_id;

    if v_paid = 0 then
      update public.invoices
      set status = 'void', updated_at = now()
      where id = v_invoice_id and status = 'issued';

      if found then
        perform public.write_audit_log(
          v_club_id, 'invoice.voided_on_booking_cancellation', 'invoices', v_invoice_id,
          jsonb_build_object('status', 'issued'), jsonb_build_object('status', 'void'),
          'booking cancelled: ' || p_reason
        );
      end if;
    end if;
  end if;

  perform public.write_audit_log(v_club_id, 'cancel_booking', 'bookings', p_booking_id, null, jsonb_build_object('status', 'cancelled'), p_reason);

  select name into v_field_name from public.fields where id = v_field_id;

  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.cancelled', 'booking', p_booking_id,
    jsonb_build_object('customer_id', v_customer_id, 'reason', p_reason, 'start_at', v_start_at)
  );

  perform public.queue_whatsapp_notification(
    v_club_id, v_event_id, v_customer_id, 'booking-cancelled', 'booking_confirmations',
    jsonb_build_object('field_name', coalesce(v_field_name, ''), 'start_at', v_start_at, 'reason', p_reason),
    'transactional', 'booking.cancelled:' || p_booking_id::text
  );

  perform public.cancel_pending_whatsapp_for_booking(p_booking_id, v_event_id);
end;
$function$;

revoke execute on function public.cancel_booking(uuid, text) from public;
revoke execute on function public.cancel_booking(uuid, text) from anon;
grant execute on function public.cancel_booking(uuid, text) to authenticated;

comment on function public.cancel_booking(uuid, text) is
  'SP-001 (corrected): voids the linked invoice transactionally only when its paid amount is zero -- an invoice with real payment history is left issued so Customer 360/Finance/Portal continue to display its true paid status; its remaining balance is made non-collectible by record_payment()''s own booking-status hard check instead.';

-- ============================================================
-- Step 3: also re-apply the expire_stale_booking_holds() equivalent
-- guard, since the concurrent session's migration gave it the exact
-- same unconditional void logic as cancel_booking() had -- a stale
-- payment-hold booking could theoretically have a partial payment
-- recorded against its invoice before the hold expired (e.g. staff
-- manually recorded cash while the hold was still open), so the same
-- correction applies here for consistency and future safety, even
-- though today's live data shows no such case.
-- ============================================================
create or replace function public.expire_stale_booking_holds()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_booking record;
  v_count integer := 0;
  v_event_id uuid;
  v_field_name text;
  v_paid numeric;
begin
  for v_booking in
    select id, club_id, customer_id, field_id, start_at, invoice_id
    from public.bookings
    where status = 'pending_payment'
      and hold_expires_at is not null
      and hold_expires_at < now()
    order by hold_expires_at
    limit 200
  loop
    update public.bookings
    set status = 'cancelled', cancelled_reason = 'Payment hold expired', cancelled_at = now()
    where id = v_booking.id and status = 'pending_payment';

    if found then
      v_count := v_count + 1;

      if v_booking.invoice_id is not null then
        select coalesce(sum(pa.amount), 0) into v_paid
        from public.payment_allocations pa where pa.invoice_id = v_booking.invoice_id;

        if v_paid = 0 then
          update public.invoices
          set status = 'void', updated_at = now()
          where id = v_booking.invoice_id and status = 'issued';

          if found then
            perform public.write_audit_log(
              v_booking.club_id, 'invoice.voided_on_booking_cancellation', 'invoices', v_booking.invoice_id,
              jsonb_build_object('status', 'issued'), jsonb_build_object('status', 'void'),
              'payment hold expired'
            );
          end if;
        end if;
      end if;

      perform public.write_audit_log(v_booking.club_id, 'booking.hold_expired', 'booking', v_booking.id, null,
        jsonb_build_object('status', 'cancelled', 'reason', 'payment_hold_expired'), null);

      select name into v_field_name from public.fields where id = v_booking.field_id;

      v_event_id := public.emit_notification_event(
        v_booking.club_id, 'booking.cancelled', 'booking', v_booking.id,
        jsonb_build_object('customer_id', v_booking.customer_id, 'reason', 'payment_hold_expired', 'start_at', v_booking.start_at)
      );

      perform public.queue_whatsapp_notification(
        v_booking.club_id, v_event_id, v_booking.customer_id, 'booking-cancelled', 'booking_confirmations',
        jsonb_build_object('field_name', coalesce(v_field_name, ''), 'start_at', v_booking.start_at, 'reason', 'Payment hold expired'),
        'transactional', 'booking.cancelled:' || v_booking.id::text
      );

      perform public.cancel_pending_whatsapp_for_booking(v_booking.id, v_event_id);
    end if;
  end loop;

  return v_count;
end;
$function$;

comment on function public.expire_stale_booking_holds() is
  'SP-001 (corrected): same paid=0 guard as cancel_booking() before voiding a stale hold''s invoice.';
