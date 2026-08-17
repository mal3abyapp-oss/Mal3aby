-- Bug found while building the connector's ConnectionRequestPoller
-- (task #94): whatsapp_connector_list_accounts() only returned clubs
-- with session_credentials_encrypted is not null -- correct for the
-- STARTUP restore pass (task #92's original intent), but the connector
-- ALSO polls this same RPC to discover brand-new pairing requests
-- (start_whatsapp_pairing() flips a club's row to 'connecting' with no
-- session yet, since it has never connected before). Under the
-- original filter, a club's very first "Connect WhatsApp" click would
-- never be picked up by the connector -- it would sit at status
-- 'connecting' forever with no QR ever generated.
--
-- Fix: also include rows with status = 'connecting' regardless of
-- whether a session exists yet. This is additive (widens what the
-- existing function returns) and doesn't change the startup-restore
-- use case, which already only acts on rows that also have a real
-- session to restore.
create or replace function public.whatsapp_connector_list_accounts()
returns table(club_id uuid, status text)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select wa.club_id, wa.status from public.whatsapp_accounts wa
  where wa.session_credentials_encrypted is not null
     or wa.status = 'connecting';
$$;

revoke execute on function public.whatsapp_connector_list_accounts() from public, anon, authenticated;

comment on function public.whatsapp_connector_list_accounts() is
  'Connector-only (service-role). Returns clubs with a persisted session (for startup restore) UNION clubs currently in connecting status with no session yet (for first-time pairing discovery via ConnectionRequestPoller). Both use cases share one RPC so the connector has a single source of truth for "which clubs need my attention right now".';
