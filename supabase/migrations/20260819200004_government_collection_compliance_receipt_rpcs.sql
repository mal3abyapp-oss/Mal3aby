-- Government / Ministry Collection Compliance -- Receipt lifecycle RPCs
-- (directive sections 17-21, 29-32, 68).

begin;

-- ============================================================
-- record_payment_with_official_receipt -- the primary staff-facing
-- entry point for a government-compliant cash collection.
-- ============================================================
-- Directive section 17-18: BOOKING -> PAYMENT DUE -> CASH RECEIVED ->
-- ENTER OFFICIAL RECEIPT -> VALIDATE -> RECORD PAYMENT -> CONFIRM
-- BOOKING -> UPDATE INVOICE -> WRITE AUDIT, as one atomic operation.
--
-- Design: creates the receipt row FIRST (status will be validated by
-- the unique index at insert time -- Postgres evaluates unique
-- constraints per-statement, so a duplicate serial fails right here,
-- before any payment exists), then calls record_payment() passing the
-- new receipt's id. If record_payment() raises for ANY reason
-- (insufficient balance, wrong invoice status, compliance mismatch,
-- etc.), the whole transaction rolls back INCLUDING the receipt insert
-- -- directive section 18: no orphaned receipt with no payment.
create or replace function public.record_payment_with_official_receipt(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_receipt_serial text,
  p_receipt_date date,
  p_receipt_book text default null,
  p_receipt_series text default null,
  p_receipt_image_path text default null,
  p_notes text default null,
  p_reference text default null,
  p_idempotency_key uuid default null
)
returns table(payment_id uuid, official_receipt_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invoice record;
  v_booking_field_id uuid;
  v_booking_branch_id uuid;
  v_effective_policy public.government_collection_policies;
  v_receipt_id uuid;
  v_payment_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_receipt_serial is null or length(trim(p_receipt_serial)) = 0 then
    raise exception 'receipt serial is required';
  end if;

  if p_receipt_date is null then
    raise exception 'receipt date is required';
  end if;

  -- Directive section 21: reject an obviously-wrong (far-future) date.
  -- Not "today only" -- the directive explicitly allows entering a
  -- receipt date that differs from the payment timestamp -- just
  -- guards against fat-fingered years, etc.
  if p_receipt_date > (current_date + interval '1 day')::date then
    raise exception 'receipt date cannot be in the future';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id;
  if v_invoice is null then
    raise exception 'invoice not found';
  end if;

  if not (v_invoice.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_invoice.club_id)) then
    raise exception 'not authorized';
  end if;

  select b.field_id, b.branch_id into v_booking_field_id, v_booking_branch_id
  from public.bookings b where b.invoice_id = p_invoice_id limit 1;

  v_effective_policy := public.get_effective_government_policy(
    v_invoice.club_id, v_booking_branch_id, v_booking_field_id
  );

  -- Directive section 19: receipt image required only if the
  -- effective policy says so.
  if v_effective_policy.receipt_image_required and p_receipt_image_path is null then
    raise exception 'a receipt image is required by this club/field''s compliance policy';
  end if;

  -- Directive section 20: receipt amount must match the payment
  -- amount -- no unexplained difference allowed in this version.
  insert into public.official_collection_receipts (
    club_id, branch_id, field_id, payment_id, authority_type,
    receipt_book, receipt_series, receipt_serial,
    receipt_date, receipt_amount, payment_method,
    entered_by, receipt_image_path, notes
  ) values (
    v_invoice.club_id, v_booking_branch_id, v_booking_field_id, null,
    v_effective_policy.authority_type,
    p_receipt_book, p_receipt_series, p_receipt_serial,
    p_receipt_date, p_amount, p_method,
    auth.uid(), p_receipt_image_path, p_notes
  )
  returning id into v_receipt_id;
  -- If a duplicate (club, book, series, normalized serial) already
  -- exists and is active, ocr_unique_active_serial_idx raises here --
  -- directive section 13/14 -- before any payment is touched.

  -- record_payment() re-validates everything (invoice status, balance,
  -- compliance requirement, receipt-amount match) independently -- this
  -- function does not duplicate that logic, it only prepares the
  -- receipt and delegates, so there is exactly one source of truth for
  -- the hard block (directive section 68: no parallel financial insert
  -- path).
  v_payment_id := public.record_payment(p_invoice_id, p_amount, p_method, p_reference, p_idempotency_key, v_receipt_id);

  return query select v_payment_id, v_receipt_id;
end;
$function$;

