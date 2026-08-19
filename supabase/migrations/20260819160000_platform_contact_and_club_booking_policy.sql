-- MAL3ABY PRODUCT/UX/BOOKING/PAYMENT DIRECTIVE -- Part 1: schema.
--
-- 1. Platform Contact source of truth: extends the existing
--    platform_settings singleton (REUSE BEFORE CREATE -- this table
--    already exists, is platform_owner-writable, and is exactly the
--    right home for platform-wide config) with the official Mal3aby
--    contact fields, plus a dedicated anon-safe RPC to read ONLY the
--    contact fields (not trial/grace-period business config) for the
--    public site/footer/support links -- narrower than widening RLS on
--    the whole table to anon.
--
-- 2. Club Booking Policy: new club_booking_policy table (one row per
--    club, club-owner-writable), holding the same_day/offset/window/
--    hold-minutes/cash-policy knobs the directive requires be
--    configurable rather than hardcoded. Defaults match the directive
--    exactly: same-day OFF, start offset 1 day, window 2 days, payment
--    hold 60 minutes, cash reservation allowed by default (matches
--    existing behavior -- a staff-created cash booking already
--    confirms immediately today, so defaulting this to "allowed"
--    preserves current behavior for every existing club rather than
--    silently changing it).
--
-- 3. Club Contact fields directly on clubs (mirrors how public_slug/
--    public_booking_enabled were added in the prior public-booking
--    migration -- same table, same pattern): primary_phone,
--    secondary_phone, whatsapp_number, payment_receipt_whatsapp_number,
--    contact_email, address, maps_url. Deliberately separate columns
--    from platform_settings' own contact fields -- directive's explicit
--    "never use Mal3aby contact as a club fallback" requirement is
--    enforced by these simply being two unrelated tables/rows with no
--    coalesce() between them anywhere in the RPC layer.

-- ============================================================
-- 1. Platform contact fields on platform_settings
-- ============================================================
alter table public.platform_settings
  add column if not exists platform_phone text,
  add column if not exists platform_email text;

update public.platform_settings
set platform_phone = '+201116505553',
    platform_email = 'mal3aby.app@gmail.com'
where id = true and platform_phone is null;

comment on column public.platform_settings.platform_phone is 'Official Mal3aby platform support phone -- never a club fallback. Read via get_platform_contact() for anon/public contexts.';
comment on column public.platform_settings.platform_email is 'Official Mal3aby platform support email -- never a club fallback.';

-- Anon-safe read of ONLY the contact fields (not trial/grace defaults,
-- which stay authenticated-only per the existing RLS policy).
create or replace function public.get_platform_contact()
returns table(platform_phone text, platform_email text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select platform_phone, platform_email from public.platform_settings where id = true;
$$;

revoke all on function public.get_platform_contact() from public;
grant execute on function public.get_platform_contact() to anon, authenticated;

-- ============================================================
-- 2. Club Booking Policy (one row per club)
-- ============================================================
create table public.club_booking_policy (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  same_day_online_booking_enabled boolean not null default false,
  online_booking_start_offset_days int not null default 1,
  online_booking_window_days int not null default 2,
  payment_hold_minutes int not null default 60,
  cash_reservation_allowed boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  constraint club_booking_policy_offset_nonneg check (online_booking_start_offset_days >= 0),
  constraint club_booking_policy_window_positive check (online_booking_window_days >= 1),
  constraint club_booking_policy_hold_positive check (payment_hold_minutes >= 5 and payment_hold_minutes <= 1440)
);

comment on table public.club_booking_policy is 'Per-club booking-window and payment-hold configuration. Directive: same-day online booking off by default, booking opens tomorrow, 2-day window, 60-minute payment hold. Every club without a row here gets these exact defaults via get_club_booking_policy()''s coalesce, so this table can stay empty for existing clubs without changing their behavior at all.';

create trigger trg_club_booking_policy_updated_at before update on public.club_booking_policy
  for each row execute function public.set_updated_at();

alter table public.club_booking_policy enable row level security;
alter table public.club_booking_policy force row level security;

create policy club_booking_policy_select_staff on public.club_booking_policy
  for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('club.update', club_id));

create policy club_booking_policy_write_staff on public.club_booking_policy
  for all to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('club.update', club_id))
  with check (club_id in (select public.user_club_ids()) and public.has_permission('club.update', club_id));

