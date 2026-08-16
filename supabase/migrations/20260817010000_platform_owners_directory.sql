-- Gate 13 task #55: platform owner "Owners/Customers" page.
--
-- Audit finding: the platform owner console (PlatformClubsPage,
-- PlatformClubDetailPage) has no visibility into WHO owns each club --
-- there is no owner_id on clubs; ownership is expressed as a
-- club_memberships row with role_id -> roles.key = 'club_owner'.
-- Platform Owner currently has to query the database directly to find
-- "which clubs does this email own" or "who owns club X" -- a genuine
-- commercial-operations gap (support, billing disputes, fraud checks
-- all need this).
--
-- auth.users.email is not safely exposed through a plain
-- security_invoker view (RLS does not gate auth.users the way it gates
-- public tables), so this follows the get_club_platform_access()-style
-- convention already used throughout this schema: a SECURITY DEFINER
-- function that explicitly checks is_platform_owner() before returning
-- any row, rather than relying on RLS/grants alone.

create or replace function public.get_platform_club_owners()
returns table (
  club_id uuid,
  club_name text,
  club_code text,
  club_status text,
  membership_id uuid,
  membership_status text,
  user_id uuid,
  full_name text,
  phone text,
  email text,
  owner_since timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  return query
  select
    c.id as club_id,
    c.name_ar as club_name,
    c.club_code,
    c.status as club_status,
    cm.id as membership_id,
    cm.status as membership_status,
    cm.user_id,
    p.full_name,
    p.phone,
    u.email::text,
    cm.created_at as owner_since
  from public.club_memberships cm
  join public.roles r on r.id = cm.role_id and r.key = 'club_owner'
  join public.clubs c on c.id = cm.club_id
  join public.profiles p on p.user_id = cm.user_id
  join auth.users u on u.id = cm.user_id
  order by cm.created_at desc;
end;
$$;

revoke execute on function public.get_platform_club_owners() from public, anon;
grant execute on function public.get_platform_club_owners() to authenticated;

comment on function public.get_platform_club_owners() is
  'Platform Owner directory: every club_owner membership joined to its club and auth identity (name/phone/email). Explicitly checks is_platform_owner() itself since it must read auth.users, which RLS does not gate the way it gates public tables.';
