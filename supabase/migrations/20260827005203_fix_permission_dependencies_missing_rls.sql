-- SECURITY FIX (found during the Printing-closure regression sweep, not
-- introduced this session): permission_dependencies had RLS disabled
-- entirely, with anon/authenticated holding direct INSERT/UPDATE/DELETE/
-- SELECT grants -- any unauthenticated caller could read, corrupt, or
-- delete the permission-dependency catalog other RPCs rely on for
-- server-side enforcement (permission_dependency_enforcement migration).
-- This is reference/catalog data maintained exclusively via migration --
-- no client (staff or platform) ever needs to write to it directly.
alter table public.permission_dependencies enable row level security;
alter table public.permission_dependencies force row level security;

revoke all on public.permission_dependencies from public, anon, authenticated;
grant select on public.permission_dependencies to authenticated;

create policy permission_dependencies_select_authenticated
  on public.permission_dependencies for select to authenticated
  using (true);
