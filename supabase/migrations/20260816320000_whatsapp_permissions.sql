-- Gate 8: granular WhatsApp permissions per Doc 3's explicit list --
-- built on this codebase's existing permission system, never a
-- separate parallel one. Granted to club_owner/club_manager (the
-- broad-visibility roles, matching this session's established
-- precedent for notification.view/attendance.view).
insert into public.permissions (key, description)
values
  ('view_whatsapp', 'View WhatsApp module (overview, queue, history)'),
  ('manage_whatsapp_connection', 'Connect/disconnect the club''s WhatsApp session'),
  ('manage_whatsapp_templates', 'Create/edit WhatsApp message templates'),
  ('manage_whatsapp_automations', 'Create/edit WhatsApp automation rules'),
  ('view_whatsapp_history', 'View WhatsApp message history'),
  ('retry_whatsapp_messages', 'Manually retry or cancel failed WhatsApp messages')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r, public.permissions p
where r.key in ('club_owner', 'club_manager')
  and p.key in ('view_whatsapp', 'manage_whatsapp_connection', 'manage_whatsapp_templates', 'manage_whatsapp_automations', 'view_whatsapp_history', 'retry_whatsapp_messages')
on conflict do nothing;
