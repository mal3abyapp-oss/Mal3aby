-- CASH RECONCILIATION & FINANCE OPERATIONS audit -- close a residual
-- gap in the branch-scope fix just applied: an UNRESTRICTED caller
-- (caller_accessible_branch_ids() returns NULL -- club_owner, platform
-- owner) passing a p_branch_id belonging to a DIFFERENT club got a
-- silent empty success (zero rows, since no payment in the queried
-- club has that branch_id) rather than an explicit rejection -- no
-- data leaked (the response was genuinely empty, not another club's
-- data), but the mandated test matrix requires an explicit DENY for a
-- cross-club branch id, not a silent empty ALLOW.
--
-- Fix: validate p_branch_id belongs to p_club_id explicitly (same
-- pattern already used by open_cash_shift: exists(select 1 from
-- branches where id=p_branch_id and club_id=p_club_id)), BEFORE the
-- existing accessible-branch-set check. This closes the gap for both
-- restricted and unrestricted callers uniformly, using the generic
-- 'not authorized' denial already used throughout this fix (no
-- existence leak, no distinct error message revealing whether the
-- branch exists elsewhere).
create or replace function public.get_revenue_report(p_club_id uuid, p_start_date date, p_end_date date, p_branch_id uuid default null::uuid, p_method text default null::text)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_timezone text;
  v_accessible uuid[];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'not authorized';
  end if;

  v_accessible := public.caller_accessible_branch_ids(p_club_id);
  if p_branch_id is not null and v_accessible is not null and not (p_branch_id = any(v_accessible)) then
    raise exception 'not authorized';
  end if;

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);
  select coalesce(c.timezone, 'Africa/Cairo') into v_timezone from public.clubs c where c.id = p_club_id;

  select jsonb_build_object(
    'total_revenue', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (case when p_branch_id is not null then p.branch_id = p_branch_id
             else v_accessible is null or p.branch_id = any(v_accessible) end)
        and (p_method is null or p.method = p_method)
    ), 0),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.day, 'revenue', d.revenue) order by d.day)
      from (
        select (p.received_at at time zone v_timezone)::date as day, sum(p.amount) as revenue
        from public.payments p
        where p.club_id = p_club_id and p.status = 'completed'
          and p.received_at >= v_range_start and p.received_at < v_range_end
          and (case when p_branch_id is not null then p.branch_id = p_branch_id
               else v_accessible is null or p.branch_id = any(v_accessible) end)
          and (p_method is null or p.method = p_method)
        group by (p.received_at at time zone v_timezone)::date
      ) d
    ), '[]'::jsonb),
    'by_method', coalesce((
      select jsonb_agg(jsonb_build_object('method', m.method, 'revenue', m.revenue) order by m.revenue desc)
      from (
        select p.method, sum(p.amount) as revenue
        from public.payments p
        where p.club_id = p_club_id and p.status = 'completed'
          and p.received_at >= v_range_start and p.received_at < v_range_end
          and (case when p_branch_id is not null then p.branch_id = p_branch_id
               else v_accessible is null or p.branch_id = any(v_accessible) end)
          and (p_method is null or p.method = p_method)
        group by p.method
      ) m
    ), '[]'::jsonb),
    'refunds_total', coalesce((
      select sum(r.amount) from public.refunds r
      join public.payments p on p.id = r.payment_id
      where p.club_id = p_club_id and r.status = 'completed'
        and r.refunded_at >= v_range_start and r.refunded_at < v_range_end
        and (case when p_branch_id is not null then p.branch_id = p_branch_id
             else v_accessible is null or p.branch_id = any(v_accessible) end)
    ), 0)
  ) into v_result;

  return v_result;
end;
$function$;

