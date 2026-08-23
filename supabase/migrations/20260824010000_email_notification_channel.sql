-- EMAIL DELIVERY CHANNEL -- RESEND + mala3by-email-worker (2026-08-24).
--
-- Implements Email as a full second, independent transactional
-- notification channel alongside WhatsApp, per the audited
-- architecture (EMAIL_NOTIFICATION_AUDIT_2026-08-23.md and its
-- follow-up verification). Policy: send Email if a valid recipient
-- exists, send WhatsApp if available/allowed, send BOTH when both are
-- available -- each channel's queue write is fully independent
-- (`perform`, never re-raised), so one channel's absence/failure never
-- blocks the other, and neither ever blocks the business transaction
-- itself (unchanged from the existing WhatsApp-only behavior).
--
-- CUSTOMER EMAIL SOURCE OF TRUTH (directive section 9/42): audited the
-- one real production divergence found in the prior read-only audit
-- (customer 5340531d-..., club b9178c0f-...). Investigated directly:
-- customers.email IS NULL for that customer, auth.users.email IS NOT
-- NULL (set during account activation, email_confirmed_at matches the
-- customer row's own updated_at to the second). This is NOT two
-- conflicting values for the same fact -- it is a customer who never
-- had a business email on file and later chose+confirmed an Auth
-- email during portal activation (upsert_customer is the ONLY
-- function that ever writes customers.email; the activation Edge
-- Function never touches it). No historical data was mutated -- this
-- migration defines a read-time resolution policy only:
--   1. customers.email when present (canonical -- belongs to the
--      club-customer business relationship, independent of whether
--      the customer ever activates a portal account).
--   2. auth.users.email as a fallback ONLY when customers.email IS
--      NULL AND the customer has an activated portal account
--      (customers.user_id IS NOT NULL) -- the customer explicitly
--      chose and confirmed that address themselves during activation,
--      so it is a legitimate signal, not staff-entered guesswork.
--   3. Never auto-write customers.email from auth.users.email -- no
--      silent overwrite of business data, ever.
create or replace function public.resolve_customer_notification_email(p_customer_id uuid)
returns text
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    nullif(trim(c.email), ''),
    case when c.user_id is not null then nullif(trim(au.email), '') else null end
  )
  from public.customers c
  left join auth.users au on au.id = c.user_id
  where c.id = p_customer_id;
$function$;

revoke all on function public.resolve_customer_notification_email(uuid) from public, anon;
grant execute on function public.resolve_customer_notification_email(uuid) to authenticated, service_role;

comment on function public.resolve_customer_notification_email(uuid) is
  'Server-side-only canonical email resolution for business notifications. customers.email wins when present; auth.users.email is used only as a fallback for activated portal accounts with no customers.email on file. Never mutates customers.email. See this migration''s own header comment for the full divergence investigation this policy is based on.';

-- ============================================================
-- notification_category_settings / notification_suppressions already
-- have a free-text `channel` column (no CHECK constraint restricting
-- values) -- both are reused as-is for channel='email', no schema
-- change needed. notification_consent, by contrast, is WhatsApp-
-- shaped by design (phone_e164/normalized_phone/phone_display columns,
-- no email column at all) -- reusing it for email would require
-- fabricating phone-shaped consent rows for an unrelated channel, so
-- queue_email_notification below deliberately does NOT go through
-- enqueue_notification()'s consent gate (which unconditionally
-- requires a matching notification_consent row and would silently
-- return null for every customer, since zero email consent rows will
-- ever exist in that table). Transactional business email (booking
-- confirmations, receipts) to a customer's own on-file address is the
-- industry-standard exception to marketing-style opt-in consent --
-- category-level enable/disable (notification_category_settings) and
-- explicit suppression (notification_suppressions, e.g. a bounce or
-- an unsubscribe) remain the real policy levers, same as they already
-- are for WhatsApp.
-- ============================================================

