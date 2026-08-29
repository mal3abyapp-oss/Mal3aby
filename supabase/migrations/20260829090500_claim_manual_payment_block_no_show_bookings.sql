-- ZERO-TRUST ANTI-FRAUD HARDENING -- Phase 9 continued (2026-08-29)
--
-- Same gap as record_payment() (previous migration this pass):
-- claim_manual_payment() -- the Customer Portal's own "I paid, please
-- verify" claim RPC, directly callable by any customer against their
-- own invoice -- blocks 'cancelled' bookings but not 'no_show' ones.
-- This is actually the MORE severe of the two surfaces: it is
-- self-service (no staff involvement to submit the claim) and is
-- exactly the "Customer Portal still opens a real 'Pay invoice'
-- workflow for it" half of the original SP-001 finding.
--
-- Fix: identical shape to the record_payment() fix -- widen the single
-- 'cancelled' check to also cover 'no_show'. No new architecture.
--
-- Return shape unchanged (returns uuid) -- CREATE OR REPLACE is safe.

create or replace function public.claim_manual_payment(p_invoice_id uuid, p_payment_method_config_id uuid, p_claimed_amount numeric, p_reference text DEFAULT NULL::text, p_proof_note text DEFAULT NULL::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_claim_id uuid;
  v_club_id uuid;
  v_customer_id uuid;
  v_invoice_status text;
  v_booking_status text;
  v_existing_pending_id uuid;
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
  -- FIX (this pass): widened from 'cancelled' only to also cover
  -- 'no_show', matching record_payment()'s same-pass fix.
  if v_booking_status in ('cancelled', 'no_show') then
    raise exception 'this booking was % -- payment can no longer be claimed against it', v_booking_status;
  end if;

  if p_claimed_amount <= 0 then
    raise exception 'claimed amount must be positive';
  end if;

  select id into v_existing_pending_id
  from public.manual_payment_claims
  where invoice_id = p_invoice_id and status = 'pending'
  limit 1;

  if v_existing_pending_id is not null then
    raise exception 'a payment claim for this invoice is already pending review -- please wait for it to be reviewed before submitting another';
  end if;

  insert into public.manual_payment_claims (club_id, invoice_id, payment_method_config_id, claimed_by, claimed_amount, reference, proof_note)
  values (v_club_id, p_invoice_id, p_payment_method_config_id, auth.uid(), p_claimed_amount, p_reference, p_proof_note)
  returning id into v_claim_id;

  return v_claim_id;
end;
$function$;
