-- Master IA/UX audit (Reports architecture phase, Audit 1): confirmed
-- 4 canonical metrics are each computed by TWO independently-written
-- SQL bodies rather than one shared source:
--   - total_revenue / revenue_by_day / refunds_total:
--       get_executive_dashboard() vs get_revenue_report()
--   - outstanding_total:
--       get_today_dashboard() vs get_executive_dashboard()
--       (both independently sum the same public.outstanding_invoices view)
--   - active_enrollments:
--       get_executive_dashboard() vs get_academy_report()
--   - new_customers:
--       get_executive_dashboard() vs get_customer_activity_report()
--
-- These stay consistent today only by CONVENTION (each was hand-written
-- to mirror the other's predicate) -- confirmed by the pre-existing
-- comment in 20260816310000_gate11_executive_and_booking_reports.sql
-- ("Revenue figures reuse the exact payments/refunds predicates as
-- get_revenue_report... same source of truth, not reinvented"), which
-- is a documentation guarantee, not a code-level one. A future edit to
-- one predicate (e.g. adding a branch filter, changing a status list)
-- can silently desync the other WITHOUT any compiler, RLS policy, or
-- existing test catching it.
--
-- This migration does NOT change any function behavior, signature, or
-- return shape -- pure `comment on function` statements, zero
-- regression risk. It cross-references each duplicated-predicate
-- function pair so anyone editing one is pointed at the other. A full
-- SQL-level consolidation (extracting each predicate into a shared
-- SQL function/view both RPCs call) is a legitimate follow-up but is
-- NOT done here -- that's a genuine behavior-risk change to live
-- financial RPCs, out of scope for an IA/documentation fix, and this
-- codebase's own history has a real prior incident (a parameter-order
-- regression on a booking RPC) as a cautionary example of why RPC
-- signature/body edits need to be done carefully and separately from
-- documentation passes.

comment on function public.get_executive_dashboard(uuid, date, date) is
  'Dashboard/Reports Overview KPI aggregate for a date range. '
  'DUPLICATE-PREDICATE WARNING: total_revenue/revenue_by_day/refunds_total '
  'mirror get_revenue_report()''s predicate (kept in sync by convention, not '
  'shared code -- see 20260816310000_gate11_executive_and_booking_reports.sql). '
  'outstanding_total mirrors get_today_dashboard()''s (both sum '
  'public.outstanding_invoices independently). active_enrollments mirrors '
  'get_academy_report()''s. new_customers mirrors get_customer_activity_report()''s. '
  'If you change any of these predicates here, change the matching predicate in '
  'the paired function too, or the two screens that read them will silently disagree.';

comment on function public.get_revenue_report(uuid, date, date, uuid, text) is
  'Revenue-by-method/day report for a date range. DUPLICATE-PREDICATE WARNING: '
  'total_revenue/by_day/refunds_total (unfiltered) mirror '
  'get_executive_dashboard()''s predicate -- see that function''s comment.';

comment on function public.get_academy_report(uuid, date, date) is
  'Academy enrollment/attendance report for a date range. DUPLICATE-PREDICATE '
  'WARNING: active_enrollments mirrors get_executive_dashboard()''s predicate -- '
  'see that function''s comment.';

comment on function public.get_customer_activity_report(uuid, date, date) is
  'New-customer/top-spender report for a date range. DUPLICATE-PREDICATE WARNING: '
  'new_customers mirrors get_executive_dashboard()''s predicate -- see that '
  'function''s comment.';

comment on function public.get_today_dashboard(uuid) is
  'Today-scoped operational dashboard (bookings/revenue/outstanding for the '
  'current day). DUPLICATE-PREDICATE WARNING: outstanding_total mirrors '
  'get_executive_dashboard()''s predicate (both sum public.outstanding_invoices '
  'independently) -- see that function''s comment.';
