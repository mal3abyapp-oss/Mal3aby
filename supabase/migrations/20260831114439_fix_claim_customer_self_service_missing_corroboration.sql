-- AUTH/ONBOARDING/RECOVERY ACCEPTANCE (2026-08-31) Section 18/19: P0
-- SECURITY FIX -- claim_customer_self_service() never independently
-- verified the phone-number corroboration its own doc comment and the
-- frontend's UX promise both describe. find_claimable_customer() (the
-- lookup step) correctly matches by normalized_mobile, but the actual
-- claiming RPC took only p_customer_id and performed NO corroboration
-- check of its own -- it trusted that a caller could only ever reach
-- it after passing through the phone-lookup step in the UI.
--
-- Live-reproduced: a freshly created, completely unrelated auth
-- identity with ZERO knowledge of the target customer's phone number
-- called claim_customer_self_service(club_id, customer_id) directly
-- with a customer_id read straight from a database query -- and
-- successfully took ownership of a real customer record carrying 21
-- real historical bookings and 21 real invoices. This is a genuine
-- account/data-takeover vulnerability: any customer_id learned or
-- guessed through ANY channel (a URL, a leaked ID, sequential
-- enumeration if UUIDs were ever predictable, a screenshot, a shared
-- link) is enough to seize a stranger's entire booking/financial
-- history, bypassing the phone check the UI and doc comments both
-- describe as the actual security boundary.
--
-- Fix: claim_customer_self_service now takes p_normalized_mobile and
-- re-verifies it against the target customer's own normalized_mobile
-- server-side, using the exact same match condition
-- find_claimable_customer already uses -- the RPC is now
-- self-sufficient and secure regardless of caller behavior, not
-- reliant on the frontend calling find_claimable_customer first. A
-- customer with no phone on file (normalized_mobile is null) can
-- never be claimed via this path at all (there is no corroboration
-- value to check against), which is the safe default -- staff-side
-- claiming/linking, if ever needed for such a record, is a distinct,
-- already-permissioned path (upsert_customer's p_customer_id branch),
-- not this self-service one.

create or replace function public.claim_customer_self_service(
  p_club_id uuid,
  p_customer_id uuid,
  p_normalized_mobile text
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_customer record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_normalized_mobile is null or length(p_normalized_mobile) < 6 then
    raise exception 'invalid mobile number';
  end if;

  select * into v_customer from public.customers
  where id = p_customer_id and club_id = p_club_id
  for update;

  if v_customer.id is null then
    raise exception 'customer not found';
  end if;

  if v_customer.user_id is not null then
    if v_customer.user_id = auth.uid() then
      return v_customer.id;
    end if;
    raise exception 'this customer record is already linked to a different account';
  end if;

  -- The actual security boundary: re-verify the same corroboration
  -- find_claimable_customer() already checks, independently of
  -- whether the caller actually went through that lookup step.
  if v_customer.normalized_mobile is null or v_customer.normalized_mobile != p_normalized_mobile then
    raise exception 'customer not found';
  end if;

  if exists (
    select 1 from public.customers where club_id = p_club_id and user_id = auth.uid()
  ) then
    raise exception 'this account is already linked to a customer record in this club';
  end if;

  perform set_config('app.allow_customer_identity_claim', 'true', true);

  update public.customers set user_id = auth.uid() where id = p_customer_id;

  perform public.write_audit_log(
    p_club_id, 'customer.self_service_claim', 'customer', p_customer_id, null,
    jsonb_build_object('user_id', auth.uid()),
    null
  );

  return p_customer_id;
end;
$function$;
