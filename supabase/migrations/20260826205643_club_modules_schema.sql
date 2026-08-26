-- COMMERCIAL MODULE ARCHITECTURE (2026-08-26) -- Phase B: canonical
-- per-club module entitlement/activation model. See
-- COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 3 for the full design
-- rationale. Two-level state (directive Section 4):
--   entitled: platform-controlled commercial unlock.
--   active:   club-owner-controlled day-to-day on/off, only meaningful
--             once entitled=true (CHECK enforces active implies entitled).
-- Effective-module-on for any enforcement gate is always
-- `entitled AND active`, computed inline where needed -- never cached.
create table public.club_modules (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  module_key text not null check (module_key in ('fields', 'academy', 'shop')),
  entitled boolean not null default false,
  active boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  unique (club_id, module_key),
  check (not active or entitled)
);

alter table public.club_modules enable row level security;
alter table public.club_modules force row level security;

-- Read: any active staff member of the club (module state affects
-- their own nav/UX), OR a platform owner/staff with platform.club.view
-- (Platform Clubs directory module-state filter, directive Section
-- 123), OR an active support session for this exact club (Master Admin
-- VIEW/MANAGE, directive Section 74/122).
create policy club_modules_select
  on public.club_modules for select
  to authenticated
  using (
    club_id in (select public.user_club_ids())
    or public.is_platform_owner()
    or public.has_platform_permission('platform.club.view')
    or public.has_platform_support_access(club_id, false)
  );

-- Write is deliberately NOT granted via a blanket RLS policy -- every
-- mutation goes through set_club_module_entitlement()/set_club_module_active()
-- (next migration), which apply the platform-vs-club-owner distinction
-- and audit every change. No direct table INSERT/UPDATE policy exists.

-- Backfill (directive Section 113 -- backward compatibility): every
-- existing club keeps Fields and Academy exactly as available as they
-- are today (entitled+active=true) -- no existing tenant loses access
-- to what it's already using. Shop is opt-in only (entitled=false,
-- active=false) for every club, new or existing, until a platform
-- owner explicitly turns it on.
insert into public.club_modules (club_id, module_key, entitled, active)
select c.id, m.module_key, true, true
from public.clubs c
cross join (values ('fields'), ('academy')) as m(module_key)
on conflict (club_id, module_key) do nothing;

insert into public.club_modules (club_id, module_key, entitled, active)
select c.id, 'shop', false, false
from public.clubs c
on conflict (club_id, module_key) do nothing;
