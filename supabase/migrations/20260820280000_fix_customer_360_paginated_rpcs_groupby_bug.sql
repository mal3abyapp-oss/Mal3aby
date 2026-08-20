-- Real bug found in live QA immediately after deploying the previous
-- migration: get_customer_bookings, get_customer_financial_account,
-- get_customer_communications, and get_customer_activity all combined
-- jsonb_agg(... ORDER BY col DESC) with count(*) OVER () (a window
-- function) in the same SELECT with a LIMIT/OFFSET applied directly
-- to the outer query -- Postgres correctly rejected this ("column
-- must appear in the GROUP BY clause or be used in an aggregate
-- function") because a window function's OVER () sees a different
-- row set than the aggregate once LIMIT is applied before the window
-- function's partition is fully materialized in this shape. Confirmed
-- live: get_customer_360_summary and get_customer_academy_players
-- (no LIMIT/OFFSET pagination, no window function) both executed
-- correctly on the first deploy; only the four paginated ones failed.
--
-- Fix: apply LIMIT/OFFSET inside a CTE first, compute the true
-- total_count separately (a plain scalar count over the unlimited
-- set, not a window function), then aggregate the already-paginated
-- CTE rows into jsonb. This is the standard safe pattern for
-- "paginated rows + total count" in one round trip.

create or replace function public.get_customer_bookings(
  p_club_id uuid,
  p_customer_id uuid,
  p_limit int default 20,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_rows jsonb;
  v_total bigint;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  select count(*) into v_total from public.bookings b where b.customer_id = p_customer_id and b.club_id = p_club_id;

  with page as (
    select b.id, b.start_at, b.end_at, b.status, b.total_price, f.name as field_name, b.invoice_id
    from public.bookings b
    join public.fields f on f.id = b.field_id
    where b.customer_id = p_customer_id and b.club_id = p_club_id
    order by b.start_at desc
    limit p_limit offset p_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id, 'start_at', page.start_at, 'end_at', page.end_at, 'status', page.status,
    'total_price', page.total_price, 'field_name', page.field_name, 'invoice_id', page.invoice_id
  ) order by page.start_at desc), '[]'::jsonb) into v_rows
  from page;

  return jsonb_build_object('rows', v_rows, 'total_count', v_total);
end;
$function$;

create or replace function public.get_customer_financial_account(
  p_club_id uuid,
  p_customer_id uuid,
  p_limit int default 20,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ledger_rows jsonb;
  v_ledger_total bigint;
  v_payment_rows jsonb;
  v_payment_total bigint;
  v_summary jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  select count(*) into v_ledger_total from public.invoices i
    where i.customer_id = p_customer_id and i.club_id = p_club_id and i.status not in ('draft', 'void');

  with page as (
    select i.id, i.invoice_number, i.issued_at, i.status, s.total, s.paid, s.outstanding, s.payment_status,
      case
        when exists (select 1 from public.bookings b where b.invoice_id = i.id) then 'booking'
        when exists (select 1 from public.subscriptions sub where sub.invoice_id = i.id) then 'academy_subscription'
        else 'other'
      end as source
    from public.invoices i
    cross join lateral public.get_invoice_payment_summary(array[i.id]) s
    where i.customer_id = p_customer_id and i.club_id = p_club_id and i.status not in ('draft', 'void')
    order by i.issued_at desc nulls last
    limit p_limit offset p_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'invoice_id', page.id, 'invoice_number', page.invoice_number, 'issued_at', page.issued_at,
    'status', page.status, 'total', page.total, 'paid', page.paid, 'outstanding', page.outstanding,
    'payment_status', page.payment_status, 'source', page.source
  ) order by page.issued_at desc nulls last), '[]'::jsonb) into v_ledger_rows
  from page;

  select count(*) into v_payment_total from public.payments p
    where p.customer_id = p_customer_id and p.club_id = p_club_id;

  with ppage as (
    select p.id, p.amount, p.method, p.received_at, p.reference, prof.full_name as received_by_name,
      ocr.receipt_serial, ocr.status as receipt_status
    from public.payments p
    left join public.profiles prof on prof.user_id = p.received_by
    left join public.official_collection_receipts ocr on ocr.payment_id = p.id
    where p.customer_id = p_customer_id and p.club_id = p_club_id
    order by p.received_at desc
    limit p_limit offset p_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ppage.id, 'amount', ppage.amount, 'method', ppage.method, 'received_at', ppage.received_at,
    'reference', ppage.reference, 'received_by_name', ppage.received_by_name,
    'official_receipt_serial', ppage.receipt_serial, 'official_receipt_status', ppage.receipt_status
  ) order by ppage.received_at desc), '[]'::jsonb) into v_payment_rows
  from ppage;

  select jsonb_build_object(
    'total_invoiced', coalesce(sum(s.total), 0),
    'total_paid', coalesce(sum(s.paid), 0),
    'total_refunded', coalesce(sum(s.refunded), 0),
    'outstanding', coalesce(sum(s.outstanding), 0)
  ) into v_summary
  from public.invoices i
  cross join lateral public.get_invoice_payment_summary(array[i.id]) s
  where i.customer_id = p_customer_id and i.club_id = p_club_id and i.status not in ('draft', 'void');

  return jsonb_build_object(
    'summary', coalesce(v_summary, jsonb_build_object('total_invoiced', 0, 'total_paid', 0, 'total_refunded', 0, 'outstanding', 0)),
    'ledger', jsonb_build_object('rows', v_ledger_rows, 'total_count', v_ledger_total),
    'payments', jsonb_build_object('rows', v_payment_rows, 'total_count', v_payment_total)
  );
