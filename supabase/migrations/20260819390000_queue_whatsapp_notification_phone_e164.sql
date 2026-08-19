-- P0 Phone Identity directive -- gap found during live acceptance
-- testing (item 3, Quick Booking): queue_whatsapp_notification()
-- resolved the recipient phone as
--   coalesce(notification_consent.normalized_phone, customers.normalized_mobile)
-- -- i.e. it NEVER read customers.phone_e164 at all, even though that
-- is now the canonical, correctly-normalized value. A staff-created
-- customer (CustomersPage/QuickBookingSheet) has no
-- notification_consent row (only the public-booking RPC path creates
-- one), so v_phone resolved to NULL and the function returned early
-- with no queue row and no error -- completely silent. Verified live:
-- a real booking created via the staff Quick Booking UI, for a
-- customer with a correctly-normalized phone_e164, produced ZERO
-- notification_queue rows.
--
-- Fix: resolve the phone from customers.phone_e164 FIRST (the
-- canonical value, always present when the customer was created
-- through any of this session's fixed entry points), falling back to
-- the consent snapshot only if phone_e164 is genuinely absent
-- (legacy/ambiguous historical customers -- see the Phone Data Issues
-- view). Validates with the real E.164 format check instead of the
-- loose is_phone_plausible() digit-count heuristic, consistent with
-- the hard gate already applied to whatsapp_connector_claim_next_batch().
create or replace function public.queue_whatsapp_notification(
  p_club_id uuid,
  p_event_id uuid,
  p_customer_id uuid,
  p_template_key text,
  p_category text,
  p_variables jsonb,
  p_priority text default 'transactional',
  p_dedup_key text default null,
  p_media_type text default null,
  p_media_intent text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_category_enabled boolean;
  v_phone text;
  v_language text;
  v_scheduled_at timestamptz;
  v_expires_at timestamptz;
  v_queue_id uuid;
begin
  select enabled into v_category_enabled
  from public.notification_category_settings
  where club_id = p_club_id and channel = 'whatsapp' and category = p_category;
  if v_category_enabled is false then
    return null;
  end if;

  if not exists (select 1 from public.whatsapp_accounts where club_id = p_club_id and status = 'connected') then
    return null;
  end if;

  if exists (select 1 from public.notification_suppressions where customer_id = p_customer_id and channel = 'whatsapp') then
    return null;
  end if;

  select
    coalesce(c.phone_e164, nc.normalized_phone),
    coalesce(nc.preferred_language, 'ar')
  into v_phone, v_language
  from public.customers c
  left join public.notification_consent nc
    on nc.customer_id = p_customer_id and nc.channel = 'whatsapp' and nc.enabled = true
  where c.id = p_customer_id;

  if v_phone is null then
    return null;
  end if;

  if v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    insert into public.notification_suppressions (club_id, customer_id, channel, reason, detail)
    values (p_club_id, p_customer_id, 'whatsapp', 'invalid_recipient', 'phone failed E.164 format check at queue time')
    on conflict (customer_id, channel) do nothing;
    return null;
  end if;

  v_scheduled_at := public.next_eligible_send_time(p_club_id, now(), p_priority);

  if p_priority = 'reminder' then
    v_expires_at := now() + interval '2 hours';
  end if;

  v_queue_id := public.enqueue_notification(
    p_club_id, p_event_id, 'whatsapp', p_customer_id, p_template_key,
    v_language, p_variables, p_priority, v_scheduled_at, v_expires_at, p_dedup_key,
    p_media_type, p_media_intent
  );

  return v_queue_id;
end;
$function$;

revoke all on function public.queue_whatsapp_notification(uuid, uuid, uuid, text, text, jsonb, text, text, text, text) from public;
revoke all on function public.queue_whatsapp_notification(uuid, uuid, uuid, text, text, jsonb, text, text, text, text) from anon;