-- Anon-safe read of ONLY the fields the public booking page needs to
-- compute its own date window client-side (never write access).
create or replace function public.get_public_club_booking_policy(p_club_id uuid)
returns table(
  same_day_online_booking_enabled boolean,
  online_booking_start_offset_days int,
  online_booking_window_days int,
  payment_hold_minutes int
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    coalesce(cbp.same_day_online_booking_enabled, false),
    coalesce(cbp.online_booking_start_offset_days, 1),
    coalesce(cbp.online_booking_window_days, 2),
    coalesce(cbp.payment_hold_minutes, 60)
  from public.clubs c
  left join public.club_booking_policy cbp on cbp.club_id = c.id
  where c.id = p_club_id;
$$;

revoke all on function public.get_public_club_booking_policy(uuid) from public;
grant execute on function public.get_public_club_booking_policy(uuid) to anon, authenticated;

-- Staff-side setter, permission-gated identically to the RLS policy
-- above (belt-and-suspenders, matches this codebase's existing pattern
-- of RPC + RLS both enforcing the same rule rather than relying on one
-- alone).
create or replace function public.set_club_booking_policy(
  p_club_id uuid,
  p_same_day_online_booking_enabled boolean default null,
  p_online_booking_start_offset_days int default null,
  p_online_booking_window_days int default null,
  p_payment_hold_minutes int default null,
  p_cash_reservation_allowed boolean default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('club.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  insert into public.club_booking_policy (club_id)
  values (p_club_id)
  on conflict (club_id) do nothing;

  update public.club_booking_policy set
    same_day_online_booking_enabled = coalesce(p_same_day_online_booking_enabled, same_day_online_booking_enabled),
    online_booking_start_offset_days = coalesce(p_online_booking_start_offset_days, online_booking_start_offset_days),
    online_booking_window_days = coalesce(p_online_booking_window_days, online_booking_window_days),
    payment_hold_minutes = coalesce(p_payment_hold_minutes, payment_hold_minutes),
    cash_reservation_allowed = coalesce(p_cash_reservation_allowed, cash_reservation_allowed)
  where club_id = p_club_id;

  perform public.write_audit_log(p_club_id, 'club_booking_policy.update', 'club_booking_policy', p_club_id, null,
    jsonb_build_object(
      'same_day_online_booking_enabled', p_same_day_online_booking_enabled,
      'online_booking_start_offset_days', p_online_booking_start_offset_days,
      'online_booking_window_days', p_online_booking_window_days,
      'payment_hold_minutes', p_payment_hold_minutes,
      'cash_reservation_allowed', p_cash_reservation_allowed
    ), null);
end;
$$;

revoke all on function public.set_club_booking_policy(uuid, boolean, int, int, int, boolean) from public;
grant execute on function public.set_club_booking_policy(uuid, boolean, int, int, int, boolean) to authenticated;

-- ============================================================
-- 3. Club Contact fields on clubs (own data, never Mal3aby's)
-- ============================================================
alter table public.clubs
  add column if not exists primary_phone text,
  add column if not exists secondary_phone text,
  add column if not exists whatsapp_number text,
  add column if not exists payment_receipt_whatsapp_number text,
  add column if not exists contact_email text,
  add column if not exists address text,
  add column if not exists maps_url text;

comment on column public.clubs.whatsapp_number is 'Club''s own WhatsApp number for same-day contact booking. Never Mal3aby''s platform number -- no code path may fall back to platform contact for this.';
comment on column public.clubs.payment_receipt_whatsapp_number is 'Club''s own WhatsApp number for receiving payment receipts. May equal whatsapp_number or be a separate accounts number. Never Mal3aby''s platform number.';

-- Extend the existing public-booking RPC to also expose the club's own
-- contact fields (not platform contact) and booking policy -- reuses
-- get_public_club() rather than adding a parallel endpoint, and
-- preserves every field its real, already-deployed signature returns
-- (club_name_en, logo_url, currency, branch address, field
-- indoor/capacity/default_duration_minutes) so the existing frontend
-- caller (PublicClubBookingPage.tsx) keeps working unchanged --
-- confirmed against the live function definition before writing this,
-- not assumed from the schema-design migration that first created it.
drop function public.get_public_club(text);

create function public.get_public_club(p_slug text)
returns table(
  club_id uuid,
  club_name text,
  club_name_en text,
  logo_url text,
  currency text,
  timezone text,
  primary_phone text,
  whatsapp_number text,
  contact_email text,
  address text,
  maps_url text,
  same_day_online_booking_enabled boolean,
  online_booking_start_offset_days int,
  online_booking_window_days int,
  payment_hold_minutes int,
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
  v_policy record;
begin
  select c.id, c.name, c.name_en, c.logo_url, c.currency, c.timezone,
         c.primary_phone, c.whatsapp_number, c.contact_email, c.address, c.maps_url
    into v_club
    from public.clubs c
    where lower(c.public_slug) = lower(p_slug)
      and c.public_booking_enabled = true
      and c.status = 'active';

  if v_club.id is null then
    return;
  end if;

  select * into v_policy from public.get_public_club_booking_policy(v_club.id);

  return query
  select
    v_club.id, v_club.name, v_club.name_en, v_club.logo_url, v_club.currency, v_club.timezone,
    v_club.primary_phone, v_club.whatsapp_number, v_club.contact_email, v_club.address, v_club.maps_url,
    v_policy.same_day_online_booking_enabled, v_policy.online_booking_start_offset_days,
    v_policy.online_booking_window_days, v_policy.payment_hold_minutes,
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
