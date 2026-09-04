-- PHASE 14 RPCs: mint / resend / verify (email + secret) / claim /
-- complete-conversion, mirroring portal_invites' proven shapes (re-read
-- in full: 20260823050000, 20260823070000, 20260823080000, 20260824080000,
-- 20260824250000) -- with ONE deliberate structural departure explained
-- below and in sales-activate-tenant-owner's own header comment.
--
-- DEPARTURE FROM portal_invites: portal_invites needs BOTH a service-role
-- claim variant (claim_portal_invite_service, called pre-session from the
-- Edge Function) AND an authenticated variant (claim_portal_invite),
-- because linking a customer row to a user_id is a plain UPDATE safely
-- parameterizable with an explicit p_user_id. Tenant conversion cannot
-- follow that shape: complete_new_club_onboarding() is deliberately
-- auth.uid()-only (it creates clubs/branches/club_memberships AS the
-- calling identity) -- there is no safe way to invoke it from a
-- service-role context with an explicit "act as this other user"
-- parameter without recreating the exact TRUE STOP ADR-054 documents.
-- So there is only ONE claim function here (claim_sales_activation_
-- invite, authenticated-only) -- no service-role sibling. The Edge
-- Function (sales-activate-tenant-owner) creates the auth identity ONLY
-- and returns no session; the frontend then does an ordinary
-- signInWithPassword() and calls claim_sales_activation_invite() under
-- that real session, exactly like ActivateAccountPage.tsx's own
-- existing-session code path already does for portal accounts.
--
-- Flow:
--   sales_win_lead_and_invite_owner()  -- platform-owner only. Moves a
--     lead from any pre-won status to 'won' then immediately to
--     'awaiting_owner_activation' in the same call (so 'won' is never
--     observably a standalone state that could be raced against --
--     satisfies "status=WON alone must NOT create a tenant" while still
--     recording the commercial-close moment in status history), mints
--     the invite (token+secret), writes the activity trail entry for
--     each of WON + invite_created.
--   resend_sales_activation_invite()   -- re-mint, revoking any prior
--     pending invite for the same lead (double-click / race-safe via the
--     partial unique index).
--   get_sales_activation_invite_context()   -- anon-callable, minimal
--     masked context for the landing page.
--   verify_sales_activation_email() / verify_sales_activation_secret()
--     -- anon-callable, shared attempt budget, generic failure.
--   claim_sales_activation_invite()  -- authenticated-caller only, reads
--     auth.uid() from a REAL session (either the just-created identity's
--     own first authenticated call right after signup+signin, or an
--     already-signed-in prospect linking an existing account). THIS is
--     the one and only function that calls complete_new_club_
--     onboarding() -- the only point in this flow where a real session
--     exists AND verification is proven, matching onboarding's
--     auth.uid()-only design exactly.
--
-- Idempotency: mirrors claim_portal_invite_service's exact pattern --
-- consumed invite + matching identity => safe retry (return the same
-- club_id); consumed + different identity => hard fail. Additionally
-- guards on sales_leads.status = 'tenant_activated' with a populated
-- converted_club_id as a second, redundant safety net before ever
-- calling complete_new_club_onboarding() again (that RPC itself is NOT
-- idempotent -- it always inserts a new club -- so this guard is the
-- only thing standing between a double-click/parallel-activation race
-- and two clubs for one lead).
create or replace function public._mint_sales_activation_invite_internal(
  p_lead_id uuid,
  p_business_name text,
  p_business_name_ar text,
  p_business_type text,
  p_city text,
  p_country text,
  p_contact_phone text,
  p_contact_phone_e164 text,
  p_owner_email text,
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
  -- Re-mint (resend) revokes any previous PENDING invite for this lead --
  -- old raw token/secret both become permanently unusable together,
  -- matching _mint_portal_invite_internal exactly.
  update public.sales_tenant_activation_invites
  set status = 'revoked'
  where lead_id = p_lead_id and status = 'pending';

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

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

  insert into public.sales_tenant_activation_invites (
    lead_id, business_name, business_name_ar, business_type, city, country,
    contact_phone, contact_phone_e164, owner_email, token_hash, secret_hash,
    expires_at, created_by
  ) values (
    p_lead_id, p_business_name, p_business_name_ar, p_business_type, p_city, p_country,
    p_contact_phone, p_contact_phone_e164, lower(trim(p_owner_email)), v_token_hash, v_secret_hash,
    p_expires_at, p_created_by
  );

  return query select v_raw_token, v_raw_secret;
end;
$function$;

revoke all on function public._mint_sales_activation_invite_internal(uuid, text, text, text, text, text, text, text, text, timestamptz, uuid) from public, anon;
grant execute on function public._mint_sales_activation_invite_internal(uuid, text, text, text, text, text, text, text, text, timestamptz, uuid) to authenticated;
grant execute on function public._mint_sales_activation_invite_internal(uuid, text, text, text, text, text, text, text, text, timestamptz, uuid) to service_role;

-- ============================================================
-- sales_win_lead_and_invite_owner(): the platform owner's single
-- "Convert to Tenant" action. WON and AWAITING_OWNER_ACTIVATION happen
-- together in one transaction (never a standalone observable WON state
-- a race could exploit), status history/activity records both
-- transitions, then the invite is minted and returned to the caller
-- (staff-facing entrypoint, same trust boundary send_portal_invite uses).
-- ============================================================
create or replace function public.sales_win_lead_and_invite_owner(
  p_lead_id uuid,
  p_owner_email text,
  p_contact_phone text default null,
  p_business_name_ar text default null,
  p_reason text default null
)
returns table(raw_token text, raw_secret text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_lead record;
  v_mint record;
  v_contact_phone_e164 text;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.convert_to_tenant')) then
    raise exception 'not authorized';
  end if;

  if p_owner_email is null or p_owner_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'a valid owner email is required to send the activation invite';
  end if;

  select * into v_lead from public.sales_leads where id = p_lead_id for update;
  if v_lead.id is null then
    raise exception 'lead not found';
  end if;
  if v_lead.merged_into_lead_id is not null then
    raise exception 'this lead was merged into another record and cannot be converted directly';
  end if;
  if v_lead.status in ('won', 'awaiting_owner_activation', 'tenant_activated') then
    raise exception 'this lead has already reached won/activation status';
  end if;
  if v_lead.status in ('lost', 'do_not_contact') then
    raise exception 'this lead is marked % and cannot be converted', v_lead.status;
  end if;

  v_contact_phone_e164 := coalesce(nullif(trim(p_contact_phone), ''), v_lead.public_phone);

  -- WON, recorded in history/activities, then immediately superseded by
  -- awaiting_owner_activation in the same transaction -- satisfies the
  -- mandatory rule that WON alone must never create/imply a tenant while
  -- still leaving a real, queryable WON moment in the audit trail.
  update public.sales_leads set status = 'won', status_reason = p_reason, updated_at = now() where id = p_lead_id;
  insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason, changed_by)
  values (p_lead_id, v_lead.status, 'won', p_reason, auth.uid());
  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'won', jsonb_build_object('reason', p_reason), auth.uid());

  update public.sales_leads set status = 'awaiting_owner_activation', updated_at = now() where id = p_lead_id;
  insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason, changed_by)
  values (p_lead_id, 'won', 'awaiting_owner_activation', null, auth.uid());

  select * into v_mint from public._mint_sales_activation_invite_internal(
    p_lead_id, v_lead.business_name, coalesce(p_business_name_ar, v_lead.business_name),
    v_lead.business_type, v_lead.city, v_lead.country,
    v_contact_phone_e164, null, p_owner_email,
    now() + interval '7 days', auth.uid()
  );

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'activation_invite_created', jsonb_build_object('owner_email', lower(trim(p_owner_email)), 'expires_at', now() + interval '7 days'), auth.uid());

  return query select v_mint.raw_token, v_mint.raw_secret;
