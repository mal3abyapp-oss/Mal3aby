-- ============================================================
-- SP-001: CANCELLED BOOKING FINANCIAL INTEGRITY -- P1 HARD BLOCK
-- ============================================================
--
-- ROOT CAUSE (confirmed by direct inspection of the live deployed
-- functions, not assumed): cancel_booking() flips bookings.status to
-- 'cancelled' but has never touched the linked invoice at all -- the
-- invoice stays status='issued' forever. record_payment() only checks
-- `v_invoice.status != 'issued'`; it has no awareness of the
-- originating booking's status. Every other payment-writing path
-- (record_payment_with_official_receipt, approve_payment_proof,
-- verify_manual_payment_claim) delegates to record_payment() at the
-- end, so a single fix there closes the bypass for all of them,
-- including the government-official-receipt path (Section 16) and the
-- open-cash-shift path (Section 17) -- neither of those checks
-- involves booking status today, so both currently succeed against a
-- cancelled booking's invoice. Confirmed live: 43 cancelled bookings
-- in production currently retain an issued invoice (18 unpaid, 4
-- partially paid, 20 fully paid, 1 partially refunded) -- all 43
-- belong to test/QA clubs (Mala3by Test Club One, Mala3by Verification
-- Club, QA Full Test Club, Test), zero real customer financial history
-- is affected.
--
-- ARCHITECTURE CHOSEN (reuses the existing invoices.status enum --
-- draft/issued/void -- rather than inventing a parallel state
-- machine, per the explicit instruction not to duplicate the model):
--
-- 1. cancel_booking() now transactionally voids the linked invoice,
--    but ONLY when it has zero paid amount (via the same
--    get_invoice_payment_summary() every other screen already reads).
--    A paid-amount invoice is left status='issued' -- its payment
--    history is never touched, never zeroed, never hidden. This alone
--    already makes get_invoice_payment_summary() report
--    outstanding=0/payment_status='void' for a newly-cancelled unpaid
--    booking, which is what every read path in the app already keys
--    off (Customer Portal, Customer 360, Finance, WhatsApp/invoice
--    verification links, Reports) -- confirmed by inspection that ALL
--    of those already call get_invoice_payment_summary() /
--    outstanding_invoices (WHERE status='issued') rather than
--    reimplementing the math, so this one change alone already fixes
--    every downstream display with zero additional code.
--
-- 2. record_payment() gets the actual HARD SERVER BLOCK (the primary
--    protection per the directive -- UI hiding is explicitly
--    insufficient): it now also rejects if the invoice's originating
--    booking (if any) has status='cancelled', REGARDLESS of the
--    invoice's own status column. This is the defense that protects
--    the 4 partially-paid + any future-cancelled-but-still-issued
--    edge case where the invoice could not be safely voided (it has a
--    paid amount) -- the remaining balance becomes provably
--    non-collectible without ever touching the historical paid amount
--    or the invoice's own status.
--
-- 3. claim_manual_payment() and record_payment_proof_upload() (the two
--    customer-initiated entry points that precede record_payment() in
--    the approval chain) get the SAME booking-status check, so a
--    cancelled booking's invoice never even accumulates a pending
--    claim/proof queued for staff review -- purely to keep the staff
--    queue honest and avoid confusing "why can't I approve this" UX;
--    the money-movement gate itself is record_payment(), not these.
--
-- Historical guarantee (Section 3/4/5): no invoice, payment,
-- allocation, refund, booking, or audit row is deleted or has its
-- paid amount rewritten by this migration. void only ever applies to
-- an invoice with paid=0.