create or replace function public.get_collections_report(p_club_id uuid, p_start_date date, p_end_date date, p_branch_id uuid default null::uuid)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_accessible uuid[];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'not authorized';
  end if;

  v_accessible := public.caller_accessible_branch_ids(p_club_id);
  if p_branch_id is not null and v_accessible is not null and not (p_branch_id = any(v_accessible)) then
    raise exception 'not authorized';
  end if;

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  select jsonb_build_object(
    'total_collected', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (case when p_branch_id is not null then p.branch_id = p_branch_id
             else v_accessible is null or p.branch_id = any(v_accessible) end)
    ), 0),
    'by_employee', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', e.user_id,
        'full_name', e.full_name,
        'amount', e.amount,
        'payment_count', e.payment_count
      ) order by e.amount desc)
      from (
        select p.received_by as user_id, coalesce(pr.full_name, '—') as full_name,
               sum(p.amount) as amount, count(*) as payment_count
        from public.payments p
        left join public.profiles pr on pr.user_id = p.received_by
        where p.club_id = p_club_id and p.status = 'completed'
          and p.received_at >= v_range_start and p.received_at < v_range_end
          and (case when p_branch_id is not null then p.branch_id = p_branch_id
               else v_accessible is null or p.branch_id = any(v_accessible) end)
        group by p.received_by, pr.full_name
      ) e
    ), '[]'::jsonb),
    'by_branch', coalesce((
      select jsonb_agg(jsonb_build_object(
        'branch_id', b.branch_id,
        'branch_name', b.branch_name,
        'amount', b.amount,
        'payment_count', b.payment_count
      ) order by b.amount desc)
      from (
        select p.branch_id, br.name as branch_name,
               sum(p.amount) as amount, count(*) as payment_count
        from public.payments p
        join public.branches br on br.id = p.branch_id
        where p.club_id = p_club_id and p.status = 'completed'
          and p.received_at >= v_range_start and p.received_at < v_range_end
          and (case when p_branch_id is not null then p.branch_id = p_branch_id
               else v_accessible is null or p.branch_id = any(v_accessible) end)
        group by p.branch_id, br.name
      ) b
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

create or replace function public.get_payment_method_report(p_club_id uuid, p_start_date date, p_end_date date, p_branch_id uuid default null::uuid)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_accessible uuid[];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'not authorized';
  end if;

  v_accessible := public.caller_accessible_branch_ids(p_club_id);
  if p_branch_id is not null and v_accessible is not null and not (p_branch_id = any(v_accessible)) then
    raise exception 'not authorized';
  end if;

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  select jsonb_build_object(
    'total_collected', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (case when p_branch_id is not null then p.branch_id = p_branch_id
             else v_accessible is null or p.branch_id = any(v_accessible) end)
    ), 0),
    'total_refunded', coalesce((
      select sum(r.amount) from public.refunds r
      join public.payments p on p.id = r.payment_id
      where p.club_id = p_club_id and r.status = 'completed'
        and r.refunded_at >= v_range_start and r.refunded_at < v_range_end
        and (case when p_branch_id is not null then p.branch_id = p_branch_id
             else v_accessible is null or p.branch_id = any(v_accessible) end)
    ), 0),
    'by_method', coalesce((
      select jsonb_agg(jsonb_build_object(
        'method', x.method,
        'collected', x.collected,
        'collected_count', x.collected_count,
        'refunded', x.refunded,
        'refunded_count', x.refunded_count,
        'net', x.collected - x.refunded
      ) order by x.collected desc)
      from (
        select
          c.method,
          coalesce(c.collected, 0) as collected,
          coalesce(c.collected_count, 0) as collected_count,
          coalesce(r.refunded, 0) as refunded,
          coalesce(r.refunded_count, 0) as refunded_count
        from (
          select p.method, sum(p.amount) as collected, count(*) as collected_count
          from public.payments p
          where p.club_id = p_club_id and p.status = 'completed'
            and p.received_at >= v_range_start and p.received_at < v_range_end
            and (case when p_branch_id is not null then p.branch_id = p_branch_id
                 else v_accessible is null or p.branch_id = any(v_accessible) end)
          group by p.method
        ) c
        full outer join (
          select rp.method, sum(r.amount) as refunded, count(*) as refunded_count
          from public.refunds r
          join public.payments rp on rp.id = r.payment_id
          where rp.club_id = p_club_id and r.status = 'completed'
            and r.refunded_at >= v_range_start and r.refunded_at < v_range_end
            and (case when p_branch_id is not null then rp.branch_id = p_branch_id
                 else v_accessible is null or rp.branch_id = any(v_accessible) end)
          group by rp.method
        ) r on r.method = c.method
      ) x
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

create or replace function public.get_financial_reconciliation_report(p_club_id uuid, p_start_date date, p_end_date date, p_branch_id uuid default null::uuid)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_accessible uuid[];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'not authorized';
  end if;

  v_accessible := public.caller_accessible_branch_ids(p_club_id);
  if p_branch_id is not null and v_accessible is not null and not (p_branch_id = any(v_accessible)) then
    raise exception 'not authorized';
  end if;

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  select jsonb_build_object(
    'cash_payments_total', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.method = 'cash' and p.status = 'completed'
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (case when p_branch_id is not null then p.branch_id = p_branch_id
             else v_accessible is null or p.branch_id = any(v_accessible) end)
    ), 0),
    'cash_payments_linked_to_shift', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.method = 'cash' and p.status = 'completed'
        and p.cash_shift_id is not null
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (case when p_branch_id is not null then p.branch_id = p_branch_id
             else v_accessible is null or p.branch_id = any(v_accessible) end)
    ), 0),
    'cash_payments_unlinked_to_shift_count', coalesce((
      select count(*) from public.payments p
      where p.club_id = p_club_id and p.method = 'cash' and p.status = 'completed'
        and p.cash_shift_id is null
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (case when p_branch_id is not null then p.branch_id = p_branch_id
             else v_accessible is null or p.branch_id = any(v_accessible) end)
    ), 0),

    'shifts_closed_count', coalesce((
      select count(*) from public.cash_shifts cs
      where cs.club_id = p_club_id and cs.status = 'closed'
        and cs.closed_at >= v_range_start and cs.closed_at < v_range_end
        and (case when p_branch_id is not null then cs.branch_id = p_branch_id
             else v_accessible is null or cs.branch_id = any(v_accessible) end)
    ), 0),
    'total_shortage', coalesce((
      select sum(-cs.variance) from public.cash_shifts cs
      where cs.club_id = p_club_id and cs.status = 'closed' and cs.variance < 0
        and cs.closed_at >= v_range_start and cs.closed_at < v_range_end
        and (case when p_branch_id is not null then cs.branch_id = p_branch_id
             else v_accessible is null or cs.branch_id = any(v_accessible) end)
    ), 0),
    'total_overage', coalesce((
      select sum(cs.variance) from public.cash_shifts cs
      where cs.club_id = p_club_id and cs.status = 'closed' and cs.variance > 0
        and cs.closed_at >= v_range_start and cs.closed_at < v_range_end
        and (case when p_branch_id is not null then cs.branch_id = p_branch_id
             else v_accessible is null or cs.branch_id = any(v_accessible) end)
    ), 0),

    'unreceipted_required_payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'payment_id', p.id, 'amount', p.amount, 'method', p.method, 'received_at', p.received_at
      ) order by p.received_at)
      from public.payments p
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (case when p_branch_id is not null then p.branch_id = p_branch_id
             else v_accessible is null or p.branch_id = any(v_accessible) end)
        and not exists (
          select 1 from public.official_collection_receipts r
          where r.payment_id = p.id and r.status = 'active'
        )
        and exists (
          select 1 from public.government_collection_policies gp
          where gp.club_id = p.club_id
            and gp.enabled and gp.official_receipt_required
            and p.method = any(gp.required_payment_methods)
            and (gp.branch_id is null or gp.branch_id = p.branch_id)
        )
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

