-- FINAL REPORTING COVERAGE CLOSURE (2026-08-30): Club Membership
-- Lifecycle & Revenue report.
--
-- D1 (P2-class, found during domain-model inspection before writing
-- any code): the existing get_club_membership_report() computed New
-- vs. Renewal via "does this customer have ANY earlier subscription
-- row, ever" -- not the real renewal linkage. renew_club_membership()
-- already writes an authoritative audit_logs row (action
-- 'club_membership.renewed', before->>'previous_membership_subscription_id')
-- on every real renewal; sell_club_membership()'s 'club_membership.created'
-- rows never carry that key. Fixed to use this real linkage instead of
-- inferring from customer history.
--
-- Also extends the RPC with the financial totals this closure's
-- directive requires (revenue/collected/refunded/outstanding/average
-- value) -- computed via get_invoice_payment_summary(), the SAME
-- authoritative source already reused by Shop invoices, BillingPage,
-- and every other financial-reconciliation surface fixed in the prior
-- two sessions. No new accounting formula.
--
-- Return type is unchanged (still a single jsonb), but this widens the
-- parameter list with 2 new trailing optional params (p_branch_id,
-- p_plan_id) -- Postgres identifies functions by name+arg-TYPES, so
-- this is a NEW overload, not an in-place replace of the existing
-- 3-arg version. The old 3-arg version has confirmed ZERO UI
-- consumers anywhere in src (verified in the prior reporting-coverage
-- session before this closure directive even started) -- dropped
-- explicitly so no orphaned overload is left behind.
drop function if exists public.get_club_membership_report(uuid, date, date);