end;
$function$;

revoke all on function public.sales_win_lead_and_invite_owner(uuid, text, text, text, text) from public, anon;
grant execute on function public.sales_win_lead_and_invite_owner(uuid, text, text, text, text) to authenticated;

-- ============================================================
-- resend_sales_activation_invite(): re-mint for an already-
-- awaiting_owner_activation lead (e.g. the prospect lost the link/secret
-- or the invite expired). Requires the lead to actually be in that
-- status -- cannot be used to invite a lead that hasn't been won, and
-- cannot be used once already tenant_activated.
-- ============================================================
create or replace function public.resend_sales_activation_invite(p_lead_id uuid)
returns table(raw_token text, raw_secret text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_lead record;
  v_prior record;
  v_mint record;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.convert_to_tenant')) then
    raise exception 'not authorized';
  end if;

  select * into v_lead from public.sales_leads where id = p_lead_id for update;
  if v_lead.id is null then
    raise exception 'lead not found';
  end if;
  if v_lead.status <> 'awaiting_owner_activation' then
    raise exception 'this lead is not currently awaiting owner activation';
  end if;

  select * into v_prior from public.sales_tenant_activation_invites
  where lead_id = p_lead_id order by created_at desc limit 1;
  if v_prior.id is null then
    raise exception 'no prior activation invite found for this lead';
  end if;

  select * into v_mint from public._mint_sales_activation_invite_internal(
    p_lead_id, v_prior.business_name, v_prior.business_name_ar, v_prior.business_type,
    v_prior.city, v_prior.country, v_prior.contact_phone, v_prior.contact_phone_e164,
    v_prior.owner_email, now() + interval '7 days', auth.uid()
  );

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'activation_invite_resent', jsonb_build_object('owner_email', v_prior.owner_email, 'expires_at', now() + interval '7 days'), auth.uid());

  return query select v_mint.raw_token, v_mint.raw_secret;
