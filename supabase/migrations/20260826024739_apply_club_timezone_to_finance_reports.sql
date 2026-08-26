-- CASH RECONCILIATION & FINANCE OPERATIONS audit -- apply
-- club_local_day_bounds() to every affected finance/report RPC.
--
-- Every rewrite below changes ONLY the date-boundary comparison
-- (`col::date between p_start_date and p_end_date` /
-- `col::date = current_date` / `current_date`) to an instant-range
-- comparison against club_local_day_bounds(). No sum/join/status
-- filter/grouping logic changed anywhere. Same signatures throughout
-- -- safe in-place CREATE OR REPLACE, no new overloads.
--
-- get_official_receipts_report is deliberately NOT touched:
-- official_collection_receipts.receipt_date is a plain `date` column
-- (a human-entered receipt date, never derived from a timestamptz
-- instant) -- there is no UTC/local ambiguity to fix there.

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

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);
  select coalesce(c.timezone, 'Africa/Cairo') into v_timezone from public.clubs c where c.id = p_club_id;

  select jsonb_build_object(
    'total_revenue', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (p_branch_id is null or p.branch_id = p_branch_id)
        and (p_method is null or p.method = p_method)
    ), 0),
    -- Bucketed by the club's own local calendar day (same conversion
    -- club_local_day_bounds() uses), not the UTC day -- a payment at
    -- 00:29 local groups into its real local day, not the prior UTC day.
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.day, 'revenue', d.revenue) order by d.day)
      from (
        select (p.received_at at time zone v_timezone)::date as day, sum(p.amount) as revenue
        from public.payments p
        where p.club_id = p_club_id and p.status = 'completed'
          and p.received_at >= v_range_start and p.received_at < v_range_end
          and (p_branch_id is null or p.branch_id = p_branch_id)
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
          and (p_branch_id is null or p.branch_id = p_branch_id)
          and (p_method is null or p.method = p_method)
        group by p.method
      ) m
    ), '[]'::jsonb),
    'refunds_total', coalesce((
      select sum(r.amount) from public.refunds r
      join public.payments p on p.id = r.payment_id
      where p.club_id = p_club_id and r.status = 'completed'
        and r.refunded_at >= v_range_start and r.refunded_at < v_range_end
        and (p_branch_id is null or p.branch_id = p_branch_id)
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

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  select jsonb_build_object(
    'total_collected', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (p_branch_id is null or p.branch_id = p_branch_id)
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
          and (p_branch_id is null or p.branch_id = p_branch_id)
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
          and (p_branch_id is null or p.branch_id = p_branch_id)
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

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  select jsonb_build_object(
    'total_collected', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (p_branch_id is null or p.branch_id = p_branch_id)
    ), 0),
    'total_refunded', coalesce((
      select sum(r.amount) from public.refunds r
      join public.payments p on p.id = r.payment_id
      where p.club_id = p_club_id and r.status = 'completed'
        and r.refunded_at >= v_range_start and r.refunded_at < v_range_end
        and (p_branch_id is null or p.branch_id = p_branch_id)
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
            and (p_branch_id is null or p.branch_id = p_branch_id)
          group by p.method
        ) c
        full outer join (
          select rp.method, sum(r.amount) as refunded, count(*) as refunded_count
          from public.refunds r
          join public.payments rp on rp.id = r.payment_id
          where rp.club_id = p_club_id and r.status = 'completed'
            and r.refunded_at >= v_range_start and r.refunded_at < v_range_end
            and (p_branch_id is null or rp.branch_id = p_branch_id)
          group by rp.method
        ) r on r.method = c.method
      ) x
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

create or replace function public.get_financial_exceptions_report(p_club_id uuid, p_start_date date, p_end_date date)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_range_start timestamptz;
  v_range_end timestamptz;
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

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  select jsonb_build_object(
    'total_discounts', coalesce((
      select sum(b.discount_amount) from public.bookings b
      where b.club_id = p_club_id and b.discount_amount > 0
        and b.created_at >= v_range_start and b.created_at < v_range_end
    ), 0),
    'total_refunds', coalesce((
      select sum(r.amount) from public.refunds r
      join public.payments p on p.id = r.payment_id
      where p.club_id = p_club_id and r.status = 'completed'
        and r.refunded_at >= v_range_start and r.refunded_at < v_range_end
    ), 0),
    'void_invoice_count', coalesce((
      select count(*) from public.invoices i
      where i.club_id = p_club_id and i.status = 'void'
        and i.created_at >= v_range_start and i.created_at < v_range_end
    ), 0),
    'discounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'booking_id', d.booking_id,
        'invoice_number', d.invoice_number,
        'customer_name', d.customer_name,
        'discount_amount', d.discount_amount,
        'total_price', d.total_price,
        'applied_by', d.applied_by,
        'created_at', d.created_at
      ) order by d.created_at desc)
      from (
        select b.id as booking_id, i.invoice_number, c.full_name as customer_name,
               b.discount_amount, b.total_price, coalesce(pr.full_name, '—') as applied_by, b.created_at
        from public.bookings b
        left join public.invoices i on i.id = b.invoice_id
        left join public.customers c on c.id = b.customer_id
        left join public.profiles pr on pr.user_id = b.created_by
        where b.club_id = p_club_id and b.discount_amount > 0
          and b.created_at >= v_range_start and b.created_at < v_range_end
      ) d
    ), '[]'::jsonb),
    'refunds', coalesce((
      select jsonb_agg(jsonb_build_object(
        'refund_id', r.refund_id,
        'amount', r.amount,
        'reason', r.reason,
        'refunded_by', r.refunded_by,
        'refunded_at', r.refunded_at,
        'customer_name', r.customer_name,
        'payment_method', r.payment_method
      ) order by r.refunded_at desc)
      from (
        select ref.id as refund_id, ref.amount, ref.reason, ref.refunded_at,
               coalesce(pr.full_name, '—') as refunded_by,
               coalesce(c.full_name, '—') as customer_name, p.method as payment_method
        from public.refunds ref
        join public.payments p on p.id = ref.payment_id
        left join public.customers c on c.id = p.customer_id
        left join public.profiles pr on pr.user_id = ref.refunded_by
        where p.club_id = p_club_id and ref.status = 'completed'
          and ref.refunded_at >= v_range_start and ref.refunded_at < v_range_end
      ) r
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

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  select jsonb_build_object(
    'cash_payments_total', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.method = 'cash' and p.status = 'completed'
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (p_branch_id is null or p.branch_id = p_branch_id)
    ), 0),
    'cash_payments_linked_to_shift', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.method = 'cash' and p.status = 'completed'
        and p.cash_shift_id is not null
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (p_branch_id is null or p.branch_id = p_branch_id)
    ), 0),
    'cash_payments_unlinked_to_shift_count', coalesce((
      select count(*) from public.payments p
      where p.club_id = p_club_id and p.method = 'cash' and p.status = 'completed'
        and p.cash_shift_id is null
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (p_branch_id is null or p.branch_id = p_branch_id)
    ), 0),

    'shifts_closed_count', coalesce((
      select count(*) from public.cash_shifts cs
      where cs.club_id = p_club_id and cs.status = 'closed'
        and cs.closed_at >= v_range_start and cs.closed_at < v_range_end
        and (p_branch_id is null or cs.branch_id = p_branch_id)
    ), 0),
    'total_shortage', coalesce((
      select sum(-cs.variance) from public.cash_shifts cs
      where cs.club_id = p_club_id and cs.status = 'closed' and cs.variance < 0
        and cs.closed_at >= v_range_start and cs.closed_at < v_range_end
        and (p_branch_id is null or cs.branch_id = p_branch_id)
    ), 0),
    'total_overage', coalesce((
      select sum(cs.variance) from public.cash_shifts cs
      where cs.club_id = p_club_id and cs.status = 'closed' and cs.variance > 0
        and cs.closed_at >= v_range_start and cs.closed_at < v_range_end
        and (p_branch_id is null or cs.branch_id = p_branch_id)
    ), 0),

    'unreceipted_required_payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'payment_id', p.id, 'amount', p.amount, 'method', p.method, 'received_at', p.received_at
      ) order by p.received_at)
      from public.payments p
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (p_branch_id is null or p.branch_id = p_branch_id)
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

