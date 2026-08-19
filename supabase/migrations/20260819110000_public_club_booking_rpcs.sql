-- Public Club Booking System (directive Sections 42-53): anon-safe
-- RPCs. Follows the exact security posture already proven by
-- verify_booking_qr_public()/verify_invoice_public(): every function
-- here is SECURITY DEFINER, narrowly scoped, returns only the minimum
-- safe column set, and is the ONLY way an anonymous visitor reaches
-- club/field/pricing/availability data -- there is no direct anon
-- grant on clubs/branches/fields/pricing_rules (directive Section 47:
-- "public page must never expose staff, internal reports, customer
-- records, private financial data, subscription internals, private
-- settings, WhatsApp configuration, other tenant data").

-- ============================================================
-- slugify(): plain deterministic transliteration/slug helper. ASCII
-- letters/digits lowercase and kept; everything else (including
-- Arabic script, since most club names in this market are Arabic)
-- becomes a hyphen, runs of hyphens collapsed, leading/trailing
-- hyphens trimmed. A club with an all-Arabic name and no name_en will
-- get a short generic slug base ("club") plus disambiguating digits
-- rather than an empty/unreadable slug -- callers fall back to that
-- when the transliterated result is empty.
-- ============================================================
create or replace function public.slugify(p_text text)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select nullif(
    trim(both '-' from regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g')),
    ''
  )
$$;

comment on function public.slugify(text) is
  'Plain ASCII slugify -- lowercase, non [a-z0-9] runs collapsed to a single hyphen, trimmed. Returns null for an empty/non-ASCII-only input (e.g. an all-Arabic name with no Latin characters) so callers can fall back to a generic base.';

-- ============================================================
-- generate_club_slug(): produces the initial slug at club creation
-- (directive Section 43: "Al Nasr Sports Club" -> "al-nasr"; if taken
-- -> "al-nasr-2"). Deliberately NOT called automatically on every
-- name update (directive: "do not auto-change slug just because
-- display name changes") -- this is a one-shot generator, called
-- explicitly at creation time or by an explicit "generate my link"
-- owner action if a club predates this feature.
-- ============================================================
create or replace function public.generate_club_slug(p_club_id uuid, p_preferred_base text default null)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club record;
  v_base text;
  v_candidate text;
  v_suffix int := 1;
begin
  select id, name, name_en into v_club from public.clubs where id = p_club_id;
  if v_club.id is null then
    raise exception 'club not found';
  end if;

  -- Prefer an explicit caller-supplied base, then the club's own
  -- English name, then its primary name, then a generic fallback --
  -- short-circuiting on the first one that actually slugifies to
  -- something non-empty (an Arabic-only name correctly falls through
  -- to the generic base rather than producing an empty/junk slug).
  v_base := public.slugify(coalesce(p_preferred_base, v_club.name_en, v_club.name));
  if v_base is null then
    v_base := 'club';
  end if;
  -- Keep it short and readable -- directive Section 42: "short,
  -- stable, shareable, human-friendly".
  v_base := left(v_base, 30);

  v_candidate := v_base;
  loop
    if not exists (select 1 from public.clubs where lower(public_slug) = lower(v_candidate)) then
      return v_candidate;
    end if;
    v_suffix := v_suffix + 1;
    v_candidate := v_base || '-' || v_suffix;
  end loop;
end;
$$;

revoke all on function public.generate_club_slug(uuid, text) from public, anon, authenticated;
grant execute on function public.generate_club_slug(uuid, text) to service_role;

comment on function public.generate_club_slug(uuid, text) is
  'Internal-only slug generator (directive Section 43) -- service_role only, called from set_club_public_slug() (which enforces the has_permission check) or platform/onboarding tooling, never directly by a client.';

-- ============================================================
-- set_club_public_slug(): the authenticated, permission-checked entry
-- point a club owner/staff member actually calls -- either to
-- generate the club's FIRST slug (p_desired_slug null -> auto-
-- generate from the club name) or to claim a specific desired slug.
-- Does NOT allow silently overwriting an already-set slug from the
-- club-name-change path (directive: slug is stable) -- this function
-- IS the explicit, deliberate action a human takes, so overwriting
-- here is fine; nothing else in the app calls this automatically.
-- ============================================================
create or replace function public.set_club_public_slug(p_club_id uuid, p_desired_slug text default null)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_slug text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('club.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_desired_slug is not null then
    v_slug := public.slugify(p_desired_slug);
    if v_slug is null or length(v_slug) < 2 then
      raise exception 'invalid slug -- use letters, numbers, and hyphens only';
    end if;
    if exists (select 1 from public.clubs where lower(public_slug) = lower(v_slug) and id <> p_club_id) then
      raise exception 'this link is already taken -- try a different one';
    end if;
  else
    v_slug := public.generate_club_slug(p_club_id);
  end if;

  update public.clubs set public_slug = v_slug, updated_at = now() where id = p_club_id;

  perform public.write_audit_log(p_club_id, 'club.public_slug.set', 'club', p_club_id, null, jsonb_build_object('public_slug', v_slug), null);

  return v_slug;
end;
$$;

revoke all on function public.set_club_public_slug(uuid, text) from public, anon;
grant execute on function public.set_club_public_slug(uuid, text) to authenticated;

comment on function public.set_club_public_slug(uuid, text) is
  'Authenticated, has_permission(club.update)-gated. Sets (or changes, if the owner deliberately chooses to) the club''s public_slug. Auto-generates from the club name when p_desired_slug is omitted.';

-- ============================================================
-- set_club_public_booking_enabled(): simple owner toggle (directive
-- Section 50's sharing tools imply the owner controls whether the
-- link is currently live).
-- ============================================================
create or replace function public.set_club_public_booking_enabled(p_club_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('club.update', p_club_id)) then
    raise exception 'not authorized';
  end if;
  update public.clubs set public_booking_enabled = p_enabled, updated_at = now() where id = p_club_id;
  perform public.write_audit_log(p_club_id, 'club.public_booking_enabled.set', 'club', p_club_id, null, jsonb_build_object('enabled', p_enabled), null);
end;
$$;

revoke all on function public.set_club_public_booking_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_club_public_booking_enabled(uuid, boolean) to authenticated;

-- ============================================================
-- get_public_club(): the PUBLIC (anon-callable) read for the club
-- booking page itself -- club identity, branches, fields, prices.
-- Resolves slug -> exactly one club (directive Section 47: "slug
-- resolution must lead to exactly one club"), scoped to
-- public_booking_enabled clubs with status='active' only. Returns a
-- narrow, deliberately safe column set -- never staff, reports,
-- customer records, financial internals, subscription internals,
-- WhatsApp config (directive Section 47's explicit exclusion list).
-- ============================================================
create or replace function public.get_public_club(p_slug text)
returns table(
  club_id uuid,
  club_name text,
  club_name_en text,
  logo_url text,
  currency text,
  timezone text,
  branches jsonb,
  fields jsonb
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club record;
begin
  select c.id, c.name, c.name_en, c.logo_url, c.currency, c.timezone
    into v_club
    from public.clubs c
    where lower(c.public_slug) = lower(p_slug)
      and c.public_booking_enabled = true
      and c.status = 'active';

  if v_club.id is null then
    return;
  end if;

  return query
  select
    v_club.id,
    v_club.name,
    v_club.name_en,
    v_club.logo_url,
    v_club.currency,
    v_club.timezone,
    (
      select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'address', b.address) order by b.name), '[]'::jsonb)
      from public.branches b
      where b.club_id = v_club.id and b.status = 'active'
    ),
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'branch_id', f.branch_id, 'name', f.name, 'sport', f.sport,
        'indoor', f.indoor, 'capacity', f.capacity, 'default_duration_minutes', f.default_duration_minutes
      ) order by f.name), '[]'::jsonb)
      from public.fields f
      where f.club_id = v_club.id and f.status = 'active'
    );