create or replace function public.get_club_membership_report(p_club_id uuid, p_start_date date, p_end_date date, p_branch_id uuid DEFAULT NULL::uuid, p_plan_id uuid DEFAULT NULL::uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_today date;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_accessible_branches uuid[];
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

  v_accessible_branches := public.caller_accessible_branch_ids(p_club_id);
  if p_branch_id is not null and v_accessible_branches is not null and not (p_branch_id = any(v_accessible_branches)) then
    raise exception 'not authorized';
  end if;

  select (day_start at time zone (select timezone from public.clubs where id = p_club_id))::date
    into v_today
    from public.club_local_day_bounds(p_club_id, current_date);

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  select jsonb_build_object(
    'counts_by_status', (
      select jsonb_object_agg(effective_status, cnt)
      from (
        select
          public.get_club_membership_effective_status(
            s.status, s.start_date,
            s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0),
            v_today
          ) as effective_status,
          count(*) as cnt
        from public.club_membership_subscriptions s
        where s.club_id = p_club_id
          and (v_accessible_branches is null or s.branch_id = any(v_accessible_branches))
          and (p_branch_id is null or s.branch_id = p_branch_id)
          and (p_plan_id is null or s.plan_id = p_plan_id)
        group by 1
      ) grouped
    ),
    'expiring_within_range', coalesce((
      select jsonb_agg(jsonb_build_object(
        'membership_subscription_id', s.id,
        'membership_number', s.membership_number,
        'customer_name', c.full_name,
        'plan_name_ar', s.plan_name_ar_snapshot,
        'plan_name_en', s.plan_name_en_snapshot,
        'effective_end_date', s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0)
      ) order by s.end_date)
      from public.club_membership_subscriptions s
      join public.customers c on c.id = s.customer_id
      where s.club_id = p_club_id
        and (v_accessible_branches is null or s.branch_id = any(v_accessible_branches))
        and (p_branch_id is null or s.branch_id = p_branch_id)
        and (p_plan_id is null or s.plan_id = p_plan_id)
        and s.status in ('active', 'frozen')
        and (s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0)) between p_start_date and p_end_date
    ), '[]'::jsonb),
    -- D1 fix: a row in this range is a RENEWAL only if a real audit-log
    -- entry says so (action 'club_membership.renewed' with a
    -- before->>'previous_membership_subscription_id' pointing back to
    -- an earlier subscription for the SAME entity_id) -- not "this
    -- customer has any earlier row ever".
    'renewals_in_range', (
      select count(*) from public.club_membership_subscriptions s
      where s.club_id = p_club_id
        and (v_accessible_branches is null or s.branch_id = any(v_accessible_branches))
        and (p_branch_id is null or s.branch_id = p_branch_id)
        and (p_plan_id is null or s.plan_id = p_plan_id)
        and s.created_at >= v_range_start and s.created_at < v_range_end
        and exists (
          select 1 from public.audit_logs al
          where al.club_id = p_club_id
            and al.entity_type = 'club_membership_subscription'
            and al.entity_id = s.id
            and al.action = 'club_membership.renewed'
            and al.before ? 'previous_membership_subscription_id'
        )
    ),
    -- D1 fix: a row is a NEW membership if it is NOT a real renewal per
    -- the same authoritative linkage above.
    'new_memberships_in_range', (
      select count(*) from public.club_membership_subscriptions s
      where s.club_id = p_club_id
        and (v_accessible_branches is null or s.branch_id = any(v_accessible_branches))
        and (p_branch_id is null or s.branch_id = p_branch_id)
        and (p_plan_id is null or s.plan_id = p_plan_id)
        and s.created_at >= v_range_start and s.created_at < v_range_end
        and not exists (
          select 1 from public.audit_logs al
          where al.club_id = p_club_id
            and al.entity_type = 'club_membership_subscription'
            and al.entity_id = s.id
            and al.action = 'club_membership.renewed'
            and al.before ? 'previous_membership_subscription_id'
        )
    ),
    'cancellations_in_range', (
      select count(*) from public.club_membership_subscriptions s
      where s.club_id = p_club_id
        and (v_accessible_branches is null or s.branch_id = any(v_accessible_branches))
        and (p_branch_id is null or s.branch_id = p_branch_id)
        and (p_plan_id is null or s.plan_id = p_plan_id)
        and s.cancelled_at is not null
        and s.cancelled_at >= v_range_start and s.cancelled_at < v_range_end
    ),
    'by_plan', coalesce((
      select jsonb_agg(jsonb_build_object(
        'plan_id', p.id,
        'plan_name_ar', p.name_ar,
        'plan_name_en', p.name_en,
        'is_active', p.is_active,
        'active_membership_count', mc.active_count,
        'total_membership_count', mc.total_count,
        'new_in_range_count', coalesce(nr.new_count, 0)
      ) order by coalesce(nr.new_count, 0) desc, p.sort_order, p.name_en)
      from public.club_membership_plans p
      left join (
        select plan_id,
          count(*) filter (where status in ('active', 'scheduled', 'frozen')) as active_count,
          count(*) as total_count
        from public.club_membership_subscriptions
        where club_id = p_club_id
          and (v_accessible_branches is null or branch_id = any(v_accessible_branches))
          and (p_branch_id is null or branch_id = p_branch_id)
        group by plan_id
      ) mc on mc.plan_id = p.id
      left join (
        select plan_id, count(*) as new_count
        from public.club_membership_subscriptions
        where club_id = p_club_id
          and (v_accessible_branches is null or branch_id = any(v_accessible_branches))
          and (p_branch_id is null or branch_id = p_branch_id)
          and created_at >= v_range_start and created_at < v_range_end
        group by plan_id
      ) nr on nr.plan_id = p.id
      where p.club_id = p_club_id
        and (p_plan_id is null or p.id = p_plan_id)
    ), '[]'::jsonb),
    -- Financial totals: authoritative via get_invoice_payment_summary(),
    -- scoped to invoices for subscriptions CREATED in the date range
    -- (matches new_memberships_in_range/renewals_in_range's own scope --
    -- "revenue this period" means membership sales/renewals sold this
    -- period, the same convention Shop/Revenue reports already use).
    'financials', (
      select jsonb_build_object(
        'gross_revenue', coalesce(sum(sum.total), 0),
        'collected', coalesce(sum(sum.paid), 0),
        'refunded', coalesce(sum(sum.refunded), 0),
        'outstanding', coalesce(sum(sum.outstanding), 0),
        'average_membership_value', case when count(*) = 0 then null else round(coalesce(sum(sum.total), 0) / count(*), 2) end,
        'membership_count', count(*)
      )
      from public.club_membership_subscriptions s
      join public.get_invoice_payment_summary(
        (select array_agg(s2.invoice_id) from public.club_membership_subscriptions s2
         where s2.club_id = p_club_id
           and (v_accessible_branches is null or s2.branch_id = any(v_accessible_branches))
           and (p_branch_id is null or s2.branch_id = p_branch_id)
           and (p_plan_id is null or s2.plan_id = p_plan_id)
           and s2.created_at >= v_range_start and s2.created_at < v_range_end)
      ) sum on sum.invoice_id = s.invoice_id
      where s.club_id = p_club_id
        and (v_accessible_branches is null or s.branch_id = any(v_accessible_branches))
        and (p_branch_id is null or s.branch_id = p_branch_id)
        and (p_plan_id is null or s.plan_id = p_plan_id)
        and s.created_at >= v_range_start and s.created_at < v_range_end
    )
  ) into v_result;

  return v_result;
