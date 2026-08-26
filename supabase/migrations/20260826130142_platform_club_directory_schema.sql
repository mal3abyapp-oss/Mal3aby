-- PLATFORM CLUB SELECTOR FOR LARGE SCALE (2026-08-26) -- directive:
-- "the platform may contain hundreds or thousands of clubs... do NOT
-- use a giant dropdown... build a dedicated scalable Club Directory."
--
-- The existing PlatformClubsPage.tsx already does real server-side
-- .range() pagination (not a giant dropdown -- confirmed via source
-- read, PAGE_SIZE=100, "load more" accumulation) but has two real
-- gaps against this directive: (1) search only matches club
-- name/code client-side, never owner name/email/phone server-side,
-- and status/access/reason/flagged filters are applied client-side
-- against an ever-growing in-memory list rather than pushed to the
-- database; (2) no Recent/Pinned clubs for fast repeat access.
--
-- platform_owner_recent_clubs: auto-recorded every time a support
-- session is started for a club (wired into start_platform_support_session
-- in the next migration) -- "recently managed", exactly as the
-- directive names it, not a separate manually-tracked "recently
-- viewed" concept.
create table public.platform_owner_recent_clubs (
  id uuid primary key default gen_random_uuid(),
  platform_admin_user_id uuid not null references auth.users(id),
  club_id uuid not null references public.clubs(id) on delete cascade,
  last_accessed_at timestamptz not null default now(),
  unique (platform_admin_user_id, club_id)
);

create index idx_platform_owner_recent_clubs_lookup
  on public.platform_owner_recent_clubs (platform_admin_user_id, last_accessed_at desc);

alter table public.platform_owner_recent_clubs enable row level security;

create policy platform_owner_recent_clubs_own_select
  on public.platform_owner_recent_clubs for select
  to authenticated
  using (platform_admin_user_id = auth.uid());
-- No direct insert/update/delete policy -- written exclusively via
-- record_platform_club_access() (SECURITY DEFINER, see next migration),
-- called from inside start_platform_support_session's own transaction.

-- platform_owner_pinned_clubs: explicit user action ("pin this club"),
-- separate table from "recent" since pinning is a deliberate choice
-- with no auto-expiry, while recent is an automatic, unbounded-growth
-- access log (capped to the most recent N by the read RPC, not by
-- deleting rows -- audit-style, matching this project's own
-- audit-preservation convention elsewhere).
create table public.platform_owner_pinned_clubs (
  id uuid primary key default gen_random_uuid(),
  platform_admin_user_id uuid not null references auth.users(id),
  club_id uuid not null references public.clubs(id) on delete cascade,
  pinned_at timestamptz not null default now(),
  unique (platform_admin_user_id, club_id)
);

alter table public.platform_owner_pinned_clubs enable row level security;

create policy platform_owner_pinned_clubs_own_all
  on public.platform_owner_pinned_clubs for all
  to authenticated
  using (platform_admin_user_id = auth.uid() and public.is_platform_owner())
  with check (platform_admin_user_id = auth.uid() and public.is_platform_owner());
