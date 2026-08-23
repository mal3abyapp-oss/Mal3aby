-- CUSTOMER ACTIVATION TAKEOVER GAP -- SECURITY CLOSURE (2026-08-23).
--
-- Confirmed by direct schema inspection before writing this migration:
-- `portal_invites` had NO `secret_hash`/independent-secret column --
-- the activation contract was genuinely token + phone only, exactly
-- the residual risk this directive describes (someone who knows the
-- customer's phone number AND obtains the activation URL could
-- activate). This migration adds a THIRD, independent factor: a
-- separately-generated high-entropy secret delivered ONLY inside the
-- WhatsApp message body (never the URL), that the customer must type
-- in manually. All three factors (token possession + phone match +
-- secret match) are now required before any Supabase Auth user is
-- created.
--
-- Design choices, each deliberate:
--   - `secret_hash` stored the same way `token_hash` already is
--     (sha256, raw value never persisted) -- mirrors this codebase's
--     own proven qr_credentials/portal_invites convention exactly.
--   - The secret is NOT derived from the token, customer id, booking
--     id, phone, invoice, or timestamp -- generated from its own
--     independent call to extensions.gen_random_bytes(), so knowing
--     any of those other values gives zero information about the
--     secret.
--   - Human-typeable format (`XXXX-XXXX` from a 32-character alphabet
--     excluding visually-ambiguous characters -- no 0/O, 1/I/L, etc.)
--     rather than a raw hex blob: this is the one factor a real person
--     must accurately copy from a WhatsApp message into a phone
--     keyboard, so entropy-per-character matters for genuine usability,
--     not just cryptographic strength. 8 characters from a 32-symbol
--     alphabet = 40 bits of entropy -- far more than enough to make
--     online guessing infeasible under the existing 5-attempt lockout,
--     which is the actual threat model here (this is not meant to
--     resist offline brute force against a stolen hash the way a
--     password would need to -- it only needs to resist a live guesser
--     who already has the token and the phone, rate-limited to 5 tries).
--   - Attempt counter is SHARED across phone and secret checks (one
--     `verification_attempt_count`, not two independent 5-attempt
--     budgets) -- directive section 7's "bounded attempt counter...
--     generic user-facing error, do not reveal which factor was
--     correct" reads most naturally as one combined ownership-proof
--     budget, and a shared counter is also strictly more conservative
--     (an attacker gets fewer total guesses across both factors
--     combined, not 5+5=10).
--   - `claim_portal_invite_service`/`claim_portal_invite` now require
--     `secret_verified_at IS NOT NULL` in addition to the existing
--     `phone_verified_at IS NOT NULL` check -- auth.admin.createUser()
--     (in the Edge Function) is only ever reached after both.
--   - Pending legacy invites (minted before this migration, which
--     therefore have no secret and could never pass the new
--     verify_portal_invite_secret check) are explicitly revoked below
--     -- confirmed zero such rows existed at apply time (all prior QA
--     test invites had already been cleaned up), so this is a no-op
--     safety net for correctness, not a real-world revocation.
--
-- APPLIED AS TWO STATEMENTS (this file is the consolidated record of
-- both): the return-type change on _mint_portal_invite_internal
-- (text -> table(raw_token, raw_secret)) required DROP FUNCTION before
-- CREATE OR REPLACE could succeed (Postgres does not allow changing a
-- function's return type in place) -- both are included below in the
-- correct order.

drop function if exists public._mint_portal_invite_internal(uuid, uuid, uuid, timestamptz, uuid);
drop function if exists public.send_portal_invite(uuid);

-- ============================================================
-- 1. Schema: independent secret + shared attempt counter.
-- ============================================================
alter table public.portal_invites
  add column if not exists secret_hash text,
  add column if not exists secret_verified_at timestamptz,
  add column if not exists verification_attempt_count int not null default 0;

update public.portal_invites set verification_attempt_count = phone_attempt_count where verification_attempt_count = 0;

comment on column public.portal_invites.secret_hash is
  'sha256 of the independent activation secret, generated separately from token_hash via its own gen_random_bytes() call -- never derivable from the token, customer id, booking id, phone, or timestamp. Delivered to the customer ONLY inside the WhatsApp message body, never in the activation URL. NULL only for legacy pre-security-closure rows (all such rows are revoked by this migration and can never be completed).';
comment on column public.portal_invites.secret_verified_at is
  'Set only when the customer successfully entered the correct activation secret. claim_portal_invite()/claim_portal_invite_service() require this AND phone_verified_at to both be non-null before any auth user is created or linked.';

-- ============================================================
-- 2. Minting: now returns (token, secret) -- two independent raw
--    values, each generated by its own extensions.gen_random_bytes()
--    call so neither can be derived from the other.
-- ============================================================
create or replace function public._mint_portal_invite_internal(
  p_club_id uuid,
  p_customer_id uuid,
  p_triggering_booking_id uuid,
  p_expires_at timestamptz,
  p_created_by uuid
)
returns table(raw_token text, raw_secret text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_raw_token text;
  v_token_hash text;
  v_raw_secret text;
  v_secret_hash text;
  v_secret_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- 32 symbols, excludes 0/O/1/I/L
  v_secret_bytes bytea;
  v_i int;
  v_char text;
begin
  -- Directive section 8/9: resend/re-mint revokes any previous PENDING
  -- invite for this customer, and the fresh row gets both a brand-new
  -- token AND a brand-new secret -- the old raw token and the old raw
  -- secret both become permanently unusable together (verify below
  -- always compares against the CURRENT row's hashes only).
  update public.portal_invites
  set status = 'revoked'
  where customer_id = p_customer_id and status = 'pending';

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  -- Independent secret: its own separate random-byte draw, formatted
  -- as an 8-character human-typeable code (XXXX-XXXX) from a
  -- 32-symbol alphabet -- ~40 bits of entropy, deliberately NOT
  -- derived from v_raw_token or any customer/booking identifier.
  v_secret_bytes := extensions.gen_random_bytes(8);
  v_raw_secret := '';
  for v_i in 0..7 loop
    v_char := substr(v_secret_alphabet, (get_byte(v_secret_bytes, v_i) % 32) + 1, 1);
    v_raw_secret := v_raw_secret || v_char;
    if v_i = 3 then
      v_raw_secret := v_raw_secret || '-';
    end if;
  end loop;
  v_secret_hash := encode(extensions.digest(v_raw_secret, 'sha256'), 'hex');

  insert into public.portal_invites (
    club_id, customer_id, token_hash, secret_hash, expires_at, triggering_booking_id, created_by
  ) values (
    p_club_id, p_customer_id, v_token_hash, v_secret_hash, p_expires_at, p_triggering_booking_id, p_created_by
  );

  return query select v_raw_token, v_raw_secret;
end;
$function$;

revoke all on function public._mint_portal_invite_internal(uuid, uuid, uuid, timestamptz, uuid) from public;
revoke all on function public._mint_portal_invite_internal(uuid, uuid, uuid, timestamptz, uuid) from anon;
grant execute on function public._mint_portal_invite_internal(uuid, uuid, uuid, timestamptz, uuid) to authenticated;
grant execute on function public._mint_portal_invite_internal(uuid, uuid, uuid, timestamptz, uuid) to service_role;

-- ============================================================
-- 3. send_portal_invite: propagate the raw secret up to the caller
--    (staff RPC -- staff relays it into the WhatsApp message exactly
--    like the token; staff never sees a persisted/plaintext copy
--    afterward since only secret_hash is stored). Directive section
--    10 explicit rule: "Do not put the raw secret in any staff-facing
--    UI" -- this RPC returning it to the caller that MINTS it (the
--    same trust boundary that already receives the raw token) is not
--    a UI, and templates.ts is the only consumer that ever turns it
--    into visible text, exactly mirroring how the token already works.
-- ============================================================
create or replace function public.send_portal_invite(
  p_customer_id uuid
)
returns table(raw_token text, raw_secret text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_customer record;
  v_mint record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_customer from public.customers where id = p_customer_id for update;
  if v_customer.id is null then
    raise exception 'customer not found';
  end if;

  if not (v_customer.club_id in (select public.user_club_ids()) and public.has_permission('customer.update', v_customer.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_customer.user_id is not null then
    raise exception 'this customer already has an activated portal account';
  end if;

  if v_customer.phone_e164 is null then
    raise exception 'customer has no valid phone number on file -- add one before sending an activation invite';
  end if;

  if v_customer.duplicate_review_status <> 'none' then
    raise exception 'this customer record is pending duplicate review and cannot be activated yet';
  end if;

  select * into v_mint from public._mint_portal_invite_internal(
    v_customer.club_id, p_customer_id, null, now() + interval '48 hours', auth.uid()
  );

  perform public.write_audit_log(
    v_customer.club_id, 'portal.invite_created', 'customer', p_customer_id, null,
    jsonb_build_object('expires_at', now() + interval '48 hours'), null
  );

  return query select v_mint.raw_token, v_mint.raw_secret;
end;
$function$;

revoke all on function public.send_portal_invite(uuid) from public;
revoke all on function public.send_portal_invite(uuid) from anon;
grant execute on function public.send_portal_invite(uuid) to authenticated;
grant execute on function public.send_portal_invite(uuid) to service_role;

-- ============================================================
-- 4. verify_portal_invite_phone: unchanged contract for the caller,
--    but now increments the SHARED verification_attempt_count (not a
--    phone-only counter) so the total attempt budget across both
--    factors is exactly 5, not 5+5.
-- ============================================================
create or replace function public.verify_portal_invite_phone(
  p_raw_token text,
  p_entered_phone_e164 text
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invite record;
  v_customer record;
begin
  if p_raw_token is null or length(p_raw_token) < 32 then
    raise exception 'invalid invite link';
  end if;

  select * into v_invite from public.portal_invites
  where token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex')
  for update;

  if v_invite.id is null then
    raise exception 'invalid invite link';
  end if;
  if v_invite.status <> 'pending' then
    raise exception 'this invite is no longer valid';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'this invite has expired';
  end if;
  if v_invite.verification_attempt_count >= 5 then
    update public.portal_invites set status = 'revoked' where id = v_invite.id;
    raise exception 'too many attempts -- request a new activation link';
  end if;

  select * into v_customer from public.customers where id = v_invite.customer_id;

  if p_entered_phone_e164 is not null
     and v_customer.phone_e164 is not null
     and p_entered_phone_e164 = v_customer.phone_e164 then
    update public.portal_invites
    set phone_verified_at = now()
    where id = v_invite.id;
    return true;
  end if;

  update public.portal_invites
  set verification_attempt_count = verification_attempt_count + 1
  where id = v_invite.id;

  return false;
end;
$function$;

revoke all on function public.verify_portal_invite_phone(text, text) from public;
grant execute on function public.verify_portal_invite_phone(text, text) to anon;
grant execute on function public.verify_portal_invite_phone(text, text) to authenticated;
grant execute on function public.verify_portal_invite_phone(text, text) to service_role;

-- ============================================================
-- 5. verify_portal_invite_secret: the new independent third factor.
--    Same anon-reachable, generic-failure, shared-attempt-budget
--    pattern as verify_portal_invite_phone -- deliberately identical
--    shape so neither check leaks (via timing, error text, or
--    behavior) which factor was actually being tested.
-- ============================================================
create or replace function public.verify_portal_invite_secret(
  p_raw_token text,
  p_entered_secret text
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invite record;
  v_entered_hash text;
begin
  if p_raw_token is null or length(p_raw_token) < 32 then
    raise exception 'invalid invite link';
  end if;

  select * into v_invite from public.portal_invites
  where token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex')
  for update;

  if v_invite.id is null then
    raise exception 'invalid invite link';
  end if;
  if v_invite.status <> 'pending' then
    raise exception 'this invite is no longer valid';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'this invite has expired';
  end if;
  if v_invite.verification_attempt_count >= 5 then
    update public.portal_invites set status = 'revoked' where id = v_invite.id;
    raise exception 'too many attempts -- request a new activation link';
  end if;

  -- Legacy rows minted before this migration have secret_hash IS NULL
  -- -- can never match any entered value, correctly always fails
  -- (these rows are also explicitly revoked in step 7 below, so this
  -- is defense in depth, not the primary enforcement).
  if p_entered_secret is not null and v_invite.secret_hash is not null then
    v_entered_hash := encode(extensions.digest(upper(trim(p_entered_secret)), 'sha256'), 'hex');
    if v_entered_hash = v_invite.secret_hash then
      update public.portal_invites
      set secret_verified_at = now()
      where id = v_invite.id;
      return true;
    end if;
  end if;

  update public.portal_invites
  set verification_attempt_count = verification_attempt_count + 1
  where id = v_invite.id;

  return false;
end;
$function$;

revoke all on function public.verify_portal_invite_secret(text, text) from public;
grant execute on function public.verify_portal_invite_secret(text, text) to anon;
grant execute on function public.verify_portal_invite_secret(text, text) to authenticated;
grant execute on function public.verify_portal_invite_secret(text, text) to service_role;

-- ============================================================
-- 6. Final-link functions: now require BOTH phone_verified_at AND
--    secret_verified_at before any customer link (and, in the
--    service-role variant, before the Edge Function's
--    auth.admin.createUser() call that precedes it) can succeed.
-- ============================================================
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

-- claim_portal_invite (the authenticated client-callable sibling, used
-- by the pre-existing "already authenticated user claims an invite"
-- code path) gets the identical additional gate for consistency, even
-- though the primary activation flow now goes through the Edge
-- Function + claim_portal_invite_service above.
create or replace function public.claim_portal_invite(p_raw_token text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invite record;
  v_customer record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
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
    where id = v_invite.customer_id and user_id = auth.uid();
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

  select * into v_customer from public.customers where id = v_invite.customer_id for update;
  if v_customer.id is null then
    raise exception 'customer not found';
  end if;

  if v_customer.user_id is not null then
    if v_customer.user_id = auth.uid() then
      update public.portal_invites set status = 'consumed', consumed_at = now() where id = v_invite.id;
      return v_customer.id;
    end if;
    raise exception 'this customer record is already linked to a different account';
  end if;

  if exists (
    select 1 from public.customers where club_id = v_invite.club_id and user_id = auth.uid()
  ) then
    raise exception 'this account is already linked to a customer record in this club';
  end if;

  perform set_config('app.allow_customer_identity_claim', 'true', true);
  update public.customers set user_id = auth.uid() where id = v_customer.id;

  update public.portal_invites set status = 'consumed', consumed_at = now() where id = v_invite.id;

  perform public.write_audit_log(
    v_invite.club_id, 'portal.account_activated', 'customer', v_customer.id, null,
    jsonb_build_object('user_id', auth.uid()), null
  );

  return v_customer.id;
end;
$function$;

revoke all on function public.claim_portal_invite(text) from public;
revoke all on function public.claim_portal_invite(text) from anon;
grant execute on function public.claim_portal_invite(text) to authenticated;
grant execute on function public.claim_portal_invite(text) to service_role;

-- ============================================================
-- 7. Revoke pending legacy invites (minted before this migration --
--    secret_hash IS NULL, could never complete the new contract).
--    Consumed/activated history is completely untouched (this WHERE
--    clause only ever matches status = 'pending').
-- ============================================================
update public.portal_invites
set status = 'revoked'
where status = 'pending' and secret_hash is null;
