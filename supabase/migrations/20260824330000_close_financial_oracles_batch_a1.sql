-- SYSTEMIC CROSS-TENANT EXISTENCE-ORACLE CLOSURE -- Batch A1
-- (Financial integrity, part 1 of 4): void_invoice, verify_manual_
-- payment_claim, approve_payment_proof, reject_payment_proof.
--
-- Each of these looked up its target row by a bare `where id = p_id`
-- and raised a DISTINCT "not found"-shaped exception BEFORE checking
-- has_permission(...)/user_club_ids() (which raises a DIFFERENT "not
-- authorized" exception) -- letting an authenticated staff member of
-- ANY club distinguish "this id exists somewhere" from "it doesn't",
-- for ANY invoice/claim/proof uuid system-wide, purely from the error
-- message. Same class and same fix shape as the already-fixed
-- record_payment()/create_refund() (2026-08-24, prior commit).
--
-- LIVE-PROVEN before this fix (real Coach account, member of exactly
-- one club, real foreign-existing-id vs real-nonexistent-id pairs):
--   void_invoice: 'not authorized' vs 'invoice not found' -- DISTINGUISHABLE
--   verify_manual_payment_claim: 'not authorized' vs 'claim not found' -- DISTINGUISHABLE
--   approve_payment_proof: 'not authorized' vs 'payment proof not found' -- DISTINGUISHABLE
--   reject_payment_proof: 'not authorized' vs 'payment proof not found' -- DISTINGUISHABLE
--
-- FIX: collapse lookup + club/permission check into one WHERE clause
-- per function, so both failure paths raise the identical message.
-- No other logic changes -- every downstream check (voidable-state,
-- claim-status, proof-status/idempotent-approve-replay, rejection-
-- reason-required) is preserved verbatim from the current live
-- definitions (re-read live via pg_get_functiondef immediately before
-- writing this migration).

create or replace function public.void_invoice(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a void reason is required';
  end if;

  select club_id into v_club_id
  from public.invoices
  where id = p_invoice_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('invoice.update', club_id);

  if v_club_id is null then
    raise exception 'invoice not found or you do not have permission to void it';
  end if;

  update public.invoices set status = 'void' where id = p_invoice_id and status = 'issued';

  if not found then
    raise exception 'invoice not found or not in a voidable state';
  end if;

  perform public.write_audit_log(v_club_id, 'void_invoice', 'invoices', p_invoice_id, null, jsonb_build_object('status', 'void'), p_reason);
end;
$$;

create or replace function public.verify_manual_payment_claim(p_claim_id uuid, p_approve boolean, p_reason text default null::text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_claim record;
  v_underlying_method text;
  v_payment_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_claim
  from public.manual_payment_claims
  where id = p_claim_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('payment.verify', club_id)
  for update;

  if v_claim.id is null then
    raise exception 'claim not found or you do not have permission to review it';
  end if;

  if v_claim.status != 'pending' then
    raise exception 'this claim has already been reviewed';
  end if;

  if p_approve then
    select underlying_method into v_underlying_method
    from public.payment_method_configs where id = v_claim.payment_method_config_id;

    v_payment_id := public.record_payment(
      v_claim.invoice_id,
      v_claim.claimed_amount,
      coalesce(v_underlying_method, 'other'),
      v_claim.reference
    );
  end if;

  update public.manual_payment_claims
  set status = case when p_approve then 'verified' else 'rejected' end,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_reason = p_reason,
      resulting_payment_id = v_payment_id
  where id = p_claim_id;

  perform public.write_audit_log(
    v_claim.club_id,
    case when p_approve then 'manual_payment_claim.verify' else 'manual_payment_claim.reject' end,
    'manual_payment_claim', p_claim_id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('claimed_amount', v_claim.claimed_amount, 'payment_id', v_payment_id),
    p_reason
  );

  return v_payment_id;
end;
$$;

create or replace function public.approve_payment_proof(p_proof_id uuid, p_payment_method text default null::text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_proof record;
  v_payment_id uuid;
  v_method text;
begin
  select * into v_proof
  from public.payment_proofs
  where id = p_proof_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('payment.create', club_id);

  if v_proof.id is null then
    raise exception 'payment proof not found or you do not have permission to review it';
  end if;

  if v_proof.status = 'approved' then
    return v_proof.resulting_payment_id;
  end if;
  if v_proof.status = 'rejected' then
    raise exception 'this proof was already rejected -- ask the customer to submit a new one if needed';
  end if;

  v_method := p_payment_method;
  if v_method is null and v_proof.payment_method_config_id is not null then
    select underlying_method into v_method
    from public.payment_method_configs
    where id = v_proof.payment_method_config_id;
  end if;
  v_method := coalesce(v_method, 'bank_transfer');

  v_payment_id := public.record_payment(v_proof.invoice_id, v_proof.amount, v_method, 'proof:' || p_proof_id::text, p_proof_id);

  update public.payment_proofs
  set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid(), resulting_payment_id = v_payment_id
  where id = p_proof_id;

  perform public.write_audit_log(v_proof.club_id, 'payment_proof.approve', 'payment_proof', p_proof_id, null,
    jsonb_build_object('payment_id', v_payment_id, 'amount', v_proof.amount, 'method', v_method), null);

  return v_payment_id;
end;
$$;

create or replace function public.reject_payment_proof(p_proof_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_proof record;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a rejection reason is required';
  end if;

  select * into v_proof
  from public.payment_proofs
  where id = p_proof_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('payment.create', club_id);

  if v_proof.id is null then
    raise exception 'payment proof not found or you do not have permission to review it';
  end if;

  if v_proof.status != 'pending_review' then
    raise exception 'only a pending proof can be rejected';
  end if;

  update public.payment_proofs
  set status = 'rejected', rejection_reason = p_reason, reviewed_at = now(), reviewed_by = auth.uid()
  where id = p_proof_id;

  perform public.write_audit_log(v_proof.club_id, 'payment_proof.reject', 'payment_proof', p_proof_id, null,
    jsonb_build_object('reason', p_reason), null);
end;
$$;

-- All 4 signatures unchanged -- in-place replace, grants untouched.