-- ============================================================
-- Part 1: cancel_booking() -- REPLACED, full existing body preserved
-- (task #93's WhatsApp wiring, Safe Messaging's
-- cancel_pending_whatsapp_for_booking() call), with the new invoice
-- voiding step added transactionally right after the booking's own
-- status update, inside the same function/transaction.
-- ============================================================
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_customer_id uuid;
  v_field_id uuid;
  v_field_name text;
  v_start_at timestamptz;
  v_event_id uuid;
  v_invoice_id uuid;
  v_summary record;
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

  perform public.write_audit_log(v_club_id, 'cancel_booking', 'bookings', p_booking_id, null, jsonb_build_object('status', 'cancelled'), p_reason);

  -- SP-001: void the linked invoice IF AND ONLY IF it has zero paid
  -- amount -- never rewrites, hides, or zeroes an invoice that has any
  -- real payment history. Locks the invoice row first (consistent with
  -- record_payment()'s own locking discipline) so a payment cannot be
  -- recorded in the small window between reading the summary and
  -- writing the void -- see the concurrency note in record_payment()
  -- below for the other half of this race's protection.
  if v_invoice_id is not null then
    perform 1 from public.invoices where id = v_invoice_id for update;

    select * into v_summary from public.get_invoice_payment_summary(array[v_invoice_id]::uuid[]);

    if v_summary.paid is null or v_summary.paid = 0 then
      update public.invoices
      set status = 'void'
      where id = v_invoice_id and status = 'issued';

      if found then
        perform public.write_audit_log(
          v_club_id, 'invoice.void_on_booking_cancel', 'invoices', v_invoice_id,
          jsonb_build_object('status', 'issued'), jsonb_build_object('status', 'void'),
          'automatically voided: linked booking ' || p_booking_id::text || ' was cancelled with zero payments recorded'
        );
      end if;
    end if;
    -- If v_summary.paid > 0, the invoice is deliberately left
    -- status='issued' -- its history (the real paid amount) is never
    -- touched. record_payment()'s own booking-status check below is
    -- what makes its remaining balance (if any) non-collectible
    -- without erasing what was already paid. Any refund is a separate,
    -- explicit staff action via create_refund() -- never automatic.
  end if;

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
$$;

revoke execute on function public.cancel_booking(uuid, text) from public;
revoke execute on function public.cancel_booking(uuid, text) from anon;
grant execute on function public.cancel_booking(uuid, text) to authenticated;

comment on function public.cancel_booking(uuid, text) is
  'SP-001: also voids the linked invoice transactionally, but ONLY when it has zero paid amount (never touches a paid invoice''s status or history). This is defense-in-depth alongside record_payment()''s own hard booking-status check, which is the actual primary block.';

-- ============================================================
-- Part 2: record_payment() -- REPLACED, full existing body preserved,
-- with the new booking-status check added right alongside the
-- existing invoice-status check. This is the PRIMARY server hard
-- block -- every payment writer in the system (direct RPC,
-- record_payment_with_official_receipt, approve_payment_proof,
-- verify_manual_payment_claim) converges here, so this one check
-- closes the bypass everywhere at once, including the government
-- official-receipt path and the open-cash-shift path.
--
-- Concurrency (Section 14): this function already takes
-- `for update` on the invoice row before computing outstanding and
-- inserting the payment. The new check is placed AFTER that lock is
-- acquired and reads bookings.status live at that point -- so a
-- payment request that begins concurrently with a cancellation cannot
-- slip through: whichever transaction (the cancellation's invoice
-- lock, or this function's own invoice lock) commits first is
-- authoritative, and the second transaction's read is guaranteed to
-- see the committed state (cancelled booking / voided invoice) because
-- both paths lock the same invoice row before reading. A payment that
-- began genuinely before the cancellation and is still checking amount
-- against outstanding will re-validate against the invoice row's
-- state as it stands after acquiring the lock, not a stale
-- pre-cancellation read.
-- ============================================================
create or replace function public.record_payment(p_invoice_id uuid, p_amount numeric, p_method text, p_reference text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid, p_official_receipt_id uuid DEFAULT NULL::uuid)
returns uuid
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
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
  v_booking_field_id uuid;
  v_booking_branch_id uuid;
  v_booking_status text;
  v_effective_policy public.government_collection_policies;
  v_receipt public.official_collection_receipts%rowtype;
  v_receipt_validated boolean := false;
  v_has_custody boolean;
  v_active_shift_id uuid;
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

  -- Lock the invoice row BEFORE re-checking its status and its
  -- originating booking's status, so a concurrent cancel_booking()
  -- (which also locks this same invoice row before voiding it) and
  -- this payment attempt can never both proceed against a state that
  -- becomes stale mid-transaction (Section 14).
  perform 1 from public.invoices where id = p_invoice_id for update;

  -- Re-read status after acquiring the lock -- v_invoice was read
  -- before the lock and could be stale if a concurrent cancellation
  -- won the race.
  select status into v_invoice.status from public.invoices where id = p_invoice_id;

  if v_invoice.status != 'issued' then
    raise exception 'can only record payment against an issued invoice';
  end if;

  -- SP-001 PRIMARY HARD BLOCK: a payment must never be recordable
  -- against an invoice whose originating booking is no longer payable.
  -- Checked here (inside the same lock as the invoice-status check
  -- above), independent of whether the invoice itself was successfully
  -- voided by cancel_booking() -- this is what protects a
  -- partially-paid-then-cancelled invoice (which cancel_booking()
  -- deliberately leaves status='issued' to preserve its paid history)
  -- from accepting any further collection. No UI can bypass this: it
  -- fires for a direct RPC call, the official-receipt path, payment
  -- proof approval, and manual claim verification alike, since all of
  -- them call this function.
  select status into v_booking_status from public.bookings where invoice_id = p_invoice_id limit 1;
  if v_booking_status = 'cancelled' then
    raise exception 'this booking was cancelled -- payment can no longer be recorded against it';
  end if;

  select b.field_id, b.branch_id into v_booking_field_id, v_booking_branch_id
  from public.bookings b where b.invoice_id = p_invoice_id limit 1;

  if v_booking_branch_id is null then
    select g.branch_id into v_booking_branch_id
    from public.subscriptions s
    join public.enrollments e on e.id = s.enrollment_id
    join public.groups g on g.id = e.group_id
    where s.invoice_id = p_invoice_id
    limit 1;
  end if;

  if p_method = 'cash' then
    select coalesce(bool_or(has_cash_custody), false) into v_has_custody
    from public.club_memberships
    where user_id = auth.uid() and club_id = v_invoice.club_id and status = 'active';

    if v_has_custody then
      if v_booking_branch_id is null then
        raise exception 'cash collection requires a branch-scoped booking -- this invoice has none';
      end if;

      select id into v_active_shift_id
      from public.cash_shifts
      where branch_id = v_booking_branch_id and opened_by = auth.uid() and status = 'open';

      if v_active_shift_id is null then
        raise exception 'cash collection requires an active cash shift -- open one before collecting cash';
      end if;
    end if;
  end if;

  v_effective_policy := public.get_effective_government_policy(
    v_invoice.club_id, v_booking_branch_id, v_booking_field_id
  );

  if v_effective_policy.enabled
     and v_effective_policy.official_receipt_required
     and p_method = any(v_effective_policy.required_payment_methods)
  then
    if p_official_receipt_id is null then
      raise exception 'official collection receipt required: this club/field requires an official government collection receipt for % payments' , p_method;
    end if;

    select * into v_receipt from public.official_collection_receipts
    where id = p_official_receipt_id and club_id = v_invoice.club_id and status = 'active';

    if v_receipt is null then
      raise exception 'official collection receipt not found, not active, or does not belong to this club';
    end if;
    v_receipt_validated := true;

    if v_receipt.payment_id is not null then
      raise exception 'this official collection receipt is already linked to a payment';
    end if;

    if v_receipt.receipt_amount != p_amount then
      raise exception 'official collection receipt amount (%) does not match the payment amount (%)', v_receipt.receipt_amount, p_amount;
    end if;
  end if;

  select v_invoice.total
    - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = v_invoice.id), 0)
    + coalesce((select sum(r.amount) from public.payment_allocations pa
                join public.refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
                where pa.invoice_id = v_invoice.id), 0)
  into v_outstanding;

  if p_amount > v_outstanding then
    raise exception 'payment amount (%) exceeds the invoice''s outstanding balance (%)', p_amount, v_outstanding;
  end if;

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by, idempotency_key, cash_shift_id)
  values (v_invoice.club_id, v_invoice.branch_id, v_invoice.customer_id, p_method, p_amount, p_reference, auth.uid(), p_idempotency_key, v_active_shift_id)
  returning id into v_payment_id;

  if v_receipt_validated then
    update public.official_collection_receipts
    set payment_id = v_payment_id, invoice_id = p_invoice_id,
        customer_id = v_invoice.customer_id, updated_at = now()
    where id = p_official_receipt_id;

    perform public.write_audit_log(
      v_invoice.club_id, 'official_collection_receipt.created', 'official_collection_receipt', p_official_receipt_id,
      null,
      jsonb_build_object('payment_id', v_payment_id, 'receipt_serial', v_receipt.receipt_serial, 'amount', p_amount),
      null
    );
  end if;

  perform public.write_audit_log(
    v_invoice.club_id, 'payment.record', 'payment', v_payment_id, null,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'invoice_id', p_invoice_id, 'official_receipt_id', p_official_receipt_id, 'cash_shift_id', v_active_shift_id),
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

      if v_receipt_validated then
        update public.official_collection_receipts
        set booking_id = v_pending_booking_id
        where id = p_official_receipt_id and booking_id is null;
      end if;

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
      'invoice_token', v_invoice_token, 'invoice_id', p_invoice_id,
      'receipt_serial', case when v_receipt_validated then v_receipt.receipt_serial else null end,
      'receipt_book', case when v_receipt_validated then v_receipt.receipt_book else null end,
      'receipt_series', case when v_receipt_validated then v_receipt.receipt_series else null end,
      'receipt_date', case when v_receipt_validated then v_receipt.receipt_date else null end
    ),
    'transactional', 'payment.received:' || v_payment_id::text,
    'document', 'invoice_pdf'
  );

  return v_payment_id;
