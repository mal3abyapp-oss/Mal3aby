-- Correction to the prior pass's staff-created-customer consent fix:
-- the earlier migration made CustomersPage.tsx/QuickBookingSheet.tsx
-- insert notification_consent(enabled=true) automatically the instant
-- a phone number was entered -- but creating a customer record is NOT
-- the customer's own consent. Only the customer's own affirmative act
-- is consent (e.g. submitting their own phone on the public booking
-- form). When staff enter a phone on the customer's behalf, staff
-- must explicitly ask the customer and record the real answer.
--
-- This RPC is the single, centralized write path for that recorded
-- decision -- used identically by every staff-side customer-creation
-- surface (directive requirement: uniform behavior, not two paths
-- fixed and a third left different). It:
--   - requires an explicit true/false answer, never assumes one
--   - if the customer previously explicitly revoked consent
--     (revoked_at is not null) and staff attempt to record YES again,
--     this does NOT silently flip it back on with no trace -- it
--     still requires a fresh explicit YES from staff (which this RPC
--     receives as p_consented=true), but audits the re-consent
--     distinctly from a first-time consent so a re-enable after a
--     prior revoke is always traceable, never silent
--   - keeps WhatsApp service notifications entirely separate from any
--     marketing consent concept (this project has no marketing
--     channel at all -- see safe-messaging directive's own
--     "marketing not supported" note -- so there is nothing to
--     conflate here, but this RPC's channel is explicitly 'whatsapp'
--     service notifications only, never a bulk/marketing channel)
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
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_consented is null then
    raise exception 'an explicit consent answer is required';
  end if;

  select * into v_existing from public.notification_consent
  where customer_id = p_customer_id and channel = 'whatsapp';

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

revoke all on function public.record_staff_whatsapp_consent(uuid, uuid, boolean, text, text) from public;
revoke all on function public.record_staff_whatsapp_consent(uuid, uuid, boolean, text, text) from anon;
grant execute on function public.record_staff_whatsapp_consent(uuid, uuid, boolean, text, text) to authenticated;