end;
$function$;

revoke all on function public.resend_sales_activation_invite(uuid) from public, anon;
grant execute on function public.resend_sales_activation_invite(uuid) to authenticated;

-- ============================================================
-- get_sales_activation_invite_context(): anon-callable, minimal masked
-- context for the landing page -- mirrors get_portal_invite_context.
-- ============================================================
create or replace function public.get_sales_activation_invite_context(p_raw_token text)
returns table(
  business_name text,
  business_name_ar text,
  owner_email_masked text,
  status text,
  is_expired boolean
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invite record;
begin
  if p_raw_token is null or length(p_raw_token) < 32 then
    raise exception 'invalid invite link';
  end if;

  select * into v_invite from public.sales_tenant_activation_invites
  where token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex');

  if v_invite.id is null then
    raise exception 'invalid invite link';
  end if;

  return query select
    v_invite.business_name,
    v_invite.business_name_ar,
    regexp_replace(v_invite.owner_email, '^(.).*(@.*)$', '\1***\2'),
    v_invite.status,
    (v_invite.expires_at <= now());
end;
$function$;

revoke all on function public.get_sales_activation_invite_context(text) from public;
grant execute on function public.get_sales_activation_invite_context(text) to anon;
grant execute on function public.get_sales_activation_invite_context(text) to authenticated;
grant execute on function public.get_sales_activation_invite_context(text) to service_role;

-- ============================================================
-- verify_sales_activation_email(): first factor. Anon-callable, generic
-- boolean result, shared attempt budget -- mirrors verify_portal_
-- invite_phone exactly (email instead of phone since a lead is a
-- business, not a person with a phone-on-file the same way a customer
-- is).
-- ============================================================
create or replace function public.verify_sales_activation_email(
  p_raw_token text,
  p_entered_email text
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invite record;
begin
  if p_raw_token is null or length(p_raw_token) < 32 then
    raise exception 'invalid invite link';
  end if;

  select * into v_invite from public.sales_tenant_activation_invites
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
    update public.sales_tenant_activation_invites set status = 'revoked' where id = v_invite.id;
    raise exception 'too many attempts -- request a new activation link';
  end if;

  if p_entered_email is not null and lower(trim(p_entered_email)) = v_invite.owner_email then
    update public.sales_tenant_activation_invites set email_verified_at = now() where id = v_invite.id;
    return true;
  end if;

  update public.sales_tenant_activation_invites
  set verification_attempt_count = verification_attempt_count + 1
  where id = v_invite.id;

  return false;
end;
$function$;

revoke all on function public.verify_sales_activation_email(text, text) from public;
grant execute on function public.verify_sales_activation_email(text, text) to anon;
grant execute on function public.verify_sales_activation_email(text, text) to authenticated;
grant execute on function public.verify_sales_activation_email(text, text) to service_role;

-- ============================================================
-- verify_sales_activation_secret(): second factor -- mirrors verify_
-- portal_invite_secret exactly.
-- ============================================================
create or replace function public.verify_sales_activation_secret(
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

  select * into v_invite from public.sales_tenant_activation_invites
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
    update public.sales_tenant_activation_invites set status = 'revoked' where id = v_invite.id;
    raise exception 'too many attempts -- request a new activation link';
  end if;

  if p_entered_secret is not null then
    v_entered_hash := encode(extensions.digest(upper(trim(p_entered_secret)), 'sha256'), 'hex');
    if v_entered_hash = v_invite.secret_hash then
      update public.sales_tenant_activation_invites set secret_verified_at = now() where id = v_invite.id;
      return true;
    end if;
  end if;

  update public.sales_tenant_activation_invites
  set verification_attempt_count = verification_attempt_count + 1
  where id = v_invite.id;

  return false;
end;
$function$;

revoke all on function public.verify_sales_activation_secret(text, text) from public;
grant execute on function public.verify_sales_activation_secret(text, text) to anon;
grant execute on function public.verify_sales_activation_secret(text, text) to authenticated;
grant execute on function public.verify_sales_activation_secret(text, text) to service_role;

-- ============================================================
-- _complete_sales_conversion(): shared internal step -- called by both
-- claim variants ONLY once a real session (auth.uid()) exists for the
-- resolved identity, since this is the one place complete_new_club_
-- onboarding() (auth.uid()-only) can be safely invoked. NOT
-- SECURITY DEFINER-callable from outside -- no grants at all, only
-- ever called from within claim_sales_activation_invite() below in the
-- same transaction.
--
-- Idempotency: mirrors claim_portal_invite_service's pattern layered
-- with an extra guard specific to onboarding's own non-idempotency --
-- checks sales_leads.status/converted_club_id FIRST and short-circuits
-- to the existing club_id on any retry, so complete_new_club_
-- onboarding() (which always inserts a new club) is only ever invoked
-- once per lead, even under a double-click or parallel-tab race (the
-- `for update` row lock on sales_leads below serializes concurrent
-- callers).
-- ============================================================
create or replace function public._complete_sales_conversion(
  p_invite_id uuid,
  p_lead_id uuid
)
returns uuid
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_lead record;
  v_invite record;
  v_onboard record;
begin
  select * into v_lead from public.sales_leads where id = p_lead_id for update;
  if v_lead.id is null then
    raise exception 'lead not found';
  end if;

  -- Already converted (safe retry / race loser) -- return the existing
  -- club, never call onboarding again.
  if v_lead.status = 'tenant_activated' and v_lead.converted_club_id is not null then
    return v_lead.converted_club_id;
  end if;

  if v_lead.status <> 'awaiting_owner_activation' then
    raise exception 'this lead is not currently awaiting owner activation';
  end if;

  select * into v_invite from public.sales_tenant_activation_invites where id = p_invite_id for update;

  -- complete_new_club_onboarding() reuses existing tenant-onboarding
  -- logic UNMODIFIED, per the mandatory "do not duplicate onboarding
  -- business logic" rule -- called here, under the prospect's OWN real
  -- session (auth.uid() = the verified, freshly-bound identity), which
  -- is exactly the trust context that RPC's own auth.uid()-only design
  -- requires. The prospect (not the platform owner) becomes club_owner.
  select * into v_onboard from public.complete_new_club_onboarding(
    p_business_type := coalesce(v_invite.business_type, 'sports_club'),
    p_club_name := v_invite.business_name,
    p_club_name_ar := coalesce(v_invite.business_name_ar, v_invite.business_name),
    p_branch_name := coalesce(v_invite.city, v_invite.business_name),
    p_city := coalesce(v_invite.city, ''),
    p_phone := coalesce(v_invite.contact_phone, ''),
    p_owner_email := v_invite.owner_email,
    p_owner_mobile := coalesce(v_invite.contact_phone, ''),
    p_government_affiliated := false,
    p_country := v_invite.country,
    p_phone_e164 := v_invite.contact_phone_e164
  );

  update public.sales_leads
  set status = 'tenant_activated', converted_club_id = v_onboard.club_id, converted_at = now(), updated_at = now()
  where id = p_lead_id;

  insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason, changed_by)
  values (p_lead_id, 'awaiting_owner_activation', 'tenant_activated', null, auth.uid());

  insert into public.sales_conversion_records (lead_id, club_id, copied_fields, converted_by)
  values (
    p_lead_id, v_onboard.club_id,
    jsonb_build_object(
      'business_name', v_invite.business_name, 'business_name_ar', v_invite.business_name_ar,
      'business_type', v_invite.business_type, 'city', v_invite.city, 'country', v_invite.country,
      'owner_email', v_invite.owner_email, 'trial_granted', v_onboard.trial_granted
    ),
    auth.uid()
  );

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'tenant_created', jsonb_build_object('club_id', v_onboard.club_id, 'trial_granted', v_onboard.trial_granted), auth.uid());
  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'owner_linked', jsonb_build_object('user_id', auth.uid(), 'club_id', v_onboard.club_id), auth.uid());
  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'conversion_completed', jsonb_build_object('club_id', v_onboard.club_id), auth.uid());

  perform public.write_audit_log(
    v_onboard.club_id, 'sales.lead_converted', 'sales_leads', p_lead_id, null,
    jsonb_build_object('club_id', v_onboard.club_id, 'lead_id', p_lead_id), null
  );

  return v_onboard.club_id;
