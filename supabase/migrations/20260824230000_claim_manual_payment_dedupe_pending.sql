-- Security fix (directive sections 9/10/11/35): claim_manual_payment()
-- allowed unlimited duplicate pending claims against the same invoice.
--
-- Confirmed live via pg_get_functiondef on project gxkrtlvpjwxhcqdisyob:
-- the function's only checks were auth.uid() presence, invoice
-- ownership, invoice.status = 'issued', booking.status != 'cancelled',
-- and claimed_amount > 0 -- then an unconditional INSERT. There is no
-- unique constraint on manual_payment_claims (only the pkey index) and
-- no trigger on the table, so a customer could spam near-identical
-- manual payment claims against the same invoice, polluting the staff
-- review queue and creating reconciliation ambiguity (which claim is
-- "the real one"?), relying entirely on record_payment()'s downstream
-- overpayment guard as the only backstop -- no defense-in-depth at the
-- claim-submission layer itself.
--
-- Fix: before inserting, block a new claim while a 'pending' claim
-- already exists for the same invoice. This is a hard "one open claim
-- per invoice at a time" rule -- simpler and more robust than a
-- same-amount/same-reference/time-window heuristic, and it still lets
-- a customer file a new claim once staff has reviewed (verified or
-- rejected) the existing one. Full body preserved and reapplied here
-- (idempotent CREATE OR REPLACE, exact existing signature) so this
-- file is self-contained; no other function is touched.

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
  if v_booking_status = 'cancelled' then
    raise exception 'this booking was cancelled -- payment can no longer be claimed against it';
  end if;

  if p_claimed_amount <= 0 then
    raise exception 'claimed amount must be positive';
  end if;

  -- Defense-in-depth: refuse a new claim while one is still pending
  -- review for this invoice, instead of silently accepting an
  -- unbounded number of duplicate rows into the staff review queue.
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
$$;

revoke execute on function public.claim_manual_payment(uuid, uuid, numeric, text, text) from public;
revoke execute on function public.claim_manual_payment(uuid, uuid, numeric, text, text) from anon;
grant execute on function public.claim_manual_payment(uuid, uuid, numeric, text, text) to authenticated;

comment on function public.claim_manual_payment(uuid, uuid, numeric, text, text) is
  'SP-001 defense-in-depth (invoice-status/booking-status checks) plus duplicate-claim guard: rejects a new claim while a pending claim already exists for the same invoice, closing the unlimited-duplicate-submission gap at the submission layer itself rather than relying solely on record_payment()''s downstream overpayment guard.';
