-- FIX M-4 (production audit): approve_payment_proof() was missing a
-- row lock on its payment_proofs select, unlike its sibling
-- verify_manual_payment_claim() in the same original migration
-- (20260824330000_close_financial_oracles_batch_a1.sql), which
-- correctly locks the row with `for update` before its status check.
--
-- RACE WINDOW (before this fix): two concurrent approve_payment_proof()
-- calls for the SAME proof id could both read status='pending_review'
-- (or whatever pre-approval status) before either writes, both pass
-- the `if v_proof.status = 'approved' then return ... end if` check,
-- and both proceed to call record_payment(..., p_idempotency_key =>
-- p_proof_id). record_payment()'s own idempotency pre-check
-- (`select id from payments where club_id = ... and idempotency_key
-- = ...`) is itself just a plain SELECT with no lock, so both
-- concurrent calls can also both miss each other there and both
-- attempt the INSERT. The partial unique index
-- payments_club_idempotency_key_unique (added in
-- 20260829260000_platform_owner_findings_pf1_pf3_and_claim_manual_
-- payment_idempotency.sql) then turns the second INSERT into a hard
-- unique_violation instead of a silent duplicate payment -- so the
-- race was already mitigated against data corruption, but it
-- surfaced to the caller as a raw, ungraceful Postgres exception
-- instead of the idempotent "already processed" outcome the caller
-- actually wants.
--
-- FIX: add `for update` to the payment_proofs select, exactly
-- mirroring verify_manual_payment_claim()'s existing pattern in the
-- same file -- lock acquired in the same SELECT that loads the row,
-- BEFORE the status re-check runs. This serializes concurrent
-- approve_payment_proof() calls against the same proof id: the
-- second call blocks until the first commits, then re-reads the
-- now-'approved' status and takes the existing early-return path
-- (`if v_proof.status = 'approved' then return v_proof.
-- resulting_payment_id; end if`) instead of racing into
-- record_payment() at all. This closes the race at its source,
-- so the idempotency-key unique_violation described above is no
-- longer reachable through this function's normal call path.
--
-- No other logic changes -- every downstream check (already-
-- approved idempotent-return, already-rejected block, payment-method
-- resolution, record_payment call, audit log) is preserved verbatim
-- from the current live definition (re-read via pg_get_functiondef
-- immediately before writing this migration; last redefined in
-- 20260824330000_close_financial_oracles_batch_a1.sql, untouched by
-- any migration since).
--
-- SCOPE NOTE on graceful unique_violation handling: this codebase's
-- existing unique_violation-catch convention (see e.g.
-- settle_employee_cash_liability in
-- 20260824340000_close_financial_oracles_batch_a2.sql, or the
-- automatic_trial_entitlements inserts in the onboarding migrations)
-- always wraps a DIRECT `insert` statement in the SAME function.
-- approve_payment_proof() never inserts into payments directly -- it
-- delegates to record_payment(), so a unique_violation from the
-- idempotency index would originate INSIDE that nested call, not
-- from an insert visible here. No existing convention in this
-- codebase catches a unique_violation raised inside a called
-- function from the caller's side, so wrapping the record_payment()
-- call in begin/exception here would be inventing a new pattern
-- rather than mirroring an established one. Per scope, this
-- migration adds only the row lock (which also closes the race that
-- made the unique_violation reachable in the first place); it does
-- not add new exception handling.

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
    and public.has_permission('payment.create', club_id)
  for update;

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

-- Signature unchanged -- in-place replace, grants untouched.
