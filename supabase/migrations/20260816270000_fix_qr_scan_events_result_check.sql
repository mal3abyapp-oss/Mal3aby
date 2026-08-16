-- Gate 6 bug fix, caught via real black-box RPC testing: the new
-- 'subscription_inactive' scan result (added in
-- 20260816250000_fix_qr_attendance_subscription_check.sql, to close
-- the "Active Entitlement" gap in qr_mark_attendance) crashed on the
-- pre-existing qr_scan_events_result_check constraint, which predates
-- this fix and didn't know about the new value.
alter table public.qr_scan_events drop constraint qr_scan_events_result_check;
alter table public.qr_scan_events add constraint qr_scan_events_result_check
  check (result = any (array['success','already_used','expired','invalid','wrong_club','permission_denied','subscription_inactive']));