create or replace function public.get_booking_report(p_club_id uuid, p_start_date date, p_end_date date, p_branch_id uuid default null::uuid)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_accessible uuid[];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'not authorized';
  end if;

  v_accessible := public.caller_accessible_branch_ids(p_club_id);
  if p_branch_id is not null and v_accessible is not null and not (p_branch_id = any(v_accessible)) then
    raise exception 'not authorized';
  end if;

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  select jsonb_build_object(
    'by_status', coalesce((
      select jsonb_agg(jsonb_build_object('status', s.status, 'count', s.cnt) order by s.cnt desc)
      from (
        select b.status, count(*) as cnt
        from public.bookings b
        where b.club_id = p_club_id
          and b.start_at >= v_range_start and b.start_at < v_range_end
          and (case when p_branch_id is not null then b.branch_id = p_branch_id
               else v_accessible is null or b.branch_id = any(v_accessible) end)
        group by b.status
      ) s
    ), '[]'::jsonb),
    'by_branch', coalesce((
      select jsonb_agg(jsonb_build_object(
        'branch_id', br.id,
        'branch_name', br.name,
        'booking_count', coalesce(bc.cnt, 0)
      ) order by br.name)
      from public.branches br
      left join (
        select b.branch_id, count(*) as cnt
        from public.bookings b
        where b.club_id = p_club_id
          and b.status in ('confirmed', 'checked_in', 'completed')
          and b.start_at >= v_range_start and b.start_at < v_range_end
        group by b.branch_id
      ) bc on bc.branch_id = br.id
      where br.club_id = p_club_id
        and (case when p_branch_id is not null then br.id = p_branch_id
             else v_accessible is null or br.id = any(v_accessible) end)
    ), '[]'::jsonb),
    'cancellation_rate', (
      select case when count(*) = 0 then null
        else round(100.0 * count(*) filter (where b.status = 'cancelled') / count(*), 1)
      end
      from public.bookings b
      where b.club_id = p_club_id
        and b.start_at >= v_range_start and b.start_at < v_range_end
        and (case when p_branch_id is not null then b.branch_id = p_branch_id
             else v_accessible is null or b.branch_id = any(v_accessible) end)
    ),
    'average_booking_value', (
      select case when count(*) filter (where b.status in ('confirmed','checked_in','completed')) = 0 then null
        else round(sum(b.total_price - coalesce(b.discount_amount, 0)) filter (where b.status in ('confirmed','checked_in','completed'))
          / count(*) filter (where b.status in ('confirmed','checked_in','completed')), 2)
      end
      from public.bookings b
      where b.club_id = p_club_id
        and b.start_at >= v_range_start and b.start_at < v_range_end
        and (case when p_branch_id is not null then b.branch_id = p_branch_id
             else v_accessible is null or b.branch_id = any(v_accessible) end)
    )
  ) into v_result;

  return v_result;
end;
$function$;
