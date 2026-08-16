-- Gate 7: notification.view permission (referenced by the Gate 7
-- notification_core RLS policies) didn't exist yet -- confirmed via
-- direct query before writing the policies that referenced it.
-- Granted to club_owner and club_manager, matching the precedent set
-- earlier this session for attendance.view (broad-visibility roles get
-- read access to operational monitoring data; day-to-day staff like
-- receptionist/coach don't need to see the notification queue).
insert into public.permissions (key, description)
values ('notification.view', 'View notification events and delivery queue')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r, public.permissions p
where r.key in ('club_owner', 'club_manager')
  and p.key = 'notification.view'
on conflict do nothing;
