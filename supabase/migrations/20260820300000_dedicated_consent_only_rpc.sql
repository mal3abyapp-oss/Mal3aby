-- Bug found during Customer 360 build: WhatsAppCommunicationTab was
-- calling upsert_customer with a sentinel p_full_name = '__consent_only__'
-- to record/revoke consent without touching other fields. But
-- upsert_customer's UPDATE path does `full_name = trim(p_full_name)`
-- UNCONDITIONALLY (not coalesced against the existing value), so every
-- consent action from that tab would have silently overwritten the
-- customer's real name with the literal string "__consent_only__".
--
-- Fix: a dedicated, minimal consent-only RPC that never touches
-- full_name/phone/email/mobile_display -- it only looks up the
-- customer's current phone_e164 and delegates to the same
-- record_staff_whatsapp_consent function every other consent-recording
-- surface uses, so the "revoked consent is never silently re-enabled,
-- consent follows phone identity" invariants still hold.
create or replace function public.set_customer_whatsapp_consent(
  p_club_id uuid,
  p_customer_id uuid,
  p_consented boolean
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_phone_e164 text;
  v_mobile_display text;
  v_normalized_mobile text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select phone_e164, mobile_display, normalized_mobile
    into v_phone_e164, v_mobile_display, v_normalized_mobile
  from public.customers
  where id = p_customer_id and club_id = p_club_id;

  if not found then
    raise exception 'customer not found';
  end if;

  if v_phone_e164 is null then
    raise exception 'customer has no phone number on file';
  end if;

  perform public.record_staff_whatsapp_consent(p_club_id, p_customer_id, p_consented, v_mobile_display, v_normalized_mobile, v_phone_e164);
end;
$function$;

revoke all on function public.set_customer_whatsapp_consent(uuid, uuid, boolean) from public;
revoke all on function public.set_customer_whatsapp_consent(uuid, uuid, boolean) from anon;
grant execute on function public.set_customer_whatsapp_consent(uuid, uuid, boolean) to authenticated;