end;
$function$;

revoke all on function public._complete_sales_conversion(uuid, uuid) from public, anon, authenticated, service_role;

-- ============================================================
-- claim_sales_activation_invite(): the authenticated-caller path --
-- reads auth.uid() from a REAL session. Called by the frontend
-- immediately after the prospect signs in (either right after the Edge
-- Function created their brand-new identity and the client established
-- a session for it, or an existing account they just signed into to
-- link). This is the ONLY function in this flow that calls
-- complete_new_club_onboarding(), because it is the only point with a
-- genuine auth.uid() for the prospect.
-- ============================================================
create or replace function public.claim_sales_activation_invite(p_raw_token text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invite record;
  v_club_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_raw_token is null or length(p_raw_token) < 32 then
    raise exception 'invalid invite link';
  end if;

  select * into v_invite from public.sales_tenant_activation_invites
  where token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex')
  for update;

  if v_invite.id is null then
    raise exception 'invalid invite link';
  end if;

  if v_invite.status = 'consumed' then
    if v_invite.activated_user_id = auth.uid() then
      return v_invite.activated_club_id;
    end if;
    raise exception 'this invite has already been used';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'this invite is no longer valid';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'this invite has expired';
  end if;
  if v_invite.email_verified_at is null then
    raise exception 'email verification must be completed first';
  end if;
  if v_invite.secret_verified_at is null then
    raise exception 'activation code verification must be completed first';
  end if;

  -- Prevent the SAME prospect identity from being used to activate a
  -- second, different lead (an identity is Club Owner of at most one
  -- sales-converted tenant via this path).
  if exists (
    select 1 from public.sales_tenant_activation_invites
    where activated_user_id = auth.uid() and status = 'consumed' and id <> v_invite.id
  ) then
    raise exception 'this account has already been used to activate a different business';
  end if;

  v_club_id := public._complete_sales_conversion(v_invite.id, v_invite.lead_id);

  update public.sales_tenant_activation_invites
  set status = 'consumed', consumed_at = now(), activated_club_id = v_club_id, activated_user_id = auth.uid()
  where id = v_invite.id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (v_invite.lead_id, 'activation_invite_consumed', jsonb_build_object('user_id', auth.uid()), auth.uid());

  return v_club_id;
exception
  when others then
    -- v_invite may be entirely unset (e.g. the raw token never matched
    -- any row) -- only record the failure activity when we actually
    -- have a lead_id to attach it to. This insert is itself wrapped in
    -- its own exception handler: it must NEVER be able to mask the
    -- original error with a secondary failure of its own (e.g. an
    -- unexpected FK/constraint issue on the logging insert itself) --
    -- best-effort audit logging, never at the cost of losing the real
    -- error the caller needs to see.
    if v_invite.lead_id is not null then
      begin
        insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
        values (v_invite.lead_id, 'activation_failed', jsonb_build_object('error', sqlerrm), auth.uid());
      exception
        when others then
          null; -- best-effort only -- swallow and fall through to the original re-raise below
      end;
    end if;
    raise;
end;
$function$;

revoke all on function public.claim_sales_activation_invite(text) from public, anon;
grant execute on function public.claim_sales_activation_invite(text) to authenticated;
grant execute on function public.claim_sales_activation_invite(text) to service_role;

comment on function public.claim_sales_activation_invite(text) is
  'Authenticated-caller claim -- the only function that calls complete_new_club_onboarding(), always under the prospect''s own real auth.uid() session (never the platform owner''s). Idempotent: a second call by the same identity returns the same club_id; a different identity hard-fails. See ADR-054 final decision.';
