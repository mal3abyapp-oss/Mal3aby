-- SP-001 follow-up (small correctness gap in 20260821004237's Part 3):
-- claim_manual_payment() got the new booking-status hard check but never
-- re-checked the invoice's own status column at all -- so a manual-payment
-- claim could still be filed against a voided invoice (the invoice status
-- IS the primary signal for an unpaid-and-cancelled booking; the
-- booking-status check alone only covers the paid-and-cancelled case).
-- record_payment() itself already independently rejects a non-'issued'
-- invoice, so no real money could ever move through this gap -- but the
-- claim would still be silently accepted and sit in the staff review
-- queue for a booking that was never payable in the first place, exactly
-- the confusing-queue problem 20260821004237's own Part 3 comment says it
-- exists to prevent for the booking-status case. Restores the original
-- (pre-20260821004237) invoice-status check alongside the new
-- booking-status check, matching the pattern already used everywhere else
-- in this fix (record_payment, cancel_booking).
--
-- Full body preserved and reapplied here (idempotent CREATE OR REPLACE) so
-- this file is self-contained and readable on its own; no other function
-- from 20260821004237 is touched.

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
  v_invoice_status text;
  v_booking_status text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select i.club_id, i.customer_id, i.status into v_club_id, v_customer_id, v_invoice_status
  from public.invoices i
  join public.customers c on c.id = i.customer_id
  where i.id = p_invoice_id and c.user_id = auth.uid();

  if v_club_id is null then
    raise exception 'invoice not found or does not belong to your account';
  end if;

  if v_invoice_status != 'issued' then
    raise exception 'this invoice is no longer collectible';
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
  'SP-001 defense-in-depth: rejects a claim when the invoice itself is no longer issued (e.g. voided on cancellation) OR when its originating booking is cancelled -- covers both the unpaid-cancelled (void) and paid-cancelled (still issued) cases.';