revoke all on function public.record_payment_with_official_receipt(uuid, numeric, text, text, date, text, text, text, text, text, uuid) from public;
revoke all on function public.record_payment_with_official_receipt(uuid, numeric, text, text, date, text, text, text, text, text, uuid) from anon;
grant execute on function public.record_payment_with_official_receipt(uuid, numeric, text, text, date, text, text, text, text, text, uuid) to authenticated;

-- ============================================================
-- reverse_official_receipt -- directive sections 30-32.
-- ============================================================
create or replace function public.reverse_official_receipt(
  p_receipt_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_before public.official_collection_receipts;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to reverse an official collection receipt';
  end if;

  select * into v_before from public.official_collection_receipts where id = p_receipt_id;
  if v_before is null then
    raise exception 'official collection receipt not found';
  end if;

  if not (v_before.club_id in (select public.user_club_ids()) and public.has_permission('payment.refund', v_before.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_before.status != 'active' then
    raise exception 'this receipt is not active';
  end if;

  update public.official_collection_receipts
  set status = 'reversed', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = p_reason, updated_at = now()
  where id = p_receipt_id;

  perform public.write_audit_log(
    v_before.club_id, 'official_collection_receipt.reversed', 'official_collection_receipt', p_receipt_id,
    to_jsonb(v_before),
    jsonb_build_object('status', 'reversed'),
    p_reason
  );
end;
$function$;

revoke all on function public.reverse_official_receipt(uuid, text) from public;
revoke all on function public.reverse_official_receipt(uuid, text) from anon;
grant execute on function public.reverse_official_receipt(uuid, text) to authenticated;

-- ============================================================
-- correct_official_receipt -- directive section 30: never a direct
-- edit, always create-a-new-record-and-link. Reverses the original
-- (freeing its serial slot for the corrected one if needed) and
-- inserts a fresh receipt linked via corrected_from_receipt_id, on the
-- SAME payment.
-- ============================================================
create or replace function public.correct_official_receipt(
  p_original_receipt_id uuid,
  p_new_receipt_serial text,
  p_new_receipt_date date,
  p_new_receipt_book text default null,
  p_new_receipt_series text default null,
  p_new_receipt_image_path text default null,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_original public.official_collection_receipts;
  v_new_id uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to correct an official collection receipt';
  end if;

  if p_new_receipt_serial is null or length(trim(p_new_receipt_serial)) = 0 then
    raise exception 'the corrected receipt serial is required';
  end if;

  select * into v_original from public.official_collection_receipts where id = p_original_receipt_id;
  if v_original is null then
    raise exception 'original official collection receipt not found';
  end if;

  if not (v_original.club_id in (select public.user_club_ids()) and public.has_permission('payment.refund', v_original.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_original.status != 'active' then
    raise exception 'this receipt is not active';
  end if;

  -- Reverse the original first, freeing its serial slot in the unique
  -- index (which only constrains status='active' rows).
  update public.official_collection_receipts
  set status = 'reversed', reversed_by = auth.uid(), reversed_at = now(),
      reversal_reason = 'corrected: ' || p_reason, updated_at = now()
  where id = p_original_receipt_id;

  insert into public.official_collection_receipts (
    club_id, branch_id, field_id, payment_id, booking_id, invoice_id, customer_id,
    authority_type, receipt_book, receipt_series, receipt_serial,
    receipt_date, receipt_amount, payment_method,
    entered_by, receipt_image_path, corrected_from_receipt_id, notes
  ) values (
    v_original.club_id, v_original.branch_id, v_original.field_id, v_original.payment_id,
    v_original.booking_id, v_original.invoice_id, v_original.customer_id,
    v_original.authority_type, p_new_receipt_book, p_new_receipt_series, p_new_receipt_serial,
    p_new_receipt_date, v_original.receipt_amount, v_original.payment_method,
    auth.uid(), coalesce(p_new_receipt_image_path, v_original.receipt_image_path),
    p_original_receipt_id, p_reason
  )
  returning id into v_new_id;

  perform public.write_audit_log(
    v_original.club_id, 'official_collection_receipt.corrected', 'official_collection_receipt', v_new_id,
    to_jsonb(v_original),
    jsonb_build_object('new_receipt_id', v_new_id, 'new_serial', p_new_receipt_serial),
    p_reason
  );

  return v_new_id;
end;
$function$;

revoke all on function public.correct_official_receipt(uuid, text, date, text, text, text, text) from public;
revoke all on function public.correct_official_receipt(uuid, text, date, text, text, text, text) from anon;
grant execute on function public.correct_official_receipt(uuid, text, date, text, text, text, text) to authenticated;

commit;
