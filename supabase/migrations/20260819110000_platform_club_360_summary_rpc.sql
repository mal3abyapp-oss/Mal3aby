-- Platform Owner directive, Phase C: Club 360.
--
-- The live audit's central test: "if a club owner calls support right
-- now, can the platform owner understand that club's full state within
-- under a minute?" Confirmed NO -- Club Detail showed subscription/
-- payment/audit data but zero owner contact, zero facilities, zero
-- booking/customer volume, despite all of that being one query away.
--
-- One batched RPC (not per-section queries) covering: primary owner
-- contact, branch/field counts, customer count, and a booking summary
-- (today/this month/pending) -- deliberately a SUMMARY, not a platform
-- booking-operations system (out of scope per the directive: "لا تبنِ
-- Platform booking operations system").
create or replace function public.get_platform_club_360(p_club_id uuid)
returns table(
  owner_user_id uuid,
  owner_name text,
  owner_email text,
  owner_phone text,
  branch_count bigint,
  field_count bigint,
  customer_count bigint,
  bookings_today bigint,
  bookings_this_month bigint,
  bookings_pending bigint
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_owner record;
  v_today_start timestamptz := date_trunc('day', now());
  v_today_end timestamptz := date_trunc('day', now()) + interval '1 day';
  v_month_start timestamptz := date_trunc('month', now());
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  select cm.user_id, p.full_name, u.email::text, p.phone
    into v_owner
  from public.club_memberships cm
  join public.roles r on r.id = cm.role_id and r.key = 'club_owner'
  left join public.profiles p on p.user_id = cm.user_id
  left join auth.users u on u.id = cm.user_id
  where cm.club_id = p_club_id and cm.status = 'active'
  order by cm.created_at asc
  limit 1;

  return query
  select
    v_owner.user_id,
    v_owner.full_name,
    v_owner.email,
    v_owner.phone,
    (select count(*) from public.branches b where b.club_id = p_club_id) as branch_count,
    (select count(*) from public.fields f where f.club_id = p_club_id) as field_count,
    (select count(*) from public.customers c where c.club_id = p_club_id) as customer_count,
    (select count(*) from public.bookings bk where bk.club_id = p_club_id and bk.start_at >= v_today_start and bk.start_at < v_today_end and bk.status not in ('cancelled')) as bookings_today,
    (select count(*) from public.bookings bk where bk.club_id = p_club_id and bk.start_at >= v_month_start and bk.status not in ('cancelled')) as bookings_this_month,
    (select count(*) from public.bookings bk where bk.club_id = p_club_id and bk.status = 'pending') as bookings_pending;
end;
$function$;

revoke all on function public.get_platform_club_360(uuid) from public;
revoke all on function public.get_platform_club_360(uuid) from anon;
grant execute on function public.get_platform_club_360(uuid) to authenticated;