end;
$function$;

-- Re-grant EXECUTE explicitly -- the DROP FUNCTION above removes all
-- existing grants on the old 3-arg identity, and the new 5-arg
-- identity starts with none. Matching the exact scope confirmed above
-- (authenticated only, no anon/PUBLIC) for the original function.
grant execute on function public.get_club_membership_report(uuid, date, date, uuid, uuid) to authenticated;

-- New RPC: paginated lifecycle table for the report's row-level view.
-- Mirrors list_club_membership_subscriptions()'s exact branch-scoping/
-- pagination pattern, scoped by date range (created_at OR
-- cancelled_at falling in range -- "activity in this period", the
-- same semantic the KPI counts above use) and enriched with the
-- authoritative per-invoice financial summary + real renewal linkage.
create or replace function public.list_club_membership_report_rows(p_club_id uuid, p_start_date date, p_end_date date, p_branch_id uuid DEFAULT NULL::uuid, p_plan_id uuid DEFAULT NULL::uuid, p_status text DEFAULT NULL::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_today date;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_accessible_branches uuid[];
  v_offset integer;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'not authorized';
  end if;

  v_accessible_branches := public.caller_accessible_branch_ids(p_club_id);
  if p_branch_id is not null and v_accessible_branches is not null and not (p_branch_id = any(v_accessible_branches)) then
    raise exception 'not authorized';
  end if;

  select (day_start at time zone (select timezone from public.clubs where id = p_club_id))::date
    into v_today
    from public.club_local_day_bounds(p_club_id, current_date);

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  v_offset := greatest(p_page - 1, 0) * greatest(p_page_size, 1);

  with base as (
    select
      s.id as membership_subscription_id,
      s.membership_number,
      s.customer_id,
      c.full_name as customer_name,
      s.plan_id,
      s.plan_name_ar_snapshot,
      s.plan_name_en_snapshot,
      s.status,
      public.get_club_membership_effective_status(
        s.status, s.start_date,
        s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0),
        v_today
      ) as effective_status,
      s.start_date,
      s.end_date,
      s.created_at,
      s.cancelled_at,
      s.branch_id,
      br.name as branch_name,
      s.price_snapshot,
      exists (
        select 1 from public.audit_logs al
        where al.club_id = p_club_id
          and al.entity_type = 'club_membership_subscription'
          and al.entity_id = s.id
          and al.action = 'club_membership.renewed'
          and al.before ? 'previous_membership_subscription_id'
      ) as is_renewal,
      sum.total,
      coalesce(sum.paid, 0) as paid,
      coalesce(sum.refunded, 0) as refunded,
      coalesce(sum.outstanding, 0) as outstanding,
      sum.payment_status
    from public.club_membership_subscriptions s
    join public.customers c on c.id = s.customer_id
    join public.branches br on br.id = s.branch_id
    left join lateral (
      select * from public.get_invoice_payment_summary(array[s.invoice_id]) limit 1
    ) sum on true
    where s.club_id = p_club_id
      and (v_accessible_branches is null or s.branch_id = any(v_accessible_branches))
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and (p_plan_id is null or s.plan_id = p_plan_id)
      and (
        (s.created_at >= v_range_start and s.created_at < v_range_end)
        or (s.cancelled_at is not null and s.cancelled_at >= v_range_start and s.cancelled_at < v_range_end)
      )
  ),
  filtered as (
    select * from base
    where (p_status is null or effective_status = p_status)
  ),
  counted as (
    select count(*) as total_count from filtered
  )
  select jsonb_build_object(
    'total_count', (select total_count from counted),
    'page', p_page,
    'page_size', p_page_size,
    'rows', coalesce((
      select jsonb_agg(row_to_json(f) order by f.created_at desc)
      from (select * from filtered order by created_at desc offset v_offset limit p_page_size) f
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

grant execute on function public.list_club_membership_report_rows(uuid, date, date, uuid, uuid, text, integer, integer) to authenticated;
