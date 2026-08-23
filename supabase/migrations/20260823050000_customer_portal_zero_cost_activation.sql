-- CUSTOMER ACCOUNT / CLUB PORTAL -- ZERO-COST ACTIVATION (2026-08-23).
--
-- ARCHITECTURE DECISION, confirmed by a full read-only audit before
-- writing a single line here (a dedicated database-reviewer agent
-- audited auth, customers, guardian_links, RLS, secure-link/QR
-- conventions, and the existing /portal frontend in full -- see
-- .claude/agent-memory-local/database-reviewer/ for the saved
-- detail). Headline finding: most of this system already exists.
-- `customers.user_id`, a full self-service RLS layer keyed on
-- `customers.user_id = auth.uid()`, `/portal/*` routes, and
-- `claim_customer_self_service()` (an ALREADY-AUTHENTICATED user
-- claiming a club's customer record) are all live. NONE of that is
-- rebuilt here.
--
-- What's genuinely new, per the explicit amendment: a customer with
-- NO auth account yet must be able to prove they are the real person
-- behind an existing staff-created customer record, using only
-- (a) a secure link delivered via the existing WhatsApp connector and
-- (b) confirmation of their own registered phone number -- zero paid
-- SMS/WhatsApp-OTP/third-party provider. Only after that two-factor
-- proof does the customer choose their own email+password, and
-- Supabase Auth (already the sole auth authority in this app) issues
-- the real session. This is architecturally a NEW capability
-- (`claim_customer_self_service` requires an auth.uid() that doesn't
-- exist yet at this point in the flow), not a variant of the existing
-- RPC -- but it converges on the exact same `customers.user_id` link
-- column and the exact same self-service RLS layer once done, so the
-- rest of the portal needs zero changes to consume it.
--
-- Token pattern deliberately mirrors qr_credentials (already proven
-- correct this session): hash-at-rest, raw token only ever handed to
-- the client, single-use, expiring, purpose-scoped. A brand-new table
-- rather than reusing qr_credentials -- portal_invites carries a
-- fundamentally different lifecycle (a phone-verification step
-- in the middle, no "scan to check in" semantics) and mixing them
-- would make qr_credentials' own contract (already relied upon by
-- ensure_booking_qr/qr_confirm_checkin) harder to reason about.

-- ============================================================
-- 1. Multi-club identity fix (amendment section 18-19, decision A):
--    one Supabase Auth identity -> multiple club-scoped canonical
--    Customer rows ("My Clubs"). The live unique index was
--    `(user_id) WHERE user_id IS NOT NULL` -- NO club_id in the key,
--    meaning one auth.users row could link to at most ONE customers
--    row across the entire platform, contradicting both this
--    amendment's explicit target and PortalProfilePage.tsx's own
--    existing (until now dead) multi-club selector UI branch. Widened
--    to (club_id, user_id) -- an auth user can now hold at most one
--    linked customer PER CLUB, but may legitimately link to several
--    clubs. This is the only genuine schema-level "identity model"
--    decision this migration makes; documented here rather than left
--    implicit.
-- ============================================================
drop index if exists public.customers_user_id_unique;
create unique index customers_club_user_id_unique
  on public.customers (club_id, user_id)
  where user_id is not null;

-- ============================================================
-- 2. portal_invites -- the activation invite itself.
-- ============================================================
create table public.portal_invites (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  customer_id uuid not null references public.customers(id),
  purpose text not null default 'account_activation' check (purpose in ('account_activation')),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'consumed', 'revoked')),
  -- Set only once phone confirmation succeeds -- gates the final
  -- email/password step. Kept as a separate boolean rather than a
  -- third status value so "pending but phone-verified" and "pending,
  -- not yet attempted" both remain queryable/resumable without a
  -- state-machine redesign if a customer closes the tab mid-flow.
  phone_verified_at timestamptz,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  -- The booking that triggered this invite, if any (staff-created
  -- booking flow, amendment section 3) -- lets the activation page
  -- show a *minimal* booking summary (section 7) without exposing the
  -- customer's full history before ownership is proven.
  triggering_booking_id uuid references public.bookings(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  -- Failed phone-confirmation attempts on this specific invite --
  -- amendment section 67's rate-limiting requirement, enforced here
  -- rather than only at the edge/network layer so it survives across
  -- deployments and is auditable.
  phone_attempt_count int not null default 0
);

