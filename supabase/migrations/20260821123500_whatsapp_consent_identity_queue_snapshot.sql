-- Bind every queued WhatsApp message to the exact phone identity that
-- consented. A customer phone change must never transfer consent or redirect an
-- already-queued message to the new number.

alter table public.notification_queue
  drop constraint if exists notification_queue_status_check;

alter table public.notification_queue
  add constraint notification_queue_status_check
  check (status = any (array[
    'pending','scheduled','processing','sent','delivered','failed','retrying',
    'cancelled','expired','suppressed_invalid_recipient','suppressed_no_consent'
  ]));

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

  if not exists (
    select 1 from public.whatsapp_accounts
    where club_id = p_club_id and status = 'connected'
  ) then
    return null;
  end if;

  if exists (
    select 1 from public.notification_suppressions
    where customer_id = p_customer_id and channel = 'whatsapp'
  ) then
    return null;
  end if;

  -- Consent is valid only for the exact current canonical phone identity.
  select c.phone_e164, coalesce(nc.preferred_language, 'ar')
  into v_phone, v_language
  from public.customers c
  join public.notification_consent nc
    on nc.club_id = c.club_id
   and nc.customer_id = c.id
   and nc.channel = 'whatsapp'
   and nc.enabled = true
   and nc.revoked_at is null
   and nc.phone_e164 = c.phone_e164
  where c.id = p_customer_id
    and c.club_id = p_club_id
    and c.duplicate_review_status = 'none';

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
    v_language, p_variables, p_priority, v_scheduled_at, v_expires_at,
    p_dedup_key, p_media_type, p_media_intent
  );

  -- Snapshot the consented recipient in the same transaction. The connector
  -- must never resolve a different live customer phone later.
  if v_queue_id is not null then
    update public.notification_queue
    set recipient_phone = v_phone
    where id = v_queue_id
      and club_id = p_club_id
      and recipient_customer_id = p_customer_id;
  end if;

  return v_queue_id;
end;
$function$;

revoke all on function public.queue_whatsapp_notification(uuid, uuid, uuid, text, text, jsonb, text, text, text, text) from public, anon;

create or replace function public.whatsapp_connector_claim_next_batch(p_limit integer default 10)
returns table(
  id uuid,
  club_id uuid,
  recipient_customer_id uuid,
  recipient_phone text,
  template_key text,
  language text,
  variables jsonb,
  attempts integer,
  media_type text,
  media_intent text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  update public.notification_queue nq
  set status = 'cancelled'
  from public.notification_events ne
  where nq.event_id = ne.id
    and nq.channel = 'whatsapp'
    and nq.status in ('pending', 'retrying')
    and not public.notification_source_still_valid(ne.reference_type, ne.reference_id, ne.event_type);

  update public.notification_queue nq
  set status = 'suppressed_invalid_recipient',
      last_error = 'Recipient phone is missing or is not canonical E.164'
  where nq.channel = 'whatsapp'
    and nq.status in ('pending', 'retrying')
    and (nq.recipient_phone is null or nq.recipient_phone !~ '^\+[1-9][0-9]{6,14}$');

  -- Re-check consent immediately before claim. This covers revocation and
  -- phone changes that occur after enqueue. Both are terminal for the old
  -- queue item; a future business event may enqueue after fresh consent.
  update public.notification_queue nq
  set status = 'suppressed_no_consent',
      last_error = 'Consent is absent, revoked, or belongs to a different phone identity'
  where nq.channel = 'whatsapp'
    and nq.status in ('pending', 'retrying')
    and nq.recipient_phone ~ '^\+[1-9][0-9]{6,14}$'
    and not exists (
      select 1
      from public.customers c
      join public.notification_consent nc
        on nc.club_id = c.club_id
       and nc.customer_id = c.id
       and nc.channel = 'whatsapp'
       and nc.enabled = true
       and nc.revoked_at is null
       and nc.phone_e164 = nq.recipient_phone
      where c.id = nq.recipient_customer_id
        and c.club_id = nq.club_id
        and c.phone_e164 = nq.recipient_phone
        and c.duplicate_review_status = 'none'
    );

  return query
    with eligible_accounts as (
      select wa.club_id, mss.max_sends_per_minute_per_account,
             mss.max_sends_per_hour_per_account,
             mss.min_minutes_between_recipient_sends
      from public.whatsapp_accounts wa
      join public.messaging_safety_settings mss on mss.club_id = wa.club_id
      where wa.status = 'connected'
        and (wa.circuit_breaker_open_until is null or wa.circuit_breaker_open_until <= now())
    ),
    account_recent_activity as (
      select nq.club_id,
        count(*) filter (where nq.last_attempt_at > now() - interval '1 minute') as sent_last_minute,
        count(*) filter (where nq.last_attempt_at > now() - interval '1 hour') as sent_last_hour
      from public.notification_queue nq
      where nq.channel = 'whatsapp' and nq.status in ('processing', 'sent')
      group by nq.club_id
    ),
    accounts_under_rate_cap as (
      select ea.club_id, ea.min_minutes_between_recipient_sends
      from eligible_accounts ea
      left join account_recent_activity ara on ara.club_id = ea.club_id
      where coalesce(ara.sent_last_minute, 0) < ea.max_sends_per_minute_per_account
        and coalesce(ara.sent_last_hour, 0) < ea.max_sends_per_hour_per_account
    ),
    candidates as (
      select nq.id, nq.club_id, nq.recipient_customer_id, nq.scheduled_at,
             aur.min_minutes_between_recipient_sends
      from public.notification_queue nq
      join accounts_under_rate_cap aur on aur.club_id = nq.club_id
      where nq.channel = 'whatsapp'
        and nq.status in ('pending', 'retrying')
        and nq.scheduled_at <= now()
        and (nq.next_attempt_at is null or nq.next_attempt_at <= now())
        and (nq.expires_at is null or nq.expires_at > now())
    ),
    filtered as (
      select c.id, c.scheduled_at
      from candidates c
      where c.recipient_customer_id is null or not exists (
        select 1 from public.notification_queue nq2
        where nq2.channel = 'whatsapp'
          and nq2.recipient_customer_id = c.recipient_customer_id
          and nq2.status in ('processing', 'sent')
          and nq2.last_attempt_at > now() - make_interval(mins => c.min_minutes_between_recipient_sends)
      )
    ),
    claimed as (
      select f.id
      from filtered f
      join public.notification_queue nq3 on nq3.id = f.id
      order by f.scheduled_at
      limit greatest(p_limit, 0)
      for update of nq3 skip locked
    )
    update public.notification_queue nq
    set status = 'processing',
        last_attempt_at = now(),
        attempts = nq.attempts + 1
    from claimed
    where nq.id = claimed.id
    returning nq.id, nq.club_id, nq.recipient_customer_id, nq.recipient_phone,
      nq.template_key, nq.language, nq.variables, nq.attempts,
      nq.media_type, nq.media_intent;
end;
$function$;

revoke all on function public.whatsapp_connector_claim_next_batch(integer) from public, anon, authenticated;
