-- MASTER ADMIN / PLATFORM SUPPORT CONTEXT (2026-08-26) -- new capability,
-- no prior art existed in this codebase (confirmed via full discovery
-- pass: no support-session/impersonation concept anywhere in schema,
-- RPCs, or frontend). Design per the platform owner's own explicit
-- directive: a genuine server-authorized support context, NOT a fake
-- club_membership row, NOT credential impersonation, NOT a second
-- competing admin identity model.
--
-- auth.uid() always remains the real Platform Owner. This table tracks
-- an EXPLICIT target club + mode (view/manage) + optional reason, with a
-- hard expiry, so is_platform_owner() alone can never silently become a
-- blanket bypass -- every downstream check requires both is_platform_owner()
-- AND an active, non-expired session targeting the exact club in question
-- (see has_platform_support_access(), next migration).
create table public.platform_support_sessions (
  id uuid primary key default gen_random_uuid(),
  platform_owner_id uuid not null references auth.users(id),
  club_id uuid not null references public.clubs(id),
  mode text not null check (mode in ('view','manage')),
  reason text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  expires_at timestamptz not null default (now() + interval '4 hours'),
  created_at timestamptz not null default now()
);

-- Fast "find my active session" lookup -- exactly what
-- has_platform_support_access() and get_my_active_support_session() do
-- on every call.
create index platform_support_sessions_active_owner_idx
  on public.platform_support_sessions (platform_owner_id)
  where ended_at is null;

alter table public.platform_support_sessions enable row level security;
alter table public.platform_support_sessions force row level security;

-- A platform_owner may only ever see/create/end THEIR OWN session rows,
-- and only while they genuinely hold the role right now (is_platform_owner()
-- is re-checked in the policy itself, not just at the RPC layer, so even a
-- direct table query is covered). No policy at all for ordinary tenant
-- users -- default deny, confirmed by omission (this project's own
-- established RLS convention: FORCE RLS + no matching policy = zero rows,
-- zero writes, for anyone this policy doesn't name).
create policy platform_support_sessions_owner_all
  on public.platform_support_sessions
  for all
  using (platform_owner_id = auth.uid() and public.is_platform_owner())
  with check (platform_owner_id = auth.uid() and public.is_platform_owner());

revoke all on public.platform_support_sessions from anon;
grant select, insert, update, delete on public.platform_support_sessions to authenticated;
