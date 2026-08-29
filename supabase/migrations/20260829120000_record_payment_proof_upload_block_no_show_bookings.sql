-- ZERO-TRUST ANTI-FRAUD HARDENING -- ACCEPTANCE GAP CLOSURE (2026-08-29)
--
-- Third real instance of the CF-2/SP-001 pattern, found during the
-- storage/webhook re-verification pass: record_payment_proof_upload()
-- (the anon-reachable RPC backing PaymentProofUpload.tsx's public
-- "upload a payment proof" flow) blocks 'cancelled' bookings but not
-- 'no_show' ones -- the exact same gap already fixed this pass in
-- record_payment() and claim_manual_payment().
--
-- Live-confirmed: the same 3 real production bookings with
-- status='no_show' and an issued invoice (already identified and
-- documented in the record_payment()/claim_manual_payment() fixes)
-- would still accept a submitted payment_proofs row today.
--
-- Impact is lower than the other two surfaces -- approve_payment_proof()
-- calls record_payment() internally, which ALREADY correctly rejects a
-- no_show booking's invoice (fixed earlier this pass), so this could
-- never actually result in a posted payment. But it still lets an
-- attacker plant a fraudulent pending proof in a club's review queue
-- for a booking the customer never attended -- wasted staff review
-- time, potential social-engineering pressure ("I definitely paid,
-- please approve it"), and inconsistent behavior vs. the two sibling
-- RPCs. Closed here for defense-in-depth and consistency.
--
-- Fix: identical shape -- widen the single 'cancelled' check to also
-- cover 'no_show'. No new architecture, no return-shape change.

create or replace function public.record_payment_proof_upload(p_booking_id uuid, p_amount numeric, p_storage_path text, p_mime_type text, p_file_size_bytes integer, p_payment_method_config_id uuid DEFAULT NULL::uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
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
  if v_booking.invoice_id is null then
    raise exception 'this booking has no invoice yet';
  end if;
  -- FIX (this pass): widened from 'cancelled' only to also cover
  -- 'no_show', matching record_payment()/claim_manual_payment()'s
  -- same-pass fix.
  if v_booking.status in ('cancelled', 'no_show') then
    raise exception 'this booking was % -- its invoice is no longer collectible', v_booking.status;
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
$function$;