end;
$$;

revoke execute on function public.record_payment(uuid, numeric, text, text, uuid, uuid) from public;
revoke execute on function public.record_payment(uuid, numeric, text, text, uuid, uuid) from anon;
grant execute on function public.record_payment(uuid, numeric, text, text, uuid, uuid) to authenticated;

comment on function public.record_payment(uuid, numeric, text, text, uuid, uuid) is
  'SP-001 PRIMARY HARD BLOCK: rejects if the invoice''s originating booking has status=cancelled, independent of the invoice''s own status column -- protects a partially/fully-paid-then-cancelled invoice''s remaining balance from further collection without ever touching its paid history. Every payment writer in the system (record_payment_with_official_receipt, approve_payment_proof, verify_manual_payment_claim) converges here, so this single check covers the government-receipt path and the open-cash-shift path too. The invoice-status re-check and the booking-status check both happen AFTER acquiring the invoice row lock, closing the concurrent cancel-vs-pay race.';

-- ============================================================
-- Part 3: defense-in-depth at the two customer-initiated entry points
-- that precede record_payment() -- keeps the staff review queue
-- honest (a cancelled booking's invoice never even shows up as a
-- pending claim/proof to review) rather than relying solely on
-- record_payment() rejecting it later at approval time.
-- ============================================================
create or replace function public.claim_manual_payment(p_invoice_id uuid, p_payment_method_config_id uuid, p_claimed_amount numeric, p_reference text DEFAULT NULL::text, p_proof_note text DEFAULT NULL::text)
returns uuid
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_claim_id uuid;
  v_club_id uuid;
  v_customer_id uuid;
  v_booking_status text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select i.club_id, i.customer_id into v_club_id, v_customer_id
  from public.invoices i
  join public.customers c on c.id = i.customer_id
  where i.id = p_invoice_id and c.user_id = auth.uid();

  if v_club_id is null then
    raise exception 'invoice not found or does not belong to your account';
  end if;

  select status into v_booking_status from public.bookings where invoice_id = p_invoice_id limit 1;
  if v_booking_status = 'cancelled' then
    raise exception 'this booking was cancelled -- payment can no longer be claimed against it';
  end if;

  if p_claimed_amount <= 0 then
    raise exception 'claimed amount must be positive';
  end if;

  insert into public.manual_payment_claims (club_id, invoice_id, payment_method_config_id, claimed_by, claimed_amount, reference, proof_note)
  values (v_club_id, p_invoice_id, p_payment_method_config_id, auth.uid(), p_claimed_amount, p_reference, p_proof_note)
  returning id into v_claim_id;

  return v_claim_id;
