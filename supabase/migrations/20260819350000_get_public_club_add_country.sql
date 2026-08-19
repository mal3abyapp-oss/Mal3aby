-- Public booking page needs the club's default country to parse a
-- locally-formatted phone number correctly (directive section 3/21).
drop function if exists public.get_public_club(text);

create function public.get_public_club(p_slug text)
returns table(club_id uuid, club_name text, club_name_en text, logo_url text, currency text, timezone text, country text, primary_phone text, whatsapp_number text, contact_email text, address text, maps_url text, same_day_online_booking_enabled boolean, online_booking_start_offset_days integer, online_booking_window_days integer, payment_hold_minutes integer, branches jsonb, fields jsonb)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club record;
  v_policy record;
begin
  select c.id, c.name, c.name_en, c.logo_url, c.currency, c.timezone, c.country,
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
    v_club.id, v_club.name, v_club.name_en, v_club.logo_url, v_club.currency, v_club.timezone, v_club.country,
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
$function$;

revoke all on function public.get_public_club(text) from public;
grant execute on function public.get_public_club(text) to anon, authenticated;
