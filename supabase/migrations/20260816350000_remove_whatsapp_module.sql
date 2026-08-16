-- Remove the entire WhatsApp module, per explicit user instruction
-- (2026-08-16): after repeated environment blockers prevented reaching
-- a real, verifiable end-to-end WhatsApp connection in this session
-- (Docker/WSL2 unavailable, Supabase CLI login non-interactive-only,
-- tunnel URLs inherently temporary), the user asked to remove
-- everything WhatsApp-specific while explicitly preserving the
-- channel-agnostic Notification Core abstraction (notification_events/
-- notification_queue/notification_consent, emit_notification_event(),
-- enqueue_notification()) so a future messaging channel (WhatsApp or
-- otherwise) can be added later as a connector-only change, with no
-- schema rework needed in the Notification Core itself.
--
-- Confirmed via a direct FK-dependency query before writing this
-- migration that zero other tables reference any of the four tables
-- being dropped here -- this module has no downstream dependents.
-- Confirmed real row counts beforehand: whatsapp_connections (1),
-- whatsapp_connection_events (13) -- both this session's own QA/test
-- data from verifying the connector, not real business data.
-- whatsapp_templates and whatsapp_automations were both empty (0 rows)
-- -- no club had ever configured a real template or automation rule.

drop function if exists public.disconnect_whatsapp(uuid);
drop function if exists public.start_whatsapp_pairing(uuid);
drop function if exists public.get_whatsapp_connection_status(uuid);
drop trigger if exists trg_validate_whatsapp_template_variables on public.whatsapp_templates;
drop function if exists public.validate_whatsapp_template_variables();

drop table if exists public.whatsapp_automations;
drop table if exists public.whatsapp_templates;
drop table if exists public.whatsapp_connection_events;
drop table if exists public.whatsapp_connections;

delete from public.role_permissions
where permission_id in (
  select id from public.permissions
  where key in (
    'view_whatsapp', 'manage_whatsapp_connection', 'manage_whatsapp_templates',
    'manage_whatsapp_automations', 'view_whatsapp_history', 'retry_whatsapp_messages'
  )
);

delete from public.permissions
where key in (
  'view_whatsapp', 'manage_whatsapp_connection', 'manage_whatsapp_templates',
  'manage_whatsapp_automations', 'view_whatsapp_history', 'retry_whatsapp_messages'
);
