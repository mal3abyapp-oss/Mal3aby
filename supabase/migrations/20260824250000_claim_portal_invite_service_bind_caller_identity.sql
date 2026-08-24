-- SECURITY FIX: claim_portal_invite_service() must not trust an
-- arbitrary caller-supplied p_user_id (2026-08-24).
--
-- CONFIRMED FINDING (adversarially reproduced live against
-- gxkrtlvpjwxhcqdisyob with QA-marked fixtures, then independently
-- re-reproduced end-to-end a second time): claim_portal_invite_service
-- (introduced in 20260823080000_activation_independent_secret_factor.sql)
-- accepts p_user_id with zero binding to the identity that actually
-- completed phone+secret verification on the invite. Both
-- verify_portal_invite_phone/verify_portal_invite_secret only stamp
-- phone_verified_at/secret_verified_at timestamps on the invite row --
-- neither records which identity performed the verification (there is
-- no auth identity yet at that point in the pre-account-creation flow).
-- The function's only real-world caller is the activate-portal-account
-- Edge Function, which always passes the id it just created two lines
-- above via auth.admin.createUser() -- but the RPC itself enforces
-- nothing that requires this to be true. The function is service_role
-- only (never granted to anon/authenticated), so this is not reachable
-- by an external client today; it is a genuine defense-in-depth gap in
-- the RPC's own invariants, not a currently customer-facing exploit.
--
-- FIX: bind p_user_id to the invariant its one legitimate caller
-- actually upholds -- the auth user must be BOTH (a) real and (b) freshly
-- created, within a short window of "right now", and not already the
-- product of an older signup. The Edge Function always creates the auth
-- user and calls this RPC within the same request/millisecond window;
-- no legitimate call can ever present a user id older than that. An
-- attacker who obtained service_role credentials could still pass an id
-- from another *freshly created* user, but that no longer lets them
-- silently take over an arbitrary EXISTING account (the actual takeover
-- scenario the live reproduction demonstrated with a real pre-existing
-- platform_owner fixture) -- the check below specifically closes that
-- "reuse an existing, unrelated identity" path while adding zero new
-- tables, columns, dependencies, or business-policy judgment calls.
--
-- Exact signature preserved (confirmed via pg_proc against the live
-- project before writing this migration):
--   public.claim_portal_invite_service(p_raw_token text, p_user_id uuid)
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
  v_user_created_at timestamptz;
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
  if v_invite.secret_verified_at is null then
    raise exception 'activation code verification must be completed first';
  end if;

  -- IDENTITY BINDING CHECK (the fix): this RPC's sole legitimate caller
  -- (activate-portal-account Edge Function) always creates the auth user
  -- via auth.admin.createUser() and calls this RPC immediately
  -- afterwards, in the same request. A p_user_id belonging to any
  -- pre-existing account (the exact mechanism the live reproduction
  -- exploited with an unrelated platform_owner fixture) is therefore
  -- always older than this narrow freshness window and gets rejected
  -- here, closing the "claim an arbitrary unrelated identity" path
  -- without requiring any change to the pre-account-creation flow this
  -- function necessarily runs in.
  select created_at into v_user_created_at from auth.users where id = p_user_id;
  if v_user_created_at is null then
    raise exception 'invalid account';
  end if;
  if v_user_created_at < now() - interval '5 minutes' then
    raise exception 'this account cannot be linked to this invite';
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

comment on function public.claim_portal_invite_service(text, uuid) is
  'service_role-only sibling of claim_portal_invite() used by the activate-portal-account Edge Function before any session exists for the brand-new user. Requires phone_verified_at AND secret_verified_at on the invite, AND now requires p_user_id to reference an auth.users row created within the last 5 minutes -- binding the call to the identity the Edge Function itself just created moments earlier, rather than trusting an arbitrary caller-supplied user id.';
