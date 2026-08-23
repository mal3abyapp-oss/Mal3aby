-- CUSTOMER ACCOUNT / CLUB PORTAL -- ZERO-COST ACTIVATION: service-role
-- account-creation path (2026-08-23).
--
-- REAL PRODUCTION FINDING that necessitated this migration: the
-- original design had ActivateAccountPage.tsx call client-side
-- supabase.auth.signUp() directly, then claim_portal_invite() (which
-- reads auth.uid() from the resulting session). Live-tested against
-- this hosted project and confirmed via auth.users
-- (email_confirmed_at/confirmation_sent_at) that email confirmation is
-- genuinely enabled here -- contradicting supabase/config.toml's local
-- `enable_confirmations = false`, a live-vs-git drift already known to
-- exist in other areas of this codebase. signUp() therefore attempted
-- to send a confirmation email on every call and repeatedly hit
-- Supabase's built-in outbound-email rate limit; zero rows for any test
-- email ever reached auth.users, meaning the failure blocked account
-- creation entirely, not merely the email delivery.
--
-- Fix, at zero additional cost and without inventing any new auth
-- mechanism (Supabase Auth remains the sole password authority):
-- account creation now happens server-side via a new Edge Function
-- (activate-portal-account) using auth.admin.createUser(...,
-- { email_confirm: true }) -- the exact same pre-confirmed, zero-email
-- pattern this project's own existing QA fixture accounts were already
-- created with (confirmed live: every one of them has
-- confirmation_sent_at IS NULL and confirmed_at set within
-- milliseconds of created_at). That Edge Function needs a way to link
-- the newly created auth user to the invited customer WITHOUT an
-- auth.uid() session existing yet -- this migration adds exactly that,
-- as a service_role-only sibling of claim_portal_invite(), never
-- granted to anon or authenticated.
create or replace function public.claim_portal_invite_service(
  p_raw_token text,
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invite record;
  v_customer record;
begin
  if p_user_id is null then
    raise exception 'user id required';
  end if;

  if p_raw_token is null or length(p_raw_token) < 32 then
    raise exception 'invalid invite link';
  end if;

  select * into v_invite from public.portal_invites
  where token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex')
  for update;

  if v_invite.id is null then
    raise exception 'invalid invite link';
  end if;

  -- Idempotent retry (mirrors claim_portal_invite()'s own guarantee):
  -- if this exact user is already linked via an already-consumed
  -- invite, return the same result rather than erroring.
  if v_invite.status = 'consumed' then
    select id into v_customer from public.customers
    where id = v_invite.customer_id and user_id = p_user_id;
    if v_customer.id is not null then
      return v_customer.id;
    end if;
    raise exception 'this invite has already been used';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'this invite is no longer valid';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'this invite has expired';
  end if;
  if v_invite.phone_verified_at is null then
    raise exception 'phone verification must be completed first';
  end if;

  select * into v_customer from public.customers where id = v_invite.customer_id for update;
  if v_customer.id is null then
    raise exception 'customer not found';
  end if;

  if v_customer.user_id is not null then
    if v_customer.user_id = p_user_id then
      update public.portal_invites set status = 'consumed', consumed_at = now() where id = v_invite.id;
      return v_customer.id;
    end if;
    raise exception 'this customer record is already linked to a different account';
  end if;

  if exists (
    select 1 from public.customers where club_id = v_invite.club_id and user_id = p_user_id
  ) then
    raise exception 'this account is already linked to a customer record in this club';
  end if;

  perform set_config('app.allow_customer_identity_claim', 'true', true);
  update public.customers set user_id = p_user_id where id = v_customer.id;

  update public.portal_invites set status = 'consumed', consumed_at = now() where id = v_invite.id;

  -- write_audit_log() itself calls auth.uid() to stamp actor_id, which
  -- would be NULL for a service_role call with no session -- correct
  -- here: this action was performed by the platform's own activation
  -- pipeline on the new user's behalf, not by an authenticated actor
  -- clicking a button, so a NULL actor accurately reflects that (same
  -- convention already used by _create_booking_internal/
  -- create_public_booking's own audit calls for system-initiated
  -- inserts).
  perform public.write_audit_log(
    v_invite.club_id, 'portal.account_activated', 'customer', v_customer.id, null,
    jsonb_build_object('user_id', p_user_id), null
  );

  return v_customer.id;
end;
$function$;

revoke all on function public.claim_portal_invite_service(text, uuid) from public;
revoke all on function public.claim_portal_invite_service(text, uuid) from anon;
revoke all on function public.claim_portal_invite_service(text, uuid) from authenticated;
grant execute on function public.claim_portal_invite_service(text, uuid) to service_role;