create index idx_portal_invites_customer on public.portal_invites (customer_id);
create index idx_portal_invites_club on public.portal_invites (club_id);
-- At most one PENDING invite per customer at a time (amendment
-- section 24: "avoid multiple simultaneously valid activation links"
-- -- resending must revoke the previous one, enforced structurally,
-- not just by application discipline).
create unique index idx_portal_invites_one_pending_per_customer
  on public.portal_invites (customer_id)
  where status = 'pending';

alter table public.portal_invites enable row level security;
alter table public.portal_invites force row level security;

-- Staff can see invite status for their own club's customers (powers
-- the Customer 360 "Portal Account: Invite Sent / Expired" display,
-- amendment section 23) -- never the raw token (token_hash is a hash,
-- harmless even if selected, but still excluded from the staff-facing
-- read surface below by convention).
create policy portal_invites_select_club_staff on public.portal_invites
  for select
  using (club_id in (select public.user_club_ids()) and public.has_permission('customer.view', club_id));

-- No direct INSERT/UPDATE/DELETE policies for anyone -- every write
-- goes through SECURITY DEFINER RPCs below, matching qr_credentials'
-- own established pattern exactly.

revoke all on public.portal_invites from public;
revoke all on public.portal_invites from anon;
grant select on public.portal_invites to authenticated;
grant select on public.portal_invites to service_role;

comment on table public.portal_invites is
  'Zero-cost customer account activation invites: WhatsApp-delivered secure link + registered-phone re-verification, proven before the customer ever sets an email/password. Token is hashed at rest (token_hash); the raw token is minted once, handed to the client, and never stored. See _create_portal_invite_internal / verify_portal_invite_phone / claim_portal_invite for the full lifecycle.';

-- ============================================================
-- 3. Token minting -- shared internal, mirrors
--    _mint_booking_qr_token_internal's exact pattern (already proven
--    correct/battle-tested this session): generate high-entropy raw
--    bytes, hash with a fast collision-resistant digest for at-rest
--    storage (this app's existing qr_credentials convention uses the
--    same approach; sha256 is sufficient here since the token itself
--    already carries 256 bits of real entropy -- there is no
--    low-entropy secret to protect against offline brute force, only
--    a lookup key).
-- ============================================================
create or replace function public._mint_portal_invite_internal(
  p_club_id uuid,
  p_customer_id uuid,
  p_triggering_booking_id uuid,
  p_expires_at timestamptz,
  p_created_by uuid
)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_raw_token text;
  v_token_hash text;
begin
  -- Revoke any still-pending invite for this customer first (section
  -- 24: at most one valid link at a time) -- the partial unique index
  -- above would reject a second pending row anyway, but revoking
  -- explicitly here keeps the *previous* raw link genuinely dead
  -- (status != 'pending') rather than merely orphaned.
  update public.portal_invites
  set status = 'revoked'
  where customer_id = p_customer_id and status = 'pending';

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  insert into public.portal_invites (
    club_id, customer_id, token_hash, expires_at, triggering_booking_id, created_by
  ) values (
    p_club_id, p_customer_id, v_token_hash, p_expires_at, p_triggering_booking_id, p_created_by
  );

  return v_raw_token;
end;
$function$;

revoke all on function public._mint_portal_invite_internal(uuid, uuid, uuid, timestamptz, uuid) from public;
revoke all on function public._mint_portal_invite_internal(uuid, uuid, uuid, timestamptz, uuid) from anon;
grant execute on function public._mint_portal_invite_internal(uuid, uuid, uuid, timestamptz, uuid) to authenticated;
grant execute on function public._mint_portal_invite_internal(uuid, uuid, uuid, timestamptz, uuid) to service_role;

-- ============================================================
-- 4. Staff-facing entrypoint: "Send Activation Invite" (amendment
--    section 23-24). Staff-permission-gated, never sets a password,
--    never sees the raw link value returned to it beyond what it's
--    explicitly meant to relay (staff copies/sends it -- same
--    trust level as the existing "copy public club link" action).
-- ============================================================
create or replace function public.send_portal_invite(
  p_customer_id uuid
)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_customer record;
  v_raw_token text;
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

  -- Section 62: cannot deliver an invite or perform phone confirmation
  -- without a real registered phone -- fail with a clear, actionable
  -- message rather than minting a link nobody can ever complete.
  if v_customer.phone_e164 is null then
    raise exception 'customer has no valid phone number on file -- add one before sending an activation invite';
  end if;

  if v_customer.duplicate_review_status <> 'none' then
    raise exception 'this customer record is pending duplicate review and cannot be activated yet';
  end if;

  -- 48-hour expiry, matching the amendment's recommended default.
  v_raw_token := public._mint_portal_invite_internal(
    v_customer.club_id, p_customer_id, null, now() + interval '48 hours', auth.uid()
  );

  perform public.write_audit_log(
    v_customer.club_id, 'portal.invite_created', 'customer', p_customer_id, null,
    jsonb_build_object('expires_at', now() + interval '48 hours'), null
  );

  return v_raw_token;