end;
$$;

revoke all on function public.get_public_club(text) from public;
grant execute on function public.get_public_club(text) to anon, authenticated;

comment on function public.get_public_club(text) is
  'PUBLIC, anon-callable. Resolves a public_slug to exactly one active, public-booking-enabled club and its active branches/fields. Never exposes staff, reports, customer records, financial internals, subscription internals, or WhatsApp config (directive Section 47). Read-only, no mutation.';

-- ============================================================
-- get_public_field_price(): mirrors resolve_field_price()'s exact
-- query logic but WITHOUT the has_permission('field.view') check --
-- gated instead by the same public_booking_enabled/status check as
-- get_public_club(), so an anon caller can price a slot before
-- committing to a booking. Never a duplicate/diverging price
-- calculation -- same pricing_rules table, same resolution order.
-- ============================================================
create or replace function public.get_public_field_price(p_field_id uuid, p_date date, p_start_time time, p_end_time time)
returns numeric
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_day_of_week int;
  v_price numeric;
begin
  select f.club_id into v_club_id
    from public.fields f
    join public.clubs c on c.id = f.club_id
    where f.id = p_field_id and f.status = 'active' and c.public_booking_enabled = true and c.status = 'active';

  if v_club_id is null then
    raise exception 'field not found or not publicly bookable';
  end if;

  v_day_of_week := extract(dow from p_date)::int;

  select price_per_hour into v_price
  from public.pricing_rules
  where club_id = v_club_id
    and (field_id = p_field_id or field_id is null)
    and (
      (date_specific = p_date)
      or (date_specific is null and day_of_week = v_day_of_week)
    )
    and start_time <= p_start_time
    and end_time >= p_end_time
  order by
    (field_id is not null) desc,
    (date_specific is not null) desc,
    priority desc
  limit 1;

  if v_price is null then
    raise exception 'no pricing rule found for this field/time';
  end if;

  return v_price;
