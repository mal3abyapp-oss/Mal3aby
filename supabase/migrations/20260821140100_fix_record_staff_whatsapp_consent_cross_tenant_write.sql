-- SECURITY FIX (P1, confirmed live): record_staff_whatsapp_consent (both
-- the 5-arg and 6-arg overloads) authorized the caller against p_club_id
-- (their own club) but never verified p_customer_id actually belongs to
-- that club before inserting/updating notification_consent -- an
-- authenticated staff member with customer.update on their OWN club
-- could pass any OTHER club's customer_id and overwrite that customer's
-- WhatsApp consent decision (enable, disable, or rewrite the phone
-- identity consent is bound to).
--
-- Practical exploitability of the specific "6-arg overload is granted to
-- anon" concern: confirmed NOT independently exploitable by a truly
-- anonymous request -- user_club_ids() resolves via auth.uid(), which is
-- NULL for anon, so `p_club_id in (select user_club_ids())` is always
-- false for an unauthenticated caller and the function already correctly
-- raises 'not authorized' before reaching the vulnerable code. The real,
-- confirmed risk is authenticated-staff-against-a-foreign-club, the same
-- IDOR class as get_customer_communications' consent-read bug fixed
-- alongside this migration. The anon/public grant on the 6-arg overload
-- is still tightened below as defense-in-depth and to match this
-- project's own established grant-hygiene pattern (two prior incidents
-- of exactly this default-privilege leak class are documented in this
-- migration history).
--
-- Both existing legitimate callers (set_customer_whatsapp_consent,
-- upsert_customer, and the dedicated consent-only RPC) already only ever
-- pass a customer_id they resolved within the same p_club_id -- this
-- check is a no-op for all of them and does not change their behavior.

create or replace function public.record_staff_whatsapp_consent(
  p_club_id uuid,
  p_customer_id uuid,
  p_consented boolean,
  p_phone_display text,
  p_normalized_phone text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_existing record;
  v_was_previously_revoked boolean := false;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
    raise exception 'customer not found';
  end if;

  if p_consented is null then
    raise exception 'an explicit consent answer is required';
  end if;

  select * into v_existing from public.notification_consent
  where customer_id = p_customer_id and club_id = p_club_id and channel = 'whatsapp';

  if v_existing.id is not null and v_existing.revoked_at is not null then
    v_was_previously_revoked := true;
  end if;

  insert into public.notification_consent (
    club_id, customer_id, channel, enabled, consent_source, consent_at, revoked_at,
    phone_display, normalized_phone
  ) values (
    p_club_id, p_customer_id, 'whatsapp', p_consented,
    case when p_consented then 'staff_recorded_customer_consent' else 'staff_recorded_customer_decline' end,
    case when p_consented then now() else null end,
    case when p_consented then null else now() end,
    p_phone_display, p_normalized_phone
  )
  on conflict (customer_id, channel) do update set
    enabled = p_consented,
    consent_source = case when p_consented then 'staff_recorded_customer_consent' else 'staff_recorded_customer_decline' end,
    consent_at = case when p_consented then now() else notification_consent.consent_at end,
    revoked_at = case when p_consented then null else now() end,
    phone_display = p_phone_display,
    normalized_phone = p_normalized_phone,
    updated_at = now();

  perform public.write_audit_log(
    p_club_id,
    case when v_was_previously_revoked and p_consented then 'whatsapp_consent.re_recorded_after_revoke'
         when p_consented then 'whatsapp_consent.recorded'
         else 'whatsapp_consent.declined' end,
    'customer', p_customer_id,
    jsonb_build_object('enabled', coalesce(v_existing.enabled, false), 'revoked_at', v_existing.revoked_at),
    jsonb_build_object('enabled', p_consented),
    null
  );
end;
$function$;

revoke all on function public.record_staff_whatsapp_consent(uuid, uuid, boolean, text, text) from public, anon;
grant execute on function public.record_staff_whatsapp_consent(uuid, uuid, boolean, text, text) to authenticated;

create or replace function public.record_staff_whatsapp_consent(
  p_club_id uuid,
  p_customer_id uuid,
  p_consented boolean,
  p_phone_display text,
  p_normalized_phone text,
  p_phone_e164 text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_existing record;
  v_was_previously_revoked boolean := false;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
    raise exception 'customer not found';
  end if;

  if p_consented is null then
    raise exception 'an explicit consent answer is required';
  end if;

  select * into v_existing from public.notification_consent
  where customer_id = p_customer_id and club_id = p_club_id and channel = 'whatsapp';

  -- Directive requirement: "staff cannot silently restore revoked
  -- consent through customer edit" -- and by extension, a consent
  -- decision recorded for a DIFFERENT phone number than the one on
  -- file now must never be treated as if it already answered for the
  -- current number.
  if v_existing.id is not null and v_existing.revoked_at is not null
     and (v_existing.phone_e164 is null or p_phone_e164 is null or v_existing.phone_e164 = p_phone_e164) then
    v_was_previously_revoked := true;
  end if;

  insert into public.notification_consent (
    club_id, customer_id, channel, enabled, consent_source, consent_at, revoked_at,
    phone_display, normalized_phone, phone_e164
  ) values (
    p_club_id, p_customer_id, 'whatsapp', p_consented,
    case when p_consented then 'staff_recorded_customer_consent' else 'staff_recorded_customer_decline' end,
    case when p_consented then now() else null end,
    case when p_consented then null else now() end,
    p_phone_display, p_normalized_phone, p_phone_e164
  )
  on conflict (customer_id, channel) do update set
    enabled = p_consented,
    consent_source = case when p_consented then 'staff_recorded_customer_consent' else 'staff_recorded_customer_decline' end,
    consent_at = case when p_consented then now() else notification_consent.consent_at end,
    revoked_at = case when p_consented then null else now() end,
    phone_display = p_phone_display,
    normalized_phone = p_normalized_phone,
    phone_e164 = coalesce(p_phone_e164, notification_consent.phone_e164),
    updated_at = now();

  perform public.write_audit_log(
    p_club_id,
    case when v_was_previously_revoked and p_consented then 'whatsapp_consent.re_recorded_after_revoke'
         when p_consented then 'whatsapp_consent.recorded'
         else 'whatsapp_consent.declined' end,
    'customer', p_customer_id,
    jsonb_build_object('enabled', coalesce(v_existing.enabled, false), 'revoked_at', v_existing.revoked_at, 'phone_e164', v_existing.phone_e164),
    jsonb_build_object('enabled', p_consented, 'phone_e164', p_phone_e164),
    null
  );
end;
$function$;

revoke all on function public.record_staff_whatsapp_consent(uuid, uuid, boolean, text, text, text) from public, anon;
grant execute on function public.record_staff_whatsapp_consent(uuid, uuid, boolean, text, text, text) to authenticated;
