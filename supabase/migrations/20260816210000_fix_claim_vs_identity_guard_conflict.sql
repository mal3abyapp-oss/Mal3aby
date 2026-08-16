-- Gate 3 bug fix, caught via real black-box RLS testing (a genuine
-- signed-up test auth user, real access token, real REST calls -- not
-- just SQL inspection): claim_customer_self_service() appeared to
-- succeed (returned the customer id, no error) but user_id was never
-- actually persisted.
--
-- Root cause: protect_customer_identity_columns() (added in the prior
-- write-guard migration) fires on EVERY update to public.customers,
-- including the UPDATE inside claim_customer_self_service() itself.
-- That trigger correctly reverts user_id changes made by a caller with
-- no customer.update staff permission -- which is exactly what a
-- self-service claimant is, by definition. So the trigger was silently
-- undoing the very claim it was never meant to block, only the
-- unrelated "customer edits their own photo_url directly" case.
--
-- Fix: use a session-local GUC flag
-- (app.allow_customer_identity_claim) that claim_customer_self_service()
-- sets for the duration of its own transaction only (set_config with
-- is_local=true), and have the trigger skip its user_id-revert check
-- when that flag is set. This keeps the trigger's protection intact
-- for every other write path (direct table UPDATE via RLS, any other
-- future RPC) while allowing the one legitimate, already-authorized
-- code path (the claim RPC, which has its own explicit checks: caller
-- must be authenticated, target row must be currently unclaimed, caller
-- may not already hold a different customer in the same club) to
-- actually take effect.
create or replace function public.protect_customer_identity_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_claim_in_progress boolean;
begin
  v_claim_in_progress := coalesce(current_setting('app.allow_customer_identity_claim', true), 'false') = 'true';

  if not public.has_permission('customer.update', new.club_id) then
    if new.photo_url is distinct from old.photo_url then
      new.photo_url := old.photo_url;
    end if;
    if new.national_id is distinct from old.national_id then
      new.national_id := old.national_id;
    end if;
    if new.full_name is distinct from old.full_name then
      new.full_name := old.full_name;
    end if;
    if new.date_of_birth is distinct from old.date_of_birth then
      new.date_of_birth := old.date_of_birth;
    end if;
    if new.gender is distinct from old.gender then
      new.gender := old.gender;
    end if;
    if new.club_id is distinct from old.club_id then
      new.club_id := old.club_id;
    end if;
    -- user_id is the one column the claim RPC is explicitly allowed to
    -- set even without staff permission -- but ONLY when the trusted
    -- flag is set by that RPC itself, never by a bare UPDATE statement.
    if new.user_id is distinct from old.user_id and not v_claim_in_progress then
      new.user_id := old.user_id;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.claim_customer_self_service(
  p_club_id uuid,
  p_customer_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_customer record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
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

  if exists (
    select 1 from public.customers where club_id = p_club_id and user_id = auth.uid()
  ) then
    raise exception 'this account is already linked to a customer record in this club';
  end if;

  -- is_local=true scopes this to the current transaction only -- it
  -- cannot leak into any other request/connection, and Postgres resets
  -- it automatically at commit/rollback.
  perform set_config('app.allow_customer_identity_claim', 'true', true);

  update public.customers set user_id = auth.uid() where id = p_customer_id;

  perform public.write_audit_log(
    p_club_id, 'customer.self_service_claim', 'customer', p_customer_id, null,
    jsonb_build_object('user_id', auth.uid()),
    null
  );

  return p_customer_id;
end;
$$;
