-- Customer 360 directive: "Duplicate detection + review workflow --
-- duplicate-groups report; no auto-merge." quarantine_duplicate_customer
-- and unquarantine_customer already existed (used by the earlier
-- historical Ali/Aliiii cleanup) but there was no way for staff to
-- discover a possible-duplicate group in the first place except by
-- accident. This adds the read-side: group customers in the same club
-- by identical phone_e164, regardless of current duplicate_review_status,
-- so staff see both "not yet reviewed" duplicates and "already
-- quarantined" ones in one report. Never merges/reassigns data --
-- purely a list + the two existing quarantine actions.
create or replace function public.get_customer_duplicate_groups(
  p_club_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_groups jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  with dup_phones as (
    select phone_e164
    from public.customers
    where club_id = p_club_id and phone_e164 is not null
    group by phone_e164
    having count(*) > 1
  ),
  members as (
    select
      c.phone_e164,
      c.id,
      c.full_name,
      c.mobile_display,
      c.duplicate_review_status,
      c.created_at,
      (select count(*) from public.bookings b where b.customer_id = c.id) as bookings_count,
      (select count(*) from public.guardian_links gl where gl.customer_id = c.id) as players_count,
      exists(select 1 from public.invoices i where i.customer_id = c.id) as has_invoices
    from public.customers c
    join dup_phones dp on dp.phone_e164 = c.phone_e164
    where c.club_id = p_club_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'phone_e164', g.phone_e164,
    'customers', g.customers
  ) order by g.phone_e164), '[]'::jsonb) into v_groups
  from (
    select
      m.phone_e164,
      jsonb_agg(jsonb_build_object(
        'id', m.id,
        'full_name', m.full_name,
        'mobile_display', m.mobile_display,
        'duplicate_review_status', m.duplicate_review_status,
        'created_at', m.created_at,
        'bookings_count', m.bookings_count,
        'players_count', m.players_count,
        'has_invoices', m.has_invoices
      ) order by m.created_at asc) as customers
    from members m
    group by m.phone_e164
  ) g;

  return jsonb_build_object('groups', v_groups);
end;
$function$;

revoke all on function public.get_customer_duplicate_groups(uuid) from public;
revoke all on function public.get_customer_duplicate_groups(uuid) from anon;
grant execute on function public.get_customer_duplicate_groups(uuid) to authenticated;
