-- Security fix (self-identified, 2026-08-18): `revoke all on function X
-- from public` does NOT strip EXECUTE previously/separately granted to
-- the `anon`/`authenticated` roles -- `public` is a distinct
-- pseudo-role in PostgreSQL, and Supabase's default role setup grants
-- EXECUTE on newly created functions to anon/authenticated
-- independently of the PUBLIC grant. Discovered while verifying grants
-- on the newly fenced whatsapp_connector_report_status(): a fresh
-- information_schema.routine_privileges scan showed anon/authenticated
-- still listed as grantees on it, and on two other RPCs created in an
-- earlier session with the same (insufficient) revoke pattern --
-- whatsapp_connector_write_delivery_trace and
-- whatsapp_connector_upsert_incident. Every other whatsapp_connector_*
-- function was confirmed correctly service_role/postgres-only, so this
-- was isolated to exactly these three, not a systemic issue.
--
-- Fix: explicitly name anon, authenticated in the revoke (not just
-- public) for all three affected functions. Verified after applying:
-- information_schema.routine_privileges shows only postgres/service_role
-- for all whatsapp_connector_* functions, and a Supabase security
-- advisor scan shows no advisories referencing any of the three.

revoke all on function public.whatsapp_connector_report_status(uuid, text, text, integer, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.whatsapp_connector_report_status(uuid, text, text, integer, text, text, integer, integer) to service_role;

revoke all on function public.whatsapp_connector_write_delivery_trace(uuid, uuid, integer, text, text, text, integer, text, jsonb, text, timestamptz, timestamptz, integer, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.whatsapp_connector_write_delivery_trace(uuid, uuid, integer, text, text, text, integer, text, jsonb, text, timestamptz, timestamptz, integer, text, text, text, text, boolean) to service_role;

revoke all on function public.whatsapp_connector_upsert_incident(uuid, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.whatsapp_connector_upsert_incident(uuid, text, text, text, boolean, text) to service_role;
