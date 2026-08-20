-- MASTER OPERATIONAL SIMPLIFICATION DIRECTIVE (2026-08-20), section 19-21:
-- "Simple form: Membership Name, Duration, Price." Confirmed via
-- dedicated audit: creating a sellable membership ("Group") required
-- standing up Program -> Season -> (optional Age Group) -> Group first
-- -- program_id and season_id are NOT NULL at the schema level, and
-- Phase E already fixed subscription duration to a flat monthly model,
-- leaving Season with no remaining pricing/duration purpose it once
-- had (confirmed: no season-based expiry/reporting logic reads
-- season_id for behavior, only for display).
--
-- Fix: make both columns nullable so a club can create a Group with
-- just Name/Capacity/Price, while Program/Season remain available as
-- genuinely optional organizational metadata for clubs that want them
-- (multi-program academies, seasonal cohorts) -- not removed, per the
-- "preserve data compatibility, simplify UI first" rule. This is the
-- schema half; the UI half (making the fields optional in the create
-- form) is a separate, reversible frontend-only change.
alter table public.groups alter column program_id drop not null;
alter table public.groups alter column season_id drop not null;

comment on column public.groups.program_id is 'Optional organizational grouping (e.g. multiple sports/programs at one academy). NULL is valid and common -- most clubs sell a single flat monthly membership with no program hierarchy needed.';
comment on column public.groups.season_id is 'Optional organizational grouping (e.g. seasonal cohorts). NULL is valid and common -- since academy subscriptions are a flat monthly model (Phase E), season has no effect on subscription duration/pricing/expiry.';