end;
$function$;

revoke all on function public.send_portal_invite(uuid) from public;
revoke all on function public.send_portal_invite(uuid) from anon;
grant execute on function public.send_portal_invite(uuid) to authenticated;
grant execute on function public.send_portal_invite(uuid) to service_role;

-- ============================================================
-- 5. Anonymous read: minimal invite context for the activation page
--    (amendment section 7 -- "do not show full history before
--    activation"). Returns ONLY what's needed to orient the customer:
--    customer first name, club name, a MASKED phone (never the full
--    number -- section 8: "لا تعرض الرقم الصحيح بالكامل"), and a
--    minimal booking summary if this invite was triggered by a
--    booking. Never returns the token hash, the real phone, or any
--    other customer/booking field.
-- ============================================================
create or replace function public.get_portal_invite_context(p_raw_token text)
returns table(
  customer_name text,
  club_name text,
  masked_phone text,
  status text,
  is_expired boolean,
  booking_field_name text,
  booking_start_at timestamptz,
  booking_end_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invite record;
  v_customer record;
  v_club_name text;
  v_field_name text;
  v_start_at timestamptz;
  v_end_at timestamptz;
begin
  if p_raw_token is null or length(p_raw_token) < 32 then
    raise exception 'invalid invite link';
  end if;

  select * into v_invite from public.portal_invites
  where token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex');

  if v_invite.id is null then
    raise exception 'invalid invite link';
  end if;

  select id, full_name, phone_e164 into v_customer from public.customers where id = v_invite.customer_id;
  select name into v_club_name from public.clubs where id = v_invite.club_id;

  if v_invite.triggering_booking_id is not null then
    select f.name, b.start_at, b.end_at into v_field_name, v_start_at, v_end_at
    from public.bookings b join public.fields f on f.id = b.field_id
    where b.id = v_invite.triggering_booking_id;
  end if;

  return query select
    -- First name only -- a light additional privacy step beyond what
    -- the amendment strictly requires, consistent with its own
    -- "مرحبًا مصطفى" example (a first name, not the full legal name).
    split_part(coalesce(v_customer.full_name, ''), ' ', 1),
    v_club_name,
    -- Mask everything except the last 3 digits: +201*********553 style.
    -- Section 8's own example masks the middle of a local-format
    -- number; this masks the E.164 form the same way, keeping only
    -- enough visible to let a genuine customer recognize their own
    -- number without letting an attacker holding just the link infer
    -- more than 3 digits of it.
    case when v_customer.phone_e164 is not null
      then left(v_customer.phone_e164, 3) || repeat('*', greatest(length(v_customer.phone_e164) - 6, 0)) || right(v_customer.phone_e164, 3)
      else null
    end,
    v_invite.status,
    v_invite.expires_at <= now(),
    v_field_name,
    v_start_at,
    v_end_at;
end;
$function$;

revoke all on function public.get_portal_invite_context(text) from public;
grant execute on function public.get_portal_invite_context(text) to anon;
grant execute on function public.get_portal_invite_context(text) to authenticated;
grant execute on function public.get_portal_invite_context(text) to service_role;

-- ============================================================
-- 6. Phone confirmation -- the zero-cost second factor (amendment
--    section 8-9). Frontend sends only the raw invite token and the
--    customer's TYPED phone (pre-normalized client-side through the
--    existing normalizePhone()/phone_e164 pipeline, exactly as every
--    other phone-accepting entrypoint in this app already does --
--    create_public_booking is the direct precedent: it takes a
--    pre-normalized p_customer_phone_e164 and only regex-validates
--    format server-side, never re-derives it). The server NEVER
--    trusts a client-supplied customer_id -- identity is derived
--    exclusively from the token, matching section 9's explicit rule.
--
--    Rate-limited server-side (section 67): 5 attempts per invite,
--    then the invite is permanently revoked, forcing a genuinely new
--    invite (with a fresh token) rather than allowing indefinite
--    guessing against one link.
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
  if v_invite.phone_attempt_count >= 5 then
    update public.portal_invites set status = 'revoked' where id = v_invite.id;
    raise exception 'too many attempts -- request a new activation link';
  end if;

  select * into v_customer from public.customers where id = v_invite.customer_id;

  -- Exact normalized-string match only -- never a fuzzy/partial
  -- comparison. A missing/malformed entered value simply fails the
  -- equality check below (no special-cased early exception) so a
  -- caller probing for behavioral differences learns nothing extra.
  if p_entered_phone_e164 is not null
     and v_customer.phone_e164 is not null
     and p_entered_phone_e164 = v_customer.phone_e164 then
    update public.portal_invites
    set phone_verified_at = now(), phone_attempt_count = 0
    where id = v_invite.id;
    return true;
  end if;

  update public.portal_invites
  set phone_attempt_count = phone_attempt_count + 1
  where id = v_invite.id;

  -- Generic failure, matching section 27 exactly: never reveal
  -- whether the phone was merely wrong vs. the customer/token
  -- otherwise being invalid.
  return false;
end;
$function$;

revoke all on function public.verify_portal_invite_phone(text, text) from public;
grant execute on function public.verify_portal_invite_phone(text, text) to anon;
grant execute on function public.verify_portal_invite_phone(text, text) to authenticated;
grant execute on function public.verify_portal_invite_phone(text, text) to service_role;

-- ============================================================
-- 7. Final atomic link -- called AFTER a real Supabase Auth user has
--    already been created (email+password, via the ordinary
--    supabase.auth.signUp() client call -- Supabase Auth remains the
--    sole password/session authority, per the amendment's explicit
--    rule; this RPC never touches a password). The frontend calls
--    this immediately after signUp() succeeds and the new session is
--    live, passing only the raw invite token -- customer identity is
--    still derived exclusively from the token+phone-verified state,
--    auth.uid() is read from the now-authenticated caller, never
--    trusted from any client-supplied id.
--
--    Idempotent by construction (amendment section 13-14): re-calling
--    with the same already-consumed token for the same now-linked
--    auth.uid() is a safe no-op returning the same customer_id,
--    covering the "network retry after the first call actually
--    succeeded" case described in section 14. A genuinely different
--    caller hitting an already-consumed token hard-fails.
-- ============================================================
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

  -- Idempotent retry: already consumed BY THIS SAME caller -> return
  -- the same result rather than erroring (section 14's compensating-
  -- action safety net for a client retry after a network hiccup that
  -- actually succeeded server-side).
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

  select * into v_customer from public.customers where id = v_invite.customer_id for update;
  if v_customer.id is null then
    raise exception 'customer not found';
  end if;

  -- Section 16/17: never create a second portal identity for an
  -- already-activated customer, and never silently steal a link that
  -- somehow got claimed by a different account first.
  if v_customer.user_id is not null then
    if v_customer.user_id = auth.uid() then
      update public.portal_invites set status = 'consumed', consumed_at = now() where id = v_invite.id;
      return v_customer.id;
    end if;
    raise exception 'this customer record is already linked to a different account';
  end if;

  -- Section 17 DB guarantee: at most one active customer link per
  -- (club, auth user) -- enforced structurally by
  -- customers_club_user_id_unique above, not merely checked here; this
  -- explicit pre-check just turns the eventual constraint violation
  -- into a friendly message instead of a raw SQL error.
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
-- 8. Customer 360 status surface (amendment section 23): a single
--    read-only summary so staff can see "Not Activated / Invite Sent
--    / Activated / Invite Expired" without ever touching a password.
-- ============================================================
create or replace function public.get_customer_portal_status(p_customer_id uuid)
returns table(
  status text,
  invited_at timestamptz,
  invite_expires_at timestamptz,
  activated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_customer record;
  v_invite record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_customer from public.customers where id = p_customer_id;
  if v_customer.id is null then
    raise exception 'customer not found';
  end if;
  if not (v_customer.club_id in (select public.user_club_ids()) and public.has_permission('customer.view', v_customer.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_customer.user_id is not null then
    return query select 'activated'::text, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  select * into v_invite from public.portal_invites
  where customer_id = p_customer_id
  order by created_at desc
  limit 1;

  if v_invite.id is null then
    return query select 'not_invited'::text, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_invite.status = 'pending' and v_invite.expires_at <= now() then
    return query select 'invite_expired'::text, v_invite.created_at, v_invite.expires_at, null::timestamptz;
    return;
  end if;

  return query select
    case when v_invite.status = 'pending' then 'invite_sent' else 'not_invited' end,
    v_invite.created_at, v_invite.expires_at, null::timestamptz;
end;
$function$;

revoke all on function public.get_customer_portal_status(uuid) from public;
revoke all on function public.get_customer_portal_status(uuid) from anon;
grant execute on function public.get_customer_portal_status(uuid) to authenticated;
grant execute on function public.get_customer_portal_status(uuid) to service_role;
