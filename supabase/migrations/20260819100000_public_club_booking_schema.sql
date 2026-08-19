-- Public Club Booking System (directive Sections 42-53): schema
-- foundation. Every club gets a stable, shareable, human-friendly
-- public URL (https://mal3aby.app/c/<club-slug>) for an anonymous
-- visitor to browse fields/prices/availability and book without
-- forced login. This migration adds only the schema pieces -- the
-- anon-safe read/write RPCs follow in a separate migration.

-- ============================================================
-- clubs.public_slug: unique, URL-safe, stable once set. Generated
-- once at club creation (directive rule: "do not auto-change slug
-- just because display name changes"). Nullable so existing clubs can
-- be backfilled deliberately rather than silently, and so a club can
-- exist without a public page if the owner never triggers slug
-- generation (though the onboarding flow will set one going forward).
-- ============================================================
alter table public.clubs
  add column if not exists public_slug text,
  add column if not exists public_booking_enabled boolean not null default true;

-- Case-insensitive uniqueness (directive rule) via a functional unique
-- index rather than a plain unique constraint on the column itself --
-- lower(slug) is what actually needs to be unique, the stored value
-- can preserve whatever case it was generated with (though the
-- generator will always produce lowercase).
create unique index if not exists clubs_public_slug_lower_idx
  on public.clubs (lower(public_slug))
  where public_slug is not null;

comment on column public.clubs.public_slug is
  'URL-safe, unique (case-insensitive), stable public identifier for https://mal3aby.app/c/<slug>. Never changes automatically when the club''s display name changes. Null = no public booking page yet.';
comment on column public.clubs.public_booking_enabled is
  'Owner-controlled visibility toggle for the public club booking page -- distinct from clubs.status (administrative only, per that column''s own comment). A club can have a slug but choose to disable public booking temporarily.';

-- ============================================================
-- bookings.source: simple, optional attribution (directive Section
-- 53 -- "do not turn this into a Marketing Analytics Platform").
-- Defaults to 'staff' so every existing/authenticated booking path is
-- completely unaffected.
-- ============================================================
alter table public.bookings
  add column if not exists source text not null default 'staff';

alter table public.bookings drop constraint if exists bookings_source_check;
alter table public.bookings
  add constraint bookings_source_check
  check (source in ('staff', 'club_public_link', 'club_qr'));

comment on column public.bookings.source is
  'Simple booking-origin attribution (directive Section 53). "staff" for the existing authenticated staff-side flow (default, unchanged behavior). "club_public_link"/"club_qr" for the new public booking flow, set by create_public_booking().';

-- Note (directive Section 49): the Club Booking QR is deliberately NOT
-- a qr_credentials row. It encodes the club's public URL
-- (https://mal3aby.app/c/<slug>) directly, generated client-side from
-- the already-public, non-secret slug -- there is no token to mint,
-- no credential to look up at scan time, and nothing to revoke (the
-- slug itself, or public_booking_enabled, is the only thing that can
-- make it stop working). Adding a qr_credentials row here would be
-- unnecessary architecture for something that needs no security
-- model beyond "this club's public page is/isn't currently enabled" --
-- exactly the over-engineering the directive warns against. This
-- keeps qr_credentials scoped to what it was designed for: real,
-- revocable, expiring per-entity credentials (booking attendance,
-- player membership).