end;
$$;

revoke execute on function public.claim_manual_payment(uuid, uuid, numeric, text, text) from public;
revoke execute on function public.claim_manual_payment(uuid, uuid, numeric, text, text) from anon;
grant execute on function public.claim_manual_payment(uuid, uuid, numeric, text, text) to authenticated;

comment on function public.claim_manual_payment(uuid, uuid, numeric, text, text) is
  'SP-001 defense-in-depth: rejects a claim against an invoice whose originating booking is cancelled, so the staff review queue never carries a pending claim for a non-payable booking. The actual money-movement gate remains record_payment(), reached via verify_manual_payment_claim().';

create or replace function public.record_payment_proof_upload(p_booking_id uuid, p_amount numeric, p_storage_path text, p_mime_type text, p_file_size_bytes integer, p_payment_method_config_id uuid DEFAULT NULL::uuid)
returns uuid
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $$
declare
  v_booking record;
  v_proof_id uuid;
  v_expected_prefix text;
begin
  select id, club_id, invoice_id, customer_id, status into v_booking
  from public.bookings where id = p_booking_id;

  if v_booking.id is null then
    raise exception 'booking not found';
  end if;
  if v_booking.status = 'cancelled' then
    raise exception 'this booking was cancelled -- payment proof can no longer be submitted for it';
  end if;
  if v_booking.invoice_id is null then
    raise exception 'this booking has no invoice yet';
  end if;
  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_mime_type not in ('image/jpeg', 'image/png', 'application/pdf') then
    raise exception 'unsupported file type';
  end if;
  if p_file_size_bytes > 10485760 then
    raise exception 'file exceeds the 10MB size limit';
  end if;

  v_expected_prefix := v_booking.club_id::text || '/' || p_booking_id::text || '/';
  if left(p_storage_path, length(v_expected_prefix)) != v_expected_prefix then
    raise exception 'storage path does not match this booking';
  end if;

  insert into public.payment_proofs (club_id, booking_id, invoice_id, customer_id, payment_method_config_id, amount, storage_path, mime_type, file_size_bytes)
  values (v_booking.club_id, p_booking_id, v_booking.invoice_id, v_booking.customer_id, p_payment_method_config_id, p_amount, p_storage_path, p_mime_type, p_file_size_bytes)
  returning id into v_proof_id;

  perform public.write_audit_log(v_booking.club_id, 'payment_proof.upload', 'payment_proof', v_proof_id, null,
    jsonb_build_object('booking_id', p_booking_id, 'amount', p_amount), null);

  perform public.emit_notification_event(v_booking.club_id, 'payment_proof.uploaded', 'payment_proof', v_proof_id,
    jsonb_build_object('booking_id', p_booking_id, 'amount', p_amount));

  return v_proof_id;
