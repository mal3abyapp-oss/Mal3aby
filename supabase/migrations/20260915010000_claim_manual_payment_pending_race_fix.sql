-- AUDIT ROUND 3 FINDING (2026-09-15): claim_manual_payment() checked for
-- an existing pending claim on the invoice via a plain SELECT (no FOR
-- UPDATE, no backing constraint), then INSERTed a new one -- a classic
-- TOCTOU race. Two concurrent calls (a genuine double-tap on "submit
-- payment proof", or a client retry racing the original request) could
-- both pass the "no pending claim exists" check before either INSERT
-- commits, producing two live 'pending' manual_payment_claims rows for
-- the same invoice -- undermining the "wait for review before
-- resubmitting" invariant the function's own error message promises,
-- and creating duplicate review-queue work (or worse, duplicate
-- claimed_amount if both were later independently verified).
--
-- Fix: a partial unique index is the correct primitive here, not a
-- tighter advisory lock -- it makes the invariant structurally true at
-- the database level regardless of which code path inserts a row (this
-- function today, or any future one), rather than narrowing a race
-- window that could reopen if the function is ever touched again
-- without remembering to re-add a lock. The function is updated to
-- catch the resulting unique_violation and raise the SAME
-- already-relied-upon error message the frontend already handles (see
-- src/features/portal/PortalPaymentsPage.tsx and
-- src/features/finance/FinancePaymentsPage.tsx's translateSupabaseError
-- usage) -- so no frontend change is required, only the race itself is
-- closed.
create unique index if not exists manual_payment_claims_one_pending_per_invoice
  on public.manual_payment_claims (invoice_id)
  where status = 'pending';

create or replace function public.claim_manual_payment(p_invoice_id uuid, p_payment_method_config_id uuid, p_claimed_amount numeric, p_reference text DEFAULT NULL::text, p_proof_note text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid)
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
  v_existing_replay_id uuid;
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

  if p_idempotency_key is not null then
    select id into v_existing_replay_id from public.manual_payment_claims
    where invoice_id = p_invoice_id and idempotency_key = p_idempotency_key;

    if v_existing_replay_id is not null then
      return v_existing_replay_id;
    end if;
  end if;

  if v_invoice_status != 'issued' then
    raise exception 'this invoice is no longer collectible';
  end if;

  select status into v_booking_status from public.bookings where invoice_id = p_invoice_id limit 1;
  if v_booking_status in ('cancelled', 'no_show') then
    raise exception 'this booking was % -- payment can no longer be claimed against it', v_booking_status;
  end if;

  if p_claimed_amount <= 0 then
    raise exception 'claimed amount must be positive';
  end if;

  -- Kept as a fast-path pre-check (avoids a wasted round trip to the
  -- unique-violation path in the common non-racing case), but this is
  -- now advisory only -- manual_payment_claims_one_pending_per_invoice
  -- above is what actually enforces the invariant under concurrency.
  select id into v_existing_pending_id
  from public.manual_payment_claims
  where invoice_id = p_invoice_id and status = 'pending'
  limit 1;

  if v_existing_pending_id is not null then
    raise exception 'a payment claim for this invoice is already pending review -- please wait for it to be reviewed before submitting another';
  end if;

  begin
    insert into public.manual_payment_claims (club_id, invoice_id, payment_method_config_id, claimed_by, claimed_amount, reference, proof_note, idempotency_key)
    values (v_club_id, p_invoice_id, p_payment_method_config_id, auth.uid(), p_claimed_amount, p_reference, p_proof_note, p_idempotency_key)
    returning id into v_claim_id;
  exception when unique_violation then
    -- The race: another concurrent call's INSERT committed between
    -- this function's own pre-check above and its INSERT. Same
    -- user-facing message as the pre-check branch, since from the
    -- caller's perspective the outcome is identical.
    raise exception 'a payment claim for this invoice is already pending review -- please wait for it to be reviewed before submitting another';
  end;

  return v_claim_id;
end;
$function$;

comment on function public.claim_manual_payment(uuid, uuid, numeric, text, text, uuid) is
  'Customer self-service manual payment claim. Idempotent per (invoice_id, idempotency_key) replay. At most one pending claim per invoice is enforced by manual_payment_claims_one_pending_per_invoice (a partial unique index, not just an application-level check) -- a concurrent double-submit now raises the same friendly error instead of racing past the pre-check.';

-- AUDIT ROUND 3 FINDING (2026-09-15), second issue found while fixing
-- the race above: every prior migration touching this function
-- explicitly revoked EXECUTE from public/anon and granted only to
-- authenticated -- but that revoke always targeted the 5-argument
-- signature (uuid, uuid, numeric, text, text). When
-- 20260829260000_platform_owner_findings_pf1_pf3_and_claim_manual_
-- payment_idempotency.sql added p_idempotency_key, the resulting
-- 6-argument signature is a DISTINCT function identity in Postgres --
-- it never inherited the earlier revoke, and (being function-owner-
-- created) defaulted back to PUBLIC EXECUTE, live since Aug 29. The
-- function's own `auth.uid() is null` check still blocks an anonymous
-- caller from actually creating a claim (this is defense-in-depth
-- hardening, not a fix for an exploitable bypass), but a SECURITY
-- DEFINER function should never be reachable by anon/public as a
-- matter of policy -- matching every other write RPC in this
-- codebase.
revoke execute on function public.claim_manual_payment(uuid, uuid, numeric, text, text, uuid) from public;
revoke execute on function public.claim_manual_payment(uuid, uuid, numeric, text, text, uuid) from anon;
grant execute on function public.claim_manual_payment(uuid, uuid, numeric, text, text, uuid) to authenticated;