end;
$$;

revoke all on function public.get_public_field_price(uuid, date, time, time) from public;
grant execute on function public.get_public_field_price(uuid, date, time, time) to anon, authenticated;

comment on function public.get_public_field_price(uuid, date, time, time) is
  'PUBLIC, anon-callable mirror of resolve_field_price() -- same pricing_rules resolution logic, gated by public_booking_enabled instead of has_permission(field.view). Never diverges from the staff-side price calculation.';

-- ============================================================
-- get_public_field_availability(): reuses resolve_field_operating_hours()
-- (already has no permission check, callable from within this
-- SECURITY DEFINER function without a separate anon grant on it) plus
-- the SAME field_blocks/bookings overlap logic _create_booking_internal
-- relies on, so a public visitor sees genuinely accurate availability
-- -- never a second, potentially-diverging availability computation.
-- Returns booked/blocked time ranges for the day (not a slot grid --
-- the frontend builds its own slot grid the same way BookingsPage.tsx
-- already does, just fed public data instead of staff-authenticated
-- data).
-- ============================================================
create or replace function public.get_public_field_availability(p_field_id uuid, p_date date)
returns table(
  open_time time,
  close_time time,
  has_any_config boolean,
  busy_ranges jsonb
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_timezone text;
  v_hours record;
begin
  select f.club_id, c.timezone into v_club_id, v_timezone
    from public.fields f
    join public.clubs c on c.id = f.club_id
    where f.id = p_field_id and f.status = 'active' and c.public_booking_enabled = true and c.status = 'active';

  if v_club_id is null then
    raise exception 'field not found or not publicly bookable';
  end if;

  v_day_start := p_date::timestamp at time zone v_timezone;
  v_day_end := (p_date + 1)::timestamp at time zone v_timezone;

  select * into v_hours from public.resolve_field_operating_hours(p_field_id, p_date);

  return query
  select
    v_hours.open_time,
    v_hours.close_time,
    v_hours.has_any_config,
    (
      select coalesce(jsonb_agg(jsonb_build_object('start_at', r.start_at, 'end_at', r.end_at) order by r.start_at), '[]'::jsonb)
      from (
        select b.start_at, b.end_at
        from public.bookings b
        where b.field_id = p_field_id
          and b.status in ('pending_payment', 'confirmed', 'checked_in')
          and b.start_at < v_day_end and b.end_at > v_day_start
        union all
        select fb.start_at, fb.end_at
        from public.field_blocks fb
        where fb.field_id = p_field_id
          and fb.start_at < v_day_end and fb.end_at > v_day_start
      ) r
    );
end;
$$;

revoke all on function public.get_public_field_availability(uuid, date) from public;
grant execute on function public.get_public_field_availability(uuid, date) to anon, authenticated;

comment on function public.get_public_field_availability(uuid, date) is
  'PUBLIC, anon-callable. Returns operating hours (via resolve_field_operating_hours(), same function the staff flow uses) plus a merged list of booked+blocked time ranges for the day, so a public visitor sees genuinely accurate availability -- never a second, potentially-diverging computation from what create_public_booking()''s own DB-level exclusion constraint will ultimately enforce.';
