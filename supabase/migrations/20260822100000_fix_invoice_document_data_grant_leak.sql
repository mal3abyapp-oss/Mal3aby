-- WHATSAPP BUSINESS MESSAGING FINAL HARDENING (2026-08-22) -- CRITICAL
-- security regression found via the Security Advisor re-check
-- (directive item 22/23): migration 20260822090000's DROP FUNCTION +
-- CREATE FUNCTION sequence for whatsapp_connector_get_invoice_
-- document_data() reset Postgres's default grants -- a newly created
-- function automatically grants EXECUTE to PUBLIC, which (via
-- Supabase's standard PUBLIC -> anon/authenticated role membership)
-- silently re-opened this function to BOTH anon and authenticated,
-- when the original, pre-existing function was correctly restricted
-- to service_role/postgres only (confirmed via information_schema.
-- routine_privileges immediately before writing 20260822090000 -- the
-- migration's own doc comment even states this, but the fix only
-- re-granted service_role explicitly and never revoked PUBLIC's
-- default grant, which is what actually causes anon/authenticated
-- exposure).
--
-- Real impact confirmed: this function returns customer_name,
-- receipt_serial (real government receipt numbers), player_name, and
-- full financial totals for ANY invoice_id passed in -- with anon
-- access, literally anyone (no login required) could have enumerated
-- this data for any invoice in the entire database via
-- /rest/v1/rpc/whatsapp_connector_get_invoice_document_data. Confirmed
-- via direct Security Advisor re-scan after the 20260822090000
-- migration -- caught within the same QA session, before any
-- unauthorized access is known to have occurred (this function has no
-- separate authorization check of its own -- it was never designed to
-- be called by anything other than the connector's own service_role
-- client, so its safety depends entirely on the grant being correctly
-- restricted).
--
-- Fix: explicit REVOKE from PUBLIC (which also removes anon/
-- authenticated's inherited access) plus explicit REVOKE from anon/
-- authenticated directly for defense in depth, leaving only
-- service_role able to call this function -- restoring the exact
-- grant state that existed before migration 20260822090000.
revoke all on function public.whatsapp_connector_get_invoice_document_data(uuid) from public;
revoke all on function public.whatsapp_connector_get_invoice_document_data(uuid) from anon;
revoke all on function public.whatsapp_connector_get_invoice_document_data(uuid) from authenticated;
grant execute on function public.whatsapp_connector_get_invoice_document_data(uuid) to service_role;
