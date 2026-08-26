-- PLATFORM STAFF EXTENSION -- has_platform_support_access() previously
-- required is_platform_owner() unconditionally, which would have made
-- the just-widened start_platform_support_session() pointless: a
-- Platform Support employee could START a session but every downstream
-- RLS policy/RPC gated on has_platform_support_access() would still deny
-- them, since is_platform_owner() is genuinely false for them. Widened
-- to accept either authority, mirroring start_platform_support_session's
-- own condition exactly (defense-in-depth, not just relying on "a
-- session row exists" alone) -- and re-checks the MODE-appropriate
-- platform permission specifically when p_require_manage is requested,
-- so a Platform Support employee (start_view only, no start_manage)
-- still cannot satisfy a MANAGE-mode check even if they somehow held a
-- manage-mode session row (defense-in-depth against any future bug
-- upstream that let one be created).
create or replace function public.has_platform_support_access(p_club_id uuid, p_require_manage boolean default false)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    (
      public.is_platform_owner()
      or public.has_platform_permission(case when p_require_manage then 'platform.support.start_manage' else 'platform.support.start_view' end)
    )
    and exists (
      select 1 from public.platform_support_sessions s
      where s.platform_owner_id = auth.uid()
        and s.club_id = p_club_id
        and s.ended_at is null
        and s.expires_at > now()
        and (not p_require_manage or s.mode = 'manage')
    )
$$;
