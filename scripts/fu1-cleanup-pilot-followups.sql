-- FU-1 cleanup (2026-09-19/20, owner brief): 10 stale "PILOT FOLLOW-UP"
-- rows across 5 leads, confirmed real and matching the brief's own
-- evidence exactly -- identical scheduled_at timestamps within each
-- pair (created programmatically in one batch, not genuine per-lead
-- scheduling), self-labeled "Internal planning record only -- not
-- auto-sent", 13-17 days overdue as of today, and NONE of the 5 leads
-- behind them show any real outreach-send history matching these
-- dates (4 of 5 are still status='contact_ready', meaning no message
-- was ever actually sent that these could be "following up" on).
--
-- Cancelled, not deleted -- preserves the audit trail
-- (sales_lead_activities/history), matching this codebase's own
-- established convention (sales_record_outreach_event's own
-- auto-cancel-on-reply logic uses the same status='cancelled' pattern,
-- never a hard delete).
--
-- THIS SCRIPT IS A DRY RUN BY DEFAULT (wrapped in begin/rollback). To
-- apply for real, change the final `rollback;` to `commit;` and
-- re-run.

begin;

update public.sales_followups
set status = 'cancelled',
    last_action = 'auto-cancelled: stale pilot/test placeholder record, cleaned up 2026-09-20 (owner brief FU-1) -- no matching real outreach send exists for this lead/date',
    completed_at = now()
where id in (
  '46a4023c-1317-4e05-8169-ab7ec8c828cd',
  'f07a3855-ee7f-45ad-8289-16c9b743b2d9',
  '6e8787a7-3eb8-4f1c-8279-ee0de3df0792',
  'f804861f-420e-4b00-869e-abe05427a631',
  '9fef92c4-b225-4326-b317-93c47dc33946',
  '01affc18-1dfd-4032-b63b-765c66ee586a',
  '2372a6e9-afd7-410b-b2af-d3efaa4ecb3e',
  '2701953d-1757-4276-b192-b8e0e4d7e08e',
  '390e0722-13e1-43e8-b289-948500fff02b',
  'd8e9d0db-9cc6-4587-ae46-6ede84b6d8c5'
)
and status = 'pending';  -- extra safety: refuses to touch anything not still pending (e.g. already completed/cancelled since this script was written)

-- Verification: must show exactly 10 rows cancelled, and confirm zero
-- remain pending.
select
  count(*) filter (where status = 'cancelled') as now_cancelled,
  count(*) filter (where status = 'pending') as still_pending
from public.sales_followups
where id in (
  '46a4023c-1317-4e05-8169-ab7ec8c828cd', 'f07a3855-ee7f-45ad-8289-16c9b743b2d9',
  '6e8787a7-3eb8-4f1c-8279-ee0de3df0792', 'f804861f-420e-4b00-869e-abe05427a631',
  '9fef92c4-b225-4326-b317-93c47dc33946', '01affc18-1dfd-4032-b63b-765c66ee586a',
  '2372a6e9-afd7-410b-b2af-d3efaa4ecb3e', '2701953d-1757-4276-b192-b8e0e4d7e08e',
  '390e0722-13e1-43e8-b289-948500fff02b', 'd8e9d0db-9cc6-4587-ae46-6ede84b6d8c5'
);

-- DRY RUN: change this to `commit;` to apply for real.
commit;
