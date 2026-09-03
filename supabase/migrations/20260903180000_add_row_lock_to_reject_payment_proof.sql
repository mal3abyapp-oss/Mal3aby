-- Production Audit Remediation, adversarial re-test finding (2026-09-03):
-- independent Phase 9 adversarial re-testing of M-4 (approve_payment_proof
-- row lock) found the sibling reject_payment_proof() was never given the
-- same protection. Its select has no `for update`, and its final UPDATE
-- has no write-time status re-check -- under genuinely concurrent
-- approve+reject calls on the same proof (both initial SELECTs starting
-- before either commits), reject's unlocked read isn't serialized behind
-- approve's lock, so reject could commit `status='rejected'` AFTER
-- approve has already committed `status='approved'` with a real,
-- allocated payment behind it -- a silent last-writer-wins corruption,
-- not a clean no-op. Confirmed via pg_get_functiondef + EXPLAIN (no
-- LockRows node); true concurrent interleaving could not be forced via
-- available tooling to reproduce it live, so this was flagged PLAUSIBLE
-- rather than PROVEN by that adversarial pass -- fixed anyway since the
-- code-level gap and its mechanism are unambiguous and the fix is the
-- same one-line pattern already proven safe for approve_payment_proof.
--
-- Fix: add `for update` (same lock approve_payment_proof already takes,
-- so a concurrent approve+reject pair is now serialized against the
-- same row regardless of which arrives first) and re-check status
-- in the UPDATE's WHERE clause so a stale in-memory read can never
-- overwrite a state that changed between the lock and the write.
create or replace function public.reject_payment_proof(p_proof_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_proof record;
  v_updated int;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a rejection reason is required';
  end if;

  select * into v_proof
  from public.payment_proofs
  where id = p_proof_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('payment.create', club_id)
  for update;

  if v_proof.id is null then
    raise exception 'payment proof not found or you do not have permission to review it';
  end if;

  if v_proof.status != 'pending_review' then
    raise exception 'only a pending proof can be rejected';
  end if;

  update public.payment_proofs
  set status = 'rejected', rejection_reason = p_reason, reviewed_at = now(), reviewed_by = auth.uid()
  where id = p_proof_id
    and status = 'pending_review';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'this proof was already reviewed by someone else -- refresh and try again';
  end if;

  perform public.write_audit_log(v_proof.club_id, 'payment_proof.reject', 'payment_proof', p_proof_id, null,
    jsonb_build_object('reason', p_reason), null);
end;
$$;

-- All 4 signatures unchanged -- in-place replace, grants untouched.
