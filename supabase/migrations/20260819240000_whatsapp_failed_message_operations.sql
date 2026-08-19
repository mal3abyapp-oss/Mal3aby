-- HIGH-ROI UX PASS 01, Priority 1: WhatsApp Failed Messages must become
-- an actionable operational exception, not a passive number. This
-- migration adds the read/write surface needed for the Overview card's
-- drill-down and a safe retry action.
--
-- get_whatsapp_failed_messages(p_club_id) -- staff-scoped list of
-- failed queue rows with the real recipient name/phone (resolved via
-- recipient_customer_id, never the always-NULL recipient_phone column
-- -- see Priority 2/finding "Recipient visibility") and, where the
-- underlying booking/payment is still resolvable, its reference for a
-- "open booking" link. Gated the same way WhatsAppActivityTab's own
-- direct .from('notification_queue') read already is: RLS
-- (notification_queue_select_own_club, requires notification.view) is
-- sufficient for a read -- this RPC exists only to add the joins the
-- frontend would otherwise have to do as N+1 client-side lookups.
--
-- retry_failed_whatsapp_message(p_queue_id) -- the only new WRITE
-- surface. Confirmed safe against whatsapp_connector_claim_next_batch()
-- directly: that function only ever claims status IN
-- ('pending','retrying'), never 'failed' -- so a 'failed' row is
-- permanently inert today, and resetting it to 'pending' is the only
-- way it re-enters the real send pipeline. Cannot create a duplicate
-- send: notification_queue_dedup_active_idx is a unique index on
-- dedup_key scoped to active statuses, and this retry mutates the SAME
-- existing row (same id, same dedup_key) rather than inserting a new
-- one. Re-validates notification_source_still_valid() with the row's
-- own event_type/reference before resetting -- exactly the same check
-- the connector's own claim function applies -- so a message for an
-- already-cancelled booking cannot be resurrected by a manual retry.
-- Gated on manage_whatsapp_connection (REUSE, not a new permission
-- row): same WhatsApp-domain, same trust tier (Club Owner/Manager/
-- Branch Manager only, confirmed via role_permissions) as the existing
-- connect/disconnect action this permission already governs.

create or replace function public.get_whatsapp_failed_messages(p_club_id uuid)
returns table(
  id uuid,
  template_key text,
  status text,
  last_error text,
  attempts integer,
  created_at timestamptz,
  last_attempt_at timestamptz,
  recipient_customer_id uuid,
  recipient_name text,
  recipient_phone text,
  reference_type text,
  reference_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('notification.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
    select
      nq.id, nq.template_key, nq.status, nq.last_error, nq.attempts,
      nq.created_at, nq.last_attempt_at, nq.recipient_customer_id,
      c.full_name as recipient_name,
      coalesce(nq.recipient_phone, c.mobile_display) as recipient_phone,
      ne.reference_type, ne.reference_id
    from public.notification_queue nq
    left join public.notification_events ne on ne.id = nq.event_id
    left join public.customers c on c.id = nq.recipient_customer_id
    where nq.club_id = p_club_id
      and nq.channel = 'whatsapp'
      and nq.status = 'failed'
    order by nq.last_attempt_at desc nulls last, nq.created_at desc
    limit 200;
end;
$$;

revoke execute on function public.get_whatsapp_failed_messages(uuid) from anon;

create or replace function public.retry_failed_whatsapp_message(p_queue_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
begin
  select nq.id, nq.club_id, nq.status, ne.reference_type, ne.reference_id, ne.event_type
    into v_row
    from public.notification_queue nq
    left join public.notification_events ne on ne.id = nq.event_id
    where nq.id = p_queue_id and nq.channel = 'whatsapp';

  if v_row.id is null then
    raise exception 'message not found';
  end if;

  if not (v_row.club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', v_row.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_row.status <> 'failed' then
    raise exception 'only a permanently failed message can be retried';
  end if;

  if v_row.reference_type is not null
     and not public.notification_source_still_valid(v_row.reference_type, v_row.reference_id, v_row.event_type) then
    raise exception 'this message''s booking/payment is no longer valid -- it cannot be retried';
  end if;

  update public.notification_queue
  set status = 'pending',
      attempts = 0,
      next_attempt_at = null,
      last_error = null,
      scheduled_at = now()
  where id = p_queue_id;

  perform public.write_audit_log(v_row.club_id, 'whatsapp.message.retry', 'notification_queue', p_queue_id, null,
    jsonb_build_object('previous_status', 'failed'), null);
end;
$$;

revoke execute on function public.retry_failed_whatsapp_message(uuid) from anon;