create or replace function public.get_employee_liability_report(p_club_id uuid, p_start_date date, p_end_date date)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (
    p_club_id in (select public.user_club_ids())
    and public.has_permission('report.view', p_club_id)
    and public.has_permission('cash.liability.view', p_club_id)
  ) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  select jsonb_agg(jsonb_build_object(
    'liability_id', l.id,
    'employee_id', l.employee_id,
    'employee_name', coalesce(pr.full_name, '—'),
    'kind', l.kind,
    'original_amount', l.original_amount,
    'outstanding', l.outstanding,
    'status', l.status,
    'cash_shift_id', l.cash_shift_id,
    'created_at', l.created_at
  ) order by l.created_at desc) into v_result
  from public.employee_cash_liabilities l
  left join public.profiles pr on pr.user_id = l.employee_id
  where l.club_id = p_club_id
    and l.created_at >= v_range_start and l.created_at < v_range_end;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

create or replace function public.get_today_dashboard(p_club_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_today_start timestamptz;
  v_today_end timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('booking.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  -- "Today" is the club's own local calendar day (clubs.timezone), not
  -- the database session's UTC day -- see club_local_day_bounds().
  select day_start, day_end into v_today_start, v_today_end
  from public.club_local_day_bounds(p_club_id, (
    select (now() at time zone c.timezone)::date from public.clubs c where c.id = p_club_id
  ));

  select jsonb_build_object(
    'bookings_today_count', (
      select count(*) from public.bookings
      where club_id = p_club_id
        and start_at >= v_today_start and start_at < v_today_end
        and status != 'cancelled'
    ),
    'checked_in_count', (
      select count(*) from public.bookings
      where club_id = p_club_id
        and start_at >= v_today_start and start_at < v_today_end
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
      where p.club_id = p_club_id and p.received_at >= v_today_start and p.received_at < v_today_end and p.status = 'completed'
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
          and b.start_at >= v_today_start and b.start_at < v_today_end
        order by b.start_at
        limit 5
      ) nb
    )
  ) into v_result;

  return v_result;
end;
$function$;

create or replace function public.get_executive_dashboard(p_club_id uuid, p_start_date date, p_end_date date)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_revenue jsonb;
  v_range_start timestamptz;
  v_range_end timestamptz;
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

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  v_revenue := public.get_revenue_report(p_club_id, p_start_date, p_end_date, null, null);

  select jsonb_build_object(
    'total_revenue', coalesce(v_revenue->'total_revenue', to_jsonb(0)),
    'refunds_total', coalesce(v_revenue->'refunds_total', to_jsonb(0)),
    'outstanding_total', coalesce((
      select sum(oi.outstanding) from public.outstanding_invoices oi
      where oi.club_id = p_club_id
    ), 0),
    'bookings_count', (
      select count(*) from public.bookings b
      where b.club_id = p_club_id
        and b.status in ('confirmed', 'checked_in', 'completed')
        and b.start_at >= v_range_start and b.start_at < v_range_end
    ),
    'bookings_cancelled_count', (
      select count(*) from public.bookings b
      where b.club_id = p_club_id
        and b.status = 'cancelled'
        and b.start_at >= v_range_start and b.start_at < v_range_end
    ),
    'total_booked_hours', coalesce((
      select round(sum(extract(epoch from (b.end_at - b.start_at)) / 3600.0)::numeric, 2)
      from public.bookings b
      where b.club_id = p_club_id
        and b.status in ('confirmed', 'checked_in', 'completed')
        and b.start_at >= v_range_start and b.start_at < v_range_end
    ), 0),
    'active_enrollments', (
      select count(*) from public.enrollments e
      where e.club_id = p_club_id and e.status = 'active'
    ),
    'new_customers', (
      select count(*) from public.customers c
      where c.club_id = p_club_id and c.created_at >= v_range_start and c.created_at < v_range_end
    ),
    'revenue_by_day', coalesce(v_revenue->'by_day', '[]'::jsonb)
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
          and (p_branch_id is null or b.branch_id = p_branch_id)
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
      where br.club_id = p_club_id and (p_branch_id is null or br.id = p_branch_id)
    ), '[]'::jsonb),
    'cancellation_rate', (
      select case when count(*) = 0 then null
        else round(100.0 * count(*) filter (where b.status = 'cancelled') / count(*), 1)
      end
      from public.bookings b
      where b.club_id = p_club_id
        and b.start_at >= v_range_start and b.start_at < v_range_end
        and (p_branch_id is null or b.branch_id = p_branch_id)
    ),
    'average_booking_value', (
      select case when count(*) filter (where b.status in ('confirmed','checked_in','completed')) = 0 then null
        else round(sum(b.total_price - coalesce(b.discount_amount, 0)) filter (where b.status in ('confirmed','checked_in','completed'))
          / count(*) filter (where b.status in ('confirmed','checked_in','completed')), 2)
      end
      from public.bookings b
      where b.club_id = p_club_id
        and b.start_at >= v_range_start and b.start_at < v_range_end
        and (p_branch_id is null or b.branch_id = p_branch_id)
    )
  ) into v_result;

  return v_result;
end;
$function$;
