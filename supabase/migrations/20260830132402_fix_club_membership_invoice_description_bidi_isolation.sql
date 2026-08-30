-- PRINTING PRODUCTION ACCEPTANCE (2026-08-30), Section 10 (RTL/Arabic).
--
-- Live visual verification of the D7 fix (20260830131803) found a real,
-- reproducible bidi rendering bug: the migration's own date range, e.g.
-- "عضوية شهرية تجريبية — 2026-08-30 → 2026-09-29", displays VISUALLY
-- REVERSED as "...29-09-2026 → 30-08-2026..." when rendered inside an
-- RTL invoice table cell (confirmed live via screenshot in the actual
-- BillingPage.tsx invoice document, src/features/billing/BillingPage.tsx
-- line 958, `<td className="p-1">{item.description}</td>` -- one bare
-- string, no directional isolation). This is the exact same defect
-- class already fixed once this session in commit f0cbb0a (RTL bidi
-- reversal of operating-hours ranges: "08:00-23:00" rendering as
-- "23:00-08:00" for the same reason -- two bare LTR runs joined by a
-- neutral dash/arrow inside an RTL context get reordered by the
-- browser's bidi algorithm even though the underlying text order is
-- correct).
--
-- That prior fix used dir="ltr" at the React render site, which is not
-- available here: item.description is one opaque string from the DB
-- consumed by a shared, already-verified generic invoice/receipt
-- renderer (no per-substring styling hook). The correct general fix
-- for an LTR run embedded inside RTL prose is Unicode directional
-- isolation: wrap the date range in FSI (U+2068, chr(8296)) ... PDI
-- (U+2069, chr(8297)), which tells the bidi algorithm "the enclosed
-- text is an isolated LTR run -- do not let its neutral characters
-- interact with surrounding RTL context". This fixes the bug at the
-- data layer, protecting every current and future consumer of this
-- description string (not just this one render site), and works
-- correctly in both Arabic (RTL) and English (LTR) UI since FSI/PDI
-- are invisible, zero-width formatting characters in both directions.
--
-- No RETURNS TABLE shape change -- plain CREATE OR REPLACE. Live
-- re-verified via screenshot after applying: a freshly re-sold QA
-- membership now shows "عضوية شهرية تجريبية 2026-08-30 → 2026-09-29"
-- in correct chronological order.

