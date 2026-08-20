-- P1 security fix: reporting RPCs were SECURITY DEFINER and therefore
-- bypassed the branch-aware RLS enforced on their source tables. A scoped
-- user could explicitly request another branch and receive its operational
-- and financial aggregates. Run these read-only report functions as the
-- authenticated invoker so the same RLS boundary applies to detail and
-- aggregate views.

alter function public.get_academy_report(uuid, date, date) security invoker;
alter function public.get_booking_report(uuid, date, date, uuid) security invoker;
alter function public.get_collections_report(uuid, date, date, uuid) security invoker;
alter function public.get_customer_activity_report(uuid, date, date) security invoker;
alter function public.get_employee_liability_report(uuid, date, date) security invoker;
alter function public.get_executive_dashboard(uuid, date, date) security invoker;
alter function public.get_field_occupancy_report(uuid, date, date, uuid) security invoker;
alter function public.get_financial_exceptions_report(uuid, date, date) security invoker;
alter function public.get_financial_reconciliation_report(uuid, date, date, uuid) security invoker;
alter function public.get_official_receipts_report(uuid, date, date, text, text, text, uuid, uuid, uuid, text, text) security invoker;
alter function public.get_payment_method_report(uuid, date, date, uuid) security invoker;
alter function public.get_revenue_report(uuid, date, date, uuid, text) security invoker;

comment on function public.get_booking_report(uuid, date, date, uuid) is
  'RLS-aware operational report. SECURITY INVOKER is required so branch-scoped memberships cannot aggregate another branch through a definer bypass.';
comment on function public.get_revenue_report(uuid, date, date, uuid, text) is
  'RLS-aware financial report. SECURITY INVOKER preserves tenant and branch isolation on payments/refunds.';