-- CUSTOMER ACTIVATION TAKEOVER GAP directive is NOT weakened by this
-- migration -- queue_email_notification below is used ONLY for
-- already-established business notifications (booking/payment/etc.)
-- to a customer's OWN on-file email. It is never used for the
-- activation flow itself; the activation secret continues to travel
-- exclusively via WhatsApp (directive: "staff-entered email alone is
-- NOT proof of ownership" -- an activation-code-by-email channel is
-- explicitly NOT built here).
create or replace function public.queue_email_notification(
  p_club_id uuid,
  p_event_id uuid,
  p_customer_id uuid,
  p_template_key text,
  p_category text,
  p_variables jsonb,
  p_priority text default 'transactional',
  p_dedup_key text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_category_enabled boolean;
  v_email text;
  v_language text;
  v_scheduled_at timestamptz;
  v_expires_at timestamptz;
  v_queue_id uuid;
  v_dedup_key text;
begin
  select enabled into v_category_enabled
  from public.notification_category_settings
  where club_id = p_club_id and channel = 'email' and category = p_category;
  if v_category_enabled is false then
    return null;
  end if;

  if exists (
    select 1 from public.notification_suppressions
    where customer_id = p_customer_id and channel = 'email'
  ) then
    return null;
  end if;

  select public.resolve_customer_notification_email(p_customer_id) into v_email;

  if v_email is null then
    -- No email on file (or the customer's duplicate/merge status makes
    -- this an unsafe target) -- gracefully skip, exactly mirroring
    -- queue_whatsapp_notification's own "return null, no exception"
    -- behavior when a phone is unavailable. Never fabricates an
    -- address, never blocks the caller.
    return null;
  end if;

  -- Server-side email format validation -- directive section 33.
  -- Deliberately conservative (RFC 5322 is far looser than this, but
  -- this project's own convention -- see queue_whatsapp_notification's
  -- E.164 check -- is to validate strictly at queue time and suppress
  -- rather than let an obviously-malformed value reach the provider
  -- and burn retry attempts against it forever).
  if v_email !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then
    insert into public.notification_suppressions (club_id, customer_id, channel, reason, detail)
    values (p_club_id, p_customer_id, 'email', 'invalid_recipient', 'email failed format check at queue time')
    on conflict (customer_id, channel) do nothing;
    return null;
  end if;

  select coalesce(nc.preferred_language, 'ar') into v_language
  from public.customers c
  left join public.notification_consent nc
    on nc.club_id = c.club_id and nc.customer_id = c.id and nc.channel = 'whatsapp'
  where c.id = p_customer_id and c.club_id = p_club_id and c.duplicate_review_status = 'none';

  if v_language is null then
    v_language := 'ar';
  end if;

  v_scheduled_at := now();

  -- Channel-qualified dedup key (directive section 8) -- distinct
  -- from the WhatsApp write's own key for the SAME business event, so
  -- the two channels' queue rows never collide against the shared
  -- notification_queue.dedup_key unique constraint. Callers pass the
  -- same event-scoped base key used for the WhatsApp call (e.g.
  -- 'booking.created:' || booking_id); this function appends the
  -- channel suffix itself so call sites cannot forget it. A null
  -- p_dedup_key is passed through as null (no idempotency guard for
  -- that call site) rather than silently dropped -- every current
  -- call site in this codebase always passes one, so this is a
  -- defensive fallback, not the expected path.
  --
  -- Deliberately does NOT go through enqueue_notification() -- that
  -- function unconditionally requires a matching notification_consent
  -- row (WhatsApp-shaped, see this migration's header comment) and
  -- would return null for every single email send, since no
  -- email-channel consent rows will ever exist in that table. Inserts
  -- directly instead, reusing the identical idempotent on-conflict
  -- shape enqueue_notification() itself uses.
  v_dedup_key := case when p_dedup_key is not null then p_dedup_key || ':email' else null end;

  insert into public.notification_queue (
    club_id, event_id, channel, recipient_customer_id, recipient_email,
    template_key, language, variables, priority, scheduled_at, dedup_key
  )
  values (
    p_club_id, p_event_id, 'email', p_customer_id, v_email,
    p_template_key, v_language, p_variables, p_priority, v_scheduled_at, v_dedup_key
  )
  on conflict (dedup_key) where dedup_key is not null and status in ('pending', 'scheduled', 'processing', 'retrying')
  do nothing
  returning id into v_queue_id;

  return v_queue_id;
end;
$function$;

revoke all on function public.queue_email_notification(uuid, uuid, uuid, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.queue_email_notification(uuid, uuid, uuid, text, text, jsonb, text, text) to service_role;
