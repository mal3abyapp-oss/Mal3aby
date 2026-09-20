-- INV-1 fix (2026-09-19, owner brief): sales_win_lead_and_invite_owner()
-- and resend_sales_activation_invite() both mint a real activation
-- token+secret (sales_tenant_activation_invites), but NEITHER ever
-- queues anything for delivery -- confirmed live: SalesLeadDetailPage.tsx
-- calls both RPCs and discards their return value entirely (never even
-- destructures raw_token/raw_secret). The prospect was told "invite
-- sent" with no email ever dispatched, matching the brief's own
-- hypothesis exactly (unlike SEND-1, whose real cause diverged from
-- what was guessed).
--
-- DESIGN DECISION (confirmed against ActivateTenantOwnerPage.tsx's own
-- doc comment before writing this migration, NOT invented here): this
-- flow is a deliberate two-factor, two-channel activation --
--   "Independent activation secret (verify_sales_activation_secret) --
--    delivered out of band by the platform owner, never in this URL."
-- The raw_secret is an 8-character human-readable code
-- (_mint_sales_activation_invite_internal's own alphabet, formatted
-- like ABCD-1234) -- built to be read aloud or typed, not embedded in
-- a link. This migration automates ONLY the link half (email with the
-- /sales-activate/:token URL) through the SEND-1 infrastructure
-- (sales_outreach_messages, now worker-driven) -- the secret is
-- deliberately NEVER put in this email, matching the existing
-- security design exactly. Both RPCs still return raw_secret to the
-- frontend exactly as before, for the platform owner to relay
-- manually (call/WhatsApp/in person) -- this migration does not
-- change that part, only adds the missing email half.
--
-- Composed directly in SQL (deterministic system content, not an
-- AI-drafted outreach message) rather than through
-- cloudflare/email-worker's notification_queue/templates.ts path,
-- since that path requires a club_id + notification_events row that
-- do not exist yet at this pre-conversion stage -- sales_outreach_messages
-- (channel='email', already worker-driven since SEND-1) is the correct
-- home, matching this domain's own existing shape.

create or replace function public._queue_sales_activation_invite_email(p_lead_id uuid, p_business_name text, p_business_name_ar text, p_owner_email text, p_raw_token text, p_expires_at timestamptz)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_activation_url text;
  v_body text;
begin
  v_activation_url := 'https://mal3aby.app/sales-activate/' || p_raw_token;

  v_body :=
    'مرحبًا،' || chr(10) || chr(10) ||
    'تم قبول ' || coalesce(p_business_name_ar, p_business_name) || ' كشريك جديد على منصة ملعبي.' || chr(10) || chr(10) ||
    'لإكمال تفعيل حسابك، افتح الرابط التالي:' || chr(10) ||
    v_activation_url || chr(10) || chr(10) ||
    'سيُطلب منك أيضًا رمز تفعيل قصير -- هذا الرمز سيصلك بشكل منفصل من فريق المبيعات (عبر مكالمة أو واتساب)، وليس عبر هذا البريد، لحماية حسابك.' || chr(10) || chr(10) ||
    'هذا الرابط صالح حتى ' || to_char(p_expires_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') || ' (بتوقيت القاهرة).' || chr(10) || chr(10) ||
    '---' || chr(10) || chr(10) ||
    'Hello,' || chr(10) || chr(10) ||
    p_business_name || ' has been approved as a new partner on the Mal3aby platform.' || chr(10) || chr(10) ||
    'To complete your account activation, open the link below:' || chr(10) ||
    v_activation_url || chr(10) || chr(10) ||
    'You will also be asked for a short activation code -- this code will reach you separately from our sales team (by call or WhatsApp), never through this email, to protect your account.' || chr(10) || chr(10) ||
    'This link is valid until ' || to_char(p_expires_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') || ' (Cairo time).';

  insert into public.sales_outreach_messages (lead_id, channel, message_type, language, subject, body, status, quality_status, created_by)
  values (
    p_lead_id, 'email', 'activation_invite', 'ar',
    'تفعيل حسابك على ملعبي / Activate your Mal3aby account',
    v_body, 'queued', 'approval_ready', auth.uid()
  );
end;
$$;

revoke all on function public._queue_sales_activation_invite_email(uuid, text, text, text, text, timestamptz) from public;
revoke all on function public._queue_sales_activation_invite_email(uuid, text, text, text, text, timestamptz) from anon;
revoke all on function public._queue_sales_activation_invite_email(uuid, text, text, text, text, timestamptz) from authenticated;
grant execute on function public._queue_sales_activation_invite_email(uuid, text, text, text, text, timestamptz) to service_role;

-- Both callers below are SECURITY DEFINER and already run as a
-- privileged context (is_platform_owner()/has_platform_permission()
-- already checked before this point in each function), so this
-- internal helper is reachable from them even though it's
-- service_role-only -- SECURITY DEFINER functions execute with the
-- privileges of their owner, not the calling role, matching every
-- other _internal helper already in this codebase
-- (_mint_sales_activation_invite_internal itself is the precedent).

create or replace function public.sales_win_lead_and_invite_owner(p_lead_id uuid, p_owner_email text, p_contact_phone text DEFAULT NULL::text, p_business_name_ar text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
returns table(raw_token text, raw_secret text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead record;
  v_mint record;
  v_contact_phone_e164 text;
  v_expires_at timestamptz;
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
  v_expires_at := now() + interval '7 days';

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
    v_expires_at, auth.uid()
  );

  perform public._queue_sales_activation_invite_email(
    p_lead_id, v_lead.business_name, coalesce(p_business_name_ar, v_lead.business_name),
    p_owner_email, v_mint.raw_token, v_expires_at
  );

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'activation_invite_created', jsonb_build_object('owner_email', lower(trim(p_owner_email)), 'expires_at', v_expires_at), auth.uid());

  return query select v_mint.raw_token, v_mint.raw_secret;
end;
$$;

create or replace function public.resend_sales_activation_invite(p_lead_id uuid)
returns table(raw_token text, raw_secret text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead record;
  v_prior record;
  v_mint record;
  v_expires_at timestamptz;
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

  v_expires_at := now() + interval '7 days';

  select * into v_mint from public._mint_sales_activation_invite_internal(
    p_lead_id, v_prior.business_name, v_prior.business_name_ar, v_prior.business_type,
    v_prior.city, v_prior.country, v_prior.contact_phone, v_prior.contact_phone_e164,
    v_prior.owner_email, v_expires_at, auth.uid()
  );

  perform public._queue_sales_activation_invite_email(
    p_lead_id, v_prior.business_name, v_prior.business_name_ar,
    v_prior.owner_email, v_mint.raw_token, v_expires_at
  );

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'activation_invite_resent', jsonb_build_object('owner_email', v_prior.owner_email, 'expires_at', v_expires_at), auth.uid());

  return query select v_mint.raw_token, v_mint.raw_secret;
end;
$$;
