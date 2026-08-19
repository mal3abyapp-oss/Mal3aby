-- Design/UX audit fix (2026-08-19, Task #19 finding): approve_payment_proof()
-- was called from PendingPaymentsPage.tsx with a hardcoded
-- p_payment_method: 'bank_transfer' on every single approval, regardless of
-- which payment method the customer actually used (InstaPay, a mobile
-- wallet, cash, a card terminal reference, etc.). Every manually-approved
-- payment was being recorded in the club's real financial records as
-- "bank transfer" even when it wasn't -- a genuine data-integrity bug,
-- not a display-only issue, since it corrupts payment-method reporting
-- and reconciliation.
--
-- Fixed at the RPC layer (not just the frontend call site) so this is
-- correct regardless of caller: p_payment_method now defaults to NULL: when
-- the caller doesn't explicitly override it, the function resolves the
-- real underlying_method from the proof's own linked
-- payment_method_config_id (already captured at upload time by
-- record_payment_proof_upload/PaymentProofUpload.tsx) and only falls back
-- to 'bank_transfer' if the proof genuinely has no linked method config
-- (e.g. a receipt uploaded before selecting a specific method card).

create or replace function public.approve_payment_proof(p_proof_id uuid, p_payment_method text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_proof record;
  v_payment_id uuid;
  v_method text;
begin
  select * into v_proof from public.payment_proofs where id = p_proof_id;
  if v_proof.id is null then
    raise exception 'payment proof not found';
  end if;

  if not (v_proof.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_proof.club_id)) then
    raise exception 'not authorized';
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
