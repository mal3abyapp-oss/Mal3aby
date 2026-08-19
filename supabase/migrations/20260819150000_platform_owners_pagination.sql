-- Platform Owner directive, Phase I (I1): PlatformOwnersPage's
-- get_platform_club_owners() pulled every club-owner membership row in
-- one shot with no pagination at all, unlike Clubs List's explicit
-- range()-based paging -- a real, confirmed scaling gap even though
-- invisible at the current real club count. Adds p_search (server-side,
-- so pagination and search interact correctly instead of only filtering
-- the current page) plus p_limit/p_offset, defaulting to a page size
-- large enough that today's real dataset still returns in one page
-- (no visible behavior change at current scale, closes the gap for
-- when it isn't).
create or replace function public.get_platform_club_owners(
  p_search text default null,
  p_limit int default 100,
  p_offset int default 0
)
returns table(
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
set search_path to 'public', 'pg_temp'
as $function$
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
  where p_search is null or p_search = ''
     or p.full_name ilike '%' || p_search || '%'
     or u.email ilike '%' || p_search || '%'
     or p.phone ilike '%' || p_search || '%'
     or c.name_ar ilike '%' || p_search || '%'
     or c.club_code ilike '%' || p_search || '%'
  order by cm.created_at desc
  limit p_limit offset p_offset;
end;
$function$;

revoke all on function public.get_platform_club_owners(text, int, int) from public;
revoke all on function public.get_platform_club_owners(text, int, int) from anon;
grant execute on function public.get_platform_club_owners(text, int, int) to authenticated;

-- Drop the old 0-arg signature -- fully replaced, not overloaded.
drop function if exists public.get_platform_club_owners();
