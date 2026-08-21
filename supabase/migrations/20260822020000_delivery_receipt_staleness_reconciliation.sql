-- WHATSAPP DELIVERY TRUTH fix, reconciliation/timeout policy
-- (directive sections 16-17): a notification_queue row that reached
-- 'sent' (provider-accepted) but never received a real delivery
-- receipt must not silently stay indistinguishable from a
-- freshly-accepted, still-in-flight send forever -- but it also must
-- never be auto-promoted to 'delivered' (no evidence) nor
-- auto-demoted to 'failed' (provider acceptance was real evidence;
-- absence of a receipt is not proof of failure -- WhatsApp does not
-- guarantee timely receipts, especially if the recipient's device is
-- offline).
--
-- Design choice: NO new terminal status value is added to
-- notification_queue.status (avoiding another round of UI/report
-- consumer churn, matching the precedent set in 20260822010000).
-- Instead, "is this row's delivery confirmation unusually overdue" is
-- exposed as a READ-TIME COMPUTED value, not a written column -- this
-- guarantees zero race with a real receipt arriving late (there is no
-- stored "stale" flag that could go stale itself or need to be
-- cleared), and guarantees the computation always reflects the
-- current wall-clock, not a snapshot from whenever a background job
-- last ran.
--
-- Threshold: 5 minutes past provider_accepted_at with no delivered_at
-- is treated as "confirmation overdue" -- chosen generously above
-- typical real-world WhatsApp receipt latency (usually seconds) to
-- avoid false alarms for recipients who are briefly offline, while
-- still surfacing genuinely stuck sends within a reasonable
-- operational window. This is a UI/reporting signal only -- it never
-- changes notification_queue.status itself.
create or replace function public.whatsapp_delivery_confirmation_overdue(
  p_status text,
  p_provider_accepted_at timestamptz,
  p_delivered_at timestamptz
)
returns boolean
language sql
stable
as $function$
  select p_status = 'sent'
     and p_provider_accepted_at is not null
     and p_delivered_at is null
     and now() - p_provider_accepted_at > interval '5 minutes'
$function$;

comment on function public.whatsapp_delivery_confirmation_overdue(text, timestamptz, timestamptz) is
  'Read-time-only reconciliation signal (WHATSAPP DELIVERY TRUTH fix, directive sections 16-17): true when a notification_queue row has been provider-accepted (status=sent) for over 5 minutes with no delivery receipt. Never written to storage, never changes status -- a later real receipt is always still honored normally. Used by reporting/UI to surface "confirmation overdue" distinctly from both a normal in-flight send and a confirmed delivery, without ever fabricating a failure or delivery that was not evidenced.';

grant execute on function public.whatsapp_delivery_confirmation_overdue(text, timestamptz, timestamptz) to authenticated, service_role;

-- Companion read-only view for the production audit requested in
-- directive section 21 ("how many messages were shown as Sent with
-- zero delivery evidence") and ongoing operational monitoring. No PII
-- beyond what notification_queue already stores; RLS on the
-- underlying table still applies to callers, this view adds no new
-- access.
create or replace view public.whatsapp_delivery_evidence_summary
with (security_invoker = true) as
select
  club_id,
  count(*) filter (where status in ('sent', 'delivered')) as total_provider_accepted,
  count(*) filter (where status = 'sent' and delivered_at is null) as provider_accepted_no_delivery_evidence,
  count(*) filter (where delivered_at is not null) as with_delivery_receipt,
  count(*) filter (where read_at is not null) as with_read_receipt,
  count(*) filter (
    where public.whatsapp_delivery_confirmation_overdue(status, provider_accepted_at, delivered_at)
  ) as confirmation_overdue,
  count(*) filter (where status = 'failed') as failed
from public.notification_queue
where channel = 'whatsapp'
group by club_id;

comment on view public.whatsapp_delivery_evidence_summary is
  'Per-club, no-PII rollup of real WhatsApp delivery evidence (WHATSAPP DELIVERY TRUTH fix). Answers directive section 21: how many messages show as provider-accepted with zero delivery evidence, vs genuinely confirmed delivered/read, vs overdue.';
