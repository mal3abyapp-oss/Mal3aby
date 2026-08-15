-- Phase 9 -- Reception & Manager Dashboards + Quick Actions.
-- See docs/IMPLEMENTATION_PLAN.md Phase 9. No new tables -- reads Phase
-- 6-8 data only. One RPC returning every dashboard widget's data in a
-- single round trip (satisfies the "no widget triggers more than one
-- query per render" exit-gate requirement) rather than N separate
-- per-widget queries.

create or replace function public.get_today_dashboard(p_club_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('booking.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select jsonb_build_object(
    'bookings_today_count', (
      select count(*) from public.bookings
      where club_id = p_club_id
        and start_at::date = current_date
        and status != 'cancelled'
    ),
    'checked_in_count', (
      select count(*) from public.bookings
      where club_id = p_club_id
        and start_at::date = current_date
        and status = 'checked_in'
    ),
    'fields_active_count', (
      select count(*) from public.fields where club_id = p_club_id and status = 'active'
    ),
    'fields_occupied_now_count', (
      select count(distinct field_id) from public.bookings
      where club_id = p_club_id
        and status in ('pending_payment', 'confirmed', 'checked_in')
        and during @> now()
    ),
    'revenue_today', (
      select coalesce(sum(p.amount), 0) from public.payments p
      where p.club_id = p_club_id and p.received_at::date = current_date and p.status = 'completed'
    ),
    'outstanding_total', (
      select coalesce(sum(oi.outstanding), 0) from public.outstanding_invoices oi
      where oi.club_id = p_club_id
    ),
    'now_bookings', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', b.id,
        'field_name', f.name,
        'customer_name', c.full_name,
        'start_at', b.start_at,
        'end_at', b.end_at,
        'status', b.status
      ) order by b.start_at), '[]'::jsonb)
      from public.bookings b
      join public.fields f on f.id = b.field_id
      join public.customers c on c.id = b.customer_id
      where b.club_id = p_club_id
        and b.status in ('pending_payment', 'confirmed', 'checked_in')
        and b.during @> now()
    ),
    'next_bookings', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', nb.id,
        'field_name', nb.field_name,
        'customer_name', nb.customer_name,
        'start_at', nb.start_at,
        'end_at', nb.end_at,
        'status', nb.status
      )), '[]'::jsonb)
      from (
        select b.id, f.name as field_name, c.full_name as customer_name, b.start_at, b.end_at, b.status
        from public.bookings b
        join public.fields f on f.id = b.field_id
        join public.customers c on c.id = b.customer_id
        where b.club_id = p_club_id
          and b.status in ('pending_payment', 'confirmed')
          and b.start_at > now()
          and b.start_at::date = current_date
        order by b.start_at
        limit 5
      ) nb
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_today_dashboard(uuid) from public;
revoke execute on function public.get_today_dashboard(uuid) from anon;
grant execute on function public.get_today_dashboard(uuid) to authenticated;