create or replace function public.sell_club_membership(p_club_id uuid, p_customer_id uuid, p_plan_id uuid, p_branch_id uuid, p_start_date date, p_discount numeric DEFAULT 0, p_idempotency_key uuid DEFAULT NULL::uuid)
 returns table(membership_subscription_id uuid, invoice_id uuid, membership_number text)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_plan record;
  v_existing_membership_id uuid;
  v_existing_invoice_id uuid;
  v_existing_number text;
  v_end_date date;
  v_net_price numeric;
  v_invoice_number text;
  v_invoice_id uuid;
  v_subscription_id uuid;
  v_membership_number text;
  v_branch_allowed boolean;
  v_description text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('club_membership.create', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if not public._club_membership_module_active(p_club_id) then
    raise exception 'the club membership module is not active for this club';
  end if;

  if not public.club_write_allowed(p_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new commitments';
  end if;

  if p_idempotency_key is not null then
    select k.membership_subscription_id into v_existing_membership_id
    from public.club_membership_sale_keys k
    where k.idempotency_key = p_idempotency_key;

    if v_existing_membership_id is not null then
      select s.invoice_id, s.membership_number into v_existing_invoice_id, v_existing_number
      from public.club_membership_subscriptions s where s.id = v_existing_membership_id;
      return query select v_existing_membership_id, v_existing_invoice_id, v_existing_number;
      return;
    end if;
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
    raise exception 'customer not found in this club';
  end if;

  if not public.user_has_branch_access(p_club_id, p_branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  select * into v_plan from public.club_membership_plans
  where id = p_plan_id and club_id = p_club_id and archived_at is null
  for update;

  if v_plan.id is null then
    raise exception 'plan not found in this club';
  end if;

  if not v_plan.is_active then
    raise exception 'this plan is no longer available for purchase';
  end if;

  if not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'branch not found in this club';
  end if;

  if v_plan.branch_scope = 'selected_branches' then
    select exists (
      select 1 from public.club_membership_plan_branches
      where plan_id = v_plan.id and branch_id = p_branch_id
    ) into v_branch_allowed;

    if not v_branch_allowed then
      raise exception 'this plan is not available at the selected branch';
    end if;
  end if;

  v_end_date := case v_plan.duration_unit
    when 'day' then (p_start_date + (v_plan.duration_value || ' days')::interval)::date
    when 'month' then (p_start_date + (v_plan.duration_value || ' months')::interval - interval '1 day')::date
    when 'year' then (p_start_date + (v_plan.duration_value || ' years')::interval - interval '1 day')::date
  end;

  if exists (
    select 1 from public.club_membership_subscriptions ex
    where ex.club_id = p_club_id
      and ex.customer_id = p_customer_id
      and ex.status in ('pending_payment', 'scheduled', 'active', 'frozen')
      and daterange(ex.start_date, ex.end_date, '[]') && daterange(p_start_date, v_end_date, '[]')
  ) then
    raise exception 'this customer already has a membership period that overlaps the selected dates';
  end if;

  v_net_price := round(greatest(v_plan.price - coalesce(p_discount, 0), 0), 2);
  v_membership_number := public._next_club_membership_number_internal(p_club_id);

  v_invoice_number := public.issue_invoice_number(p_branch_id, p_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (p_club_id, p_branch_id, v_invoice_number, p_customer_id, 'issued', v_plan.price, coalesce(p_discount, 0), v_net_price, now(), auth.uid())
  returning id into v_invoice_id;

  insert into public.club_membership_subscriptions (
    club_id, branch_id, customer_id, plan_id, membership_number,
    plan_name_ar_snapshot, plan_name_en_snapshot, price_snapshot,
    duration_value_snapshot, duration_unit_snapshot,
    start_date, end_date, status, invoice_id, created_by
  )
  values (
    p_club_id, p_branch_id, p_customer_id, v_plan.id, v_membership_number,
    v_plan.name_ar, v_plan.name_en, v_net_price,
    v_plan.duration_value, v_plan.duration_unit,
    p_start_date, v_end_date, 'pending_payment', v_invoice_id, auth.uid()
  )
  returning id into v_subscription_id;

  v_description := v_plan.name_ar || ' ' || chr(8296) || to_char(p_start_date, 'YYYY-MM-DD') || ' → ' || to_char(v_end_date, 'YYYY-MM-DD') || chr(8297);

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, v_description, 'club_membership', v_subscription_id, 1, v_plan.price, v_net_price);

  if p_idempotency_key is not null then
    insert into public.club_membership_sale_keys (idempotency_key, membership_subscription_id)
    values (p_idempotency_key, v_subscription_id)
    on conflict (idempotency_key) do nothing;
  end if;

  perform public.write_audit_log(
    p_club_id, 'club_membership.created', 'club_membership_subscription', v_subscription_id, null,
    jsonb_build_object('plan_id', v_plan.id, 'customer_id', p_customer_id, 'start_date', p_start_date, 'end_date', v_end_date, 'price', v_net_price),
    null
  );

  return query select v_subscription_id, v_invoice_id, v_membership_number;
end;
$function$;

create or replace function public.renew_club_membership(p_membership_subscription_id uuid, p_plan_id uuid DEFAULT NULL::uuid, p_start_date date DEFAULT NULL::date, p_discount numeric DEFAULT 0, p_idempotency_key uuid DEFAULT NULL::uuid)
 returns table(membership_subscription_id uuid, invoice_id uuid, membership_number text)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_current record;
  v_plan record;
  v_existing_membership_id uuid;
  v_existing_invoice_id uuid;
  v_existing_number text;
  v_effective_start date;
  v_end_date date;
  v_net_price numeric;
  v_invoice_number text;
  v_invoice_id uuid;
  v_subscription_id uuid;
  v_membership_number text;
  v_today date;
  v_branch_allowed boolean;
  v_description text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select s.* into v_current
  from public.club_membership_subscriptions s
  where s.id = p_membership_subscription_id
    and s.club_id in (select public.user_club_ids())
    and public.has_permission('club_membership.renew', s.club_id)
  for update;

  if v_current.id is null then
    raise exception 'club membership not found or you do not have permission to renew it';
  end if;

  if not public._club_membership_module_active(v_current.club_id) then
    raise exception 'the club membership module is not active for this club';
  end if;

  if not public.club_write_allowed(v_current.club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new commitments';
  end if;

  if v_current.status not in ('active', 'scheduled', 'expired') then
    raise exception 'only an active, scheduled, or expired membership can be renewed';
  end if;

  select (day_start at time zone (select timezone from public.clubs where id = v_current.club_id))::date
    into v_today
    from public.club_local_day_bounds(v_current.club_id, current_date);

  if v_current.status in ('active', 'scheduled') then
    v_effective_start := v_current.end_date + 1;
  else
    v_effective_start := coalesce(p_start_date, v_today);
  end if;

  if p_start_date is not null and v_current.status = 'expired' then
    v_effective_start := p_start_date;
  end if;

  if p_idempotency_key is not null then
    select k.membership_subscription_id into v_existing_membership_id
    from public.club_membership_sale_keys k
    where k.idempotency_key = p_idempotency_key;

    if v_existing_membership_id is not null then
      select s.invoice_id, s.membership_number into v_existing_invoice_id, v_existing_number
      from public.club_membership_subscriptions s where s.id = v_existing_membership_id;
      return query select v_existing_membership_id, v_existing_invoice_id, v_existing_number;
      return;
    end if;
  end if;

  select * into v_plan from public.club_membership_plans
  where id = coalesce(p_plan_id, v_current.plan_id) and club_id = v_current.club_id and archived_at is null
  for update;

  if v_plan.id is null then
    raise exception 'plan not found in this club';
  end if;

  if not v_plan.is_active then
    raise exception 'this plan is no longer available for purchase';
  end if;

  if not v_plan.allow_renewal then
    raise exception 'this plan does not allow renewal';
  end if;

  if v_plan.branch_scope = 'selected_branches' then
    select exists (
      select 1 from public.club_membership_plan_branches
      where plan_id = v_plan.id and branch_id = v_current.branch_id
    ) into v_branch_allowed;

    if not v_branch_allowed then
      raise exception 'this plan is not available at the membership''s branch';
    end if;
  end if;

  v_end_date := case v_plan.duration_unit
    when 'day' then (v_effective_start + (v_plan.duration_value || ' days')::interval)::date
    when 'month' then (v_effective_start + (v_plan.duration_value || ' months')::interval - interval '1 day')::date
    when 'year' then (v_effective_start + (v_plan.duration_value || ' years')::interval - interval '1 day')::date
  end;

  if exists (
    select 1 from public.club_membership_subscriptions ex
    where ex.club_id = v_current.club_id
      and ex.customer_id = v_current.customer_id
      and ex.id != v_current.id
      and ex.status in ('pending_payment', 'scheduled', 'active', 'frozen')
      and daterange(ex.start_date, ex.end_date, '[]') && daterange(v_effective_start, v_end_date, '[]')
  ) then
    raise exception 'this customer already has a membership period that overlaps the computed renewal dates';
  end if;

  v_net_price := round(greatest(v_plan.price - coalesce(p_discount, 0), 0), 2);
  v_membership_number := public._next_club_membership_number_internal(v_current.club_id);

  v_invoice_number := public.issue_invoice_number(v_current.branch_id, v_current.club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_current.club_id, v_current.branch_id, v_invoice_number, v_current.customer_id, 'issued', v_plan.price, coalesce(p_discount, 0), v_net_price, now(), auth.uid())
  returning id into v_invoice_id;

  insert into public.club_membership_subscriptions (
    club_id, branch_id, customer_id, plan_id, membership_number,
    plan_name_ar_snapshot, plan_name_en_snapshot, price_snapshot,
    duration_value_snapshot, duration_unit_snapshot,
    start_date, end_date, status, invoice_id, created_by
  )
  values (
    v_current.club_id, v_current.branch_id, v_current.customer_id, v_plan.id, v_membership_number,
    v_plan.name_ar, v_plan.name_en, v_net_price,
    v_plan.duration_value, v_plan.duration_unit,
    v_effective_start, v_end_date, 'pending_payment', v_invoice_id, auth.uid()
  )
  returning id into v_subscription_id;

  v_description := v_plan.name_ar || ' ' || chr(8296) || to_char(v_effective_start, 'YYYY-MM-DD') || ' → ' || to_char(v_end_date, 'YYYY-MM-DD') || chr(8297);

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, v_description, 'club_membership', v_subscription_id, 1, v_plan.price, v_net_price);

  if p_idempotency_key is not null then
    insert into public.club_membership_sale_keys (idempotency_key, membership_subscription_id)
    values (p_idempotency_key, v_subscription_id)
    on conflict (idempotency_key) do nothing;
  end if;

  perform public.write_audit_log(
    v_current.club_id, 'club_membership.renewed', 'club_membership_subscription', v_subscription_id,
    jsonb_build_object('previous_membership_subscription_id', v_current.id),
    jsonb_build_object('plan_id', v_plan.id, 'start_date', v_effective_start, 'end_date', v_end_date, 'price', v_net_price),
    null
  );

  return query select v_subscription_id, v_invoice_id, v_membership_number;
end;
$function$;
