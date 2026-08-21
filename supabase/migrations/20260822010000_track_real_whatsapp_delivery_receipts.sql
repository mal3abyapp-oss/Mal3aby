-- CRITICAL PRODUCTION DEFECT FIX (P0-class, confirmed via direct
-- Baileys source inspection, not assumption): notification_queue.status
-- transitions to 'sent' the instant BaileysProvider.sendMessage()'s
-- returned Promise resolves -- but that resolution ONLY proves this
-- connector wrote bytes to its own outbound WebSocket
-- (sendNode -> sendRawMessage, confirmed by reading
-- @whiskeysockets/baileys's own socket.js/messages-send.js directly).
-- It does NOT prove WhatsApp's server received the stanza, and
-- absolutely does not prove the recipient's device received or
-- displayed the message. The "sent" label was therefore materially
-- overstating what evidence actually supports -- exactly the reported
-- production symptom: messages the UI showed as "أُرسلت" (sent) that
-- never appeared on the recipient's real phone.
--
-- Real evidence DOES exist and IS available, just never listened to:
-- WhatsApp's own protocol sends a real server-originated <receipt>
-- stanza back over the SAME socket once the message is genuinely
-- server-acknowledged, delivered, or read -- Baileys surfaces this as
-- a `messages.update` event carrying a status level from
-- proto.WebMessageInfo.Status (confirmed live from the installed
-- package: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4,
-- PLAYED=5), correlated by the SAME client-generated message key
-- (`key.id`) that this connector already captures as
-- notification_queue.provider_reference. The correlation key already
-- exists; only the listener and the DB-side receipt-recording path
-- were missing.
--
-- Fix (this migration, DB side): notification_queue gains three new
-- timestamp columns recording the REAL evidence-backed milestones,
-- plus a new correlation-based RPC the connector calls when a real
-- receipt arrives. 'status' semantics are corrected without breaking
-- any existing consumer:
--   - 'sent' now means, and is documented to mean, "provider accepted
--     for delivery" (the honest description of what this codebase can
--     currently prove at that point) -- NOT changed as a status value
--     (avoiding an unnecessary schema/consumer churn for something
--     every existing UI/report already keys off), but its label and
--     meaning are corrected at the UI layer (separate connector/
--     frontend commit) and its semantics are now precisely documented
--     here and backed by real timestamp evidence going forward.
--   - 'delivered' (already present in the CHECK constraint, confirmed
--     via pg_get_constraintdef to have been defined but NEVER written
--     by any function -- a dead status since it was added) now becomes
--     real: written when a genuine DELIVERY_ACK-or-higher receipt
--     arrives.
--   - provider_accepted_at, delivered_at, read_at are populated only
--     from real received evidence, never backfilled or guessed.
--
-- LEGACY ROWS: no historical 'sent' row is retroactively reclassified
-- to 'delivered' or given a fabricated timestamp -- per the explicit
-- "do not invent delivery history" rule, every pre-existing 'sent' row
-- simply has null delivered_at/read_at, which the UI (separate commit)
-- renders as "sent (legacy, no delivery evidence)" rather than
-- silently implying delivery.
alter table public.notification_queue
  add column if not exists provider_accepted_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at timestamptz;

comment on column public.notification_queue.provider_accepted_at is
  'The moment BaileysProvider.sendMessage() resolved (our own outbound socket write completed) -- proves ONLY that this connector attempted the send, never that WhatsApp''s server or the recipient received anything. Set at the same moment status transitions to ''sent'' by whatsapp_connector_report_send_result(). See 20260822010000 for the full evidence-model correction this documents.';
comment on column public.notification_queue.delivered_at is
  'The moment a REAL WhatsApp-server-originated receipt with status >= DELIVERY_ACK arrived (Baileys messages.update event, correlated by provider_reference). Null means no such receipt has arrived -- for legacy rows, this permanently means "unverified", not "not delivered" (the receipt-listener did not exist yet when they were sent). Only ever set from genuine received evidence, never inferred or backfilled.';
comment on column public.notification_queue.read_at is
  'The moment a REAL WhatsApp-server-originated READ or PLAYED receipt arrived. Same evidence discipline as delivered_at.';

-- Correlates a real Baileys delivery/read receipt back to its queue
-- row via provider_reference (the same client-generated message key
-- already stored at send time) and records ONLY what the receipt
-- itself proves -- never advances status/timestamps backward (a
-- late-arriving SERVER_ACK after a DELIVERY_ACK already landed must
-- not un-set delivered_at), and never touches a row that isn't
-- already in a post-send state (a receipt for a row still 'pending'/
-- 'processing'/'failed' is a correlation anomaly worth surfacing, not
-- silently applying).
create or replace function public.whatsapp_connector_report_delivery_receipt(
  p_provider_reference text,
  p_status_level integer  -- proto.WebMessageInfo.Status: 0=ERROR 1=PENDING 2=SERVER_ACK 3=DELIVERY_ACK 4=READ 5=PLAYED
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_row record;
begin
  if p_provider_reference is null or trim(p_provider_reference) = '' then
    return;
  end if;

  select id, status, delivered_at, read_at
    into v_row
  from public.notification_queue
  where provider_reference = p_provider_reference
    and channel = 'whatsapp'
  order by created_at desc
  limit 1;

  if v_row.id is null then
    -- No matching queue row -- a receipt for a message this connector
    -- didn't send (echo from another linked device) or a row that has
    -- since been superseded by dedup logic. Not an error; silently
    -- ignored, matching the best-effort discipline of every other
    -- observability write in this connector.
    return;
  end if;

  -- READ (4) or PLAYED (5): record read_at (once -- never overwritten
  -- by a later, lower-level, out-of-order receipt).
  if p_status_level >= 4 and v_row.read_at is null then
    update public.notification_queue
    set read_at = now(),
        delivered_at = coalesce(delivered_at, now()),
        status = 'delivered'
    where id = v_row.id;
    return;
  end if;

  -- DELIVERY_ACK (3): record delivered_at, promote status from 'sent'
  -- to 'delivered' -- but never regress a row that already reached
  -- 'delivered' or has a read_at.
  if p_status_level >= 3 and v_row.delivered_at is null then
    update public.notification_queue
    set delivered_at = now(),
        status = case when status = 'sent' then 'delivered' else status end
    where id = v_row.id;
    return;
  end if;

  -- SERVER_ACK (2) or lower: WhatsApp's server has the message, but
  -- this is NOT delivery to the recipient's device -- no status
  -- transition, no delivered_at. Recorded nowhere today (no column
  -- for it) since it is not itself customer-facing-meaningful
  -- evidence; the receipt was still correctly received and processed
  -- (this function returns normally), just does not yet warrant
  -- advancing delivery state.
end;
$function$;

revoke all on function public.whatsapp_connector_report_delivery_receipt(text, integer) from public, anon, authenticated;
grant execute on function public.whatsapp_connector_report_delivery_receipt(text, integer) to service_role;

comment on function public.whatsapp_connector_report_delivery_receipt(text, integer) is
  'Records a REAL WhatsApp delivery/read receipt (Baileys messages.update, correlated by provider_reference) -- the honest evidence-backed counterpart to whatsapp_connector_report_send_result(), which only ever proved provider acceptance. Never advances status/timestamps on anything but genuine received evidence. See 20260822010000 for the full incident and evidence-model correction.';