end;
$$;

revoke execute on function public.record_payment_proof_upload(uuid, numeric, text, text, integer, uuid) from public;
revoke execute on function public.record_payment_proof_upload(uuid, numeric, text, text, integer, uuid) from anon;
grant execute on function public.record_payment_proof_upload(uuid, numeric, text, text, integer, uuid) to authenticated;

comment on function public.record_payment_proof_upload(uuid, numeric, text, text, integer, uuid) is
  'SP-001 defense-in-depth: rejects a proof upload for a cancelled booking. The actual money-movement gate remains record_payment(), reached via approve_payment_proof().';

-- ============================================================
-- Part 4: retroactive reconciliation for EXISTING production rows
-- (Section 24). Scope is deliberately narrow and safe: only the
-- unpaid-cancelled invoices (paid=0) are voided, using the exact same
-- rule cancel_booking() now applies going forward -- this destroys no
-- financial history because there is none to destroy on these rows (no
-- payment_allocations exist against them). The 4 partially-paid and 20
-- fully-paid cancelled invoices are deliberately left untouched
-- (status stays 'issued', their real paid amounts are preserved
-- exactly as-is) -- their remaining balance (if any) is made
-- non-collectible by record_payment()'s new hard check instead, so no
-- historical row's status or paid amount is rewritten by this
-- migration for the paid cases.
-- ============================================================
do $$
declare
  v_voided_count integer;
begin
  with target_invoices as (
    select i.id
    from public.invoices i
    join public.bookings b on b.invoice_id = i.id
    cross join lateral public.get_invoice_payment_summary(array[i.id]) s
    where b.status = 'cancelled' and i.status = 'issued' and coalesce(s.paid, 0) = 0
  ),
  voided as (
    update public.invoices
    set status = 'void'
    where id in (select id from target_invoices)
    returning id
  )
  select count(*) into v_voided_count from voided;

  raise notice 'SP-001 reconciliation: voided % existing unpaid-cancelled invoice(s)', v_voided_count;
end $$;
