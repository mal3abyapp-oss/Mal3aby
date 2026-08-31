-- NOTIFICATIONS & COMMUNICATIONS ACCEPTANCE (D-NOTIF-001, Core P2):
-- get_customer_communications() -- the only customer-facing
-- notification-history RPC, powering Customer360's "Communication
-- history" tab -- hardcoded channel = 'whatsapp' in its notification_
-- queue query. Real, live, separately-tracked email notifications
-- (booking-created, payment-received, etc. -- proven actually sent via
-- Resend this phase, real provider_reference message IDs recorded)
-- were entirely invisible in this view. A staff member had no
-- practical way to answer "did the customer receive the booking
-- email?" without raw SQL, despite the underlying data already
-- existing and already being correctly RLS/permission-scoped
-- (notification.view, same guard this function already enforces).
--
-- Fix: widen the notification_queue query to both channels ('whatsapp'
-- and 'email'), union them into one chronologically-ordered history,
-- and add a `channel` field to each row so the UI can distinguish
-- them. The WhatsApp-specific `consent` block is UNCHANGED -- email
-- genuinely has no consent concept in this schema (queue_email_
-- notification's own suppression/category-preference checks are the
-- real email-side equivalent, not a per-customer consent flag), so
-- correctly stays WhatsApp-only rather than inventing a fake email
-- consent shape. Authorization/limit/offset logic is otherwise
-- byte-for-byte identical to the prior version.
create or replace function public.get_customer_communications(p_club_id uuid, p_customer_id uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_consent jsonb;
  v_rows jsonb;
  v_total bigint;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
    raise exception 'customer not found';
  end if;

  select jsonb_build_object(
    'enabled', nc.enabled, 'phone_e164', nc.phone_e164, 'consent_source', nc.consent_source,
    'consent_at', nc.consent_at, 'revoked_at', nc.revoked_at
  ) into v_consent
  from public.notification_consent nc
  where nc.customer_id = p_customer_id and nc.club_id = p_club_id and nc.channel = 'whatsapp';

  select count(*) into v_total from public.notification_queue nq
    where nq.recipient_customer_id = p_customer_id and nq.club_id = p_club_id and nq.channel in ('whatsapp', 'email');

  with page as (
    select nq.id, nq.channel, nq.template_key, nq.status, nq.created_at, nq.last_attempt_at
    from public.notification_queue nq
    where nq.recipient_customer_id = p_customer_id and nq.club_id = p_club_id and nq.channel in ('whatsapp', 'email')
    order by nq.created_at desc
    limit p_limit offset p_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id, 'channel', page.channel, 'template_key', page.template_key, 'status', page.status,
    'created_at', page.created_at, 'last_attempt_at', page.last_attempt_at
  ) order by page.created_at desc), '[]'::jsonb) into v_rows
  from page;

  return jsonb_build_object(
    'consent', v_consent,
    'events', jsonb_build_object('rows', v_rows, 'total_count', v_total)
  );
end;
$$;