end;
$function$;

create or replace function public.get_customer_communications(
  p_club_id uuid,
  p_customer_id uuid,
  p_limit int default 20,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_consent jsonb;
  v_rows jsonb;
  v_total bigint;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  select jsonb_build_object(
    'enabled', nc.enabled, 'phone_e164', nc.phone_e164, 'consent_source', nc.consent_source,
    'consent_at', nc.consent_at, 'revoked_at', nc.revoked_at
  ) into v_consent
  from public.notification_consent nc
  where nc.customer_id = p_customer_id and nc.channel = 'whatsapp';

  select count(*) into v_total from public.notification_queue nq
    where nq.recipient_customer_id = p_customer_id and nq.club_id = p_club_id and nq.channel = 'whatsapp';

  with page as (
    select nq.id, nq.template_key, nq.status, nq.created_at, nq.last_attempt_at
    from public.notification_queue nq
    where nq.recipient_customer_id = p_customer_id and nq.club_id = p_club_id and nq.channel = 'whatsapp'
    order by nq.created_at desc
    limit p_limit offset p_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id, 'template_key', page.template_key, 'status', page.status,
    'created_at', page.created_at, 'last_attempt_at', page.last_attempt_at
  ) order by page.created_at desc), '[]'::jsonb) into v_rows
  from page;

  return jsonb_build_object(
    'consent', v_consent,
    'events', jsonb_build_object('rows', v_rows, 'total_count', v_total)
  );
end;
$function$;

create or replace function public.get_customer_activity(
  p_club_id uuid,
  p_customer_id uuid,
  p_limit int default 30,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_rows jsonb;
  v_total bigint;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  select count(*) into v_total from public.audit_logs al
    where al.club_id = p_club_id and al.entity_type = 'customer' and al.entity_id = p_customer_id;

  with page as (
    select al.action, al.before, al.after, al.created_at, prof.full_name as actor_name
    from public.audit_logs al
    left join public.profiles prof on prof.user_id = al.actor_id
    where al.club_id = p_club_id and al.entity_type = 'customer' and al.entity_id = p_customer_id
    order by al.created_at desc
    limit p_limit offset p_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'action', page.action, 'before', page.before, 'after', page.after,
    'created_at', page.created_at, 'actor_name', page.actor_name
  ) order by page.created_at desc), '[]'::jsonb) into v_rows
  from page;

  return jsonb_build_object('rows', v_rows, 'total_count', v_total);
end;
$function$;
