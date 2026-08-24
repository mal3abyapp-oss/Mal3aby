-- Fix: get_customer_360_summary and get_customer_financial_account called
-- public.get_invoice_payment_summary(uuid[]) once PER INVOICE ROW via
-- `cross join lateral public.get_invoice_payment_summary(array[i.id])`,
-- even though that function's own signature/comment
-- (20260817050000_invoice_payment_summary.sql) explicitly designs it to
-- accept a batch array of invoice ids and return the whole set in one
-- call ("one canonical function every screen migrates to", filtering
-- with `where i.id = any(p_invoice_ids)`).
--
-- A customer with N invoices therefore triggered N separate executions
-- of get_invoice_payment_summary -- each one re-running its own
-- correlated lateral subquery with two aggregates against
-- payment_allocations plus a refunds join -- instead of a single
-- aggregate query over all N ids at once. This RPC is invoked on every
-- "open customer" click (Customer 360 directive), so customers with
-- long invoice histories (e.g. long-running academy subscribers) turned
-- an O(1) query into O(n) function invocations on every page load.
--
-- Fix: collect all relevant invoice ids into one array first (a CTE),
-- call get_invoice_payment_summary() exactly once with that array, and
-- join the result set back to public.invoices by invoice_id -- matching
-- how the function's own uuid[] signature is meant to be used. This is
-- a pure query-shape change: same rows, same columns, same filters
-- (customer_id/club_id/status not in draft,void), same RLS (still
-- security definer + the same has_permission('customer.view', ...)
-- guard, unchanged). No behavior/output difference, only fewer function
-- invocations.

-- 1. get_customer_360_summary -- 'financial' aggregate block.
create or replace function public.get_customer_360_summary(
  p_club_id uuid,
  p_customer_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
    raise exception 'customer not found';
  end if;

  select jsonb_build_object(
    'customer', jsonb_build_object(
      'id', c.id, 'full_name', c.full_name, 'mobile_display', c.mobile_display,
      'phone_e164', c.phone_e164, 'email', c.email, 'created_at', c.created_at,
      'duplicate_review_status', c.duplicate_review_status
    ),
    'bookings_count', (select count(*) from public.bookings b where b.customer_id = p_customer_id),
    'upcoming_booking', (
      select jsonb_build_object('id', b.id, 'start_at', b.start_at, 'field_name', f.name)
      from public.bookings b join public.fields f on f.id = b.field_id
      where b.customer_id = p_customer_id and b.start_at >= now() and b.status not in ('cancelled', 'no_show')
      order by b.start_at asc limit 1
    ),
    'active_players_count', (
      select count(distinct e.player_id) from public.enrollments e
      join public.guardian_links gl on gl.player_id = e.player_id
      where gl.customer_id = p_customer_id and e.status = 'active'
    ),
    'financial', (
      with cust_invoices as (
        select i.id
        from public.invoices i
        where i.customer_id = p_customer_id and i.status not in ('draft', 'void')
      )
      select jsonb_build_object(
        'total_invoiced', coalesce(sum(s.total), 0),
        'total_paid', coalesce(sum(s.paid), 0),
        'total_refunded', coalesce(sum(s.refunded), 0),
        'outstanding', coalesce(sum(s.outstanding), 0),
        'open_invoices_count', count(*) filter (where s.outstanding > 0)
      )
      from public.get_invoice_payment_summary(
        (select coalesce(array_agg(ci.id), array[]::uuid[]) from cust_invoices ci)
      ) s
    ),
    'whatsapp_consent', (
      select jsonb_build_object('enabled', nc.enabled, 'phone_e164', nc.phone_e164, 'revoked_at', nc.revoked_at, 'consent_at', nc.consent_at)
      from public.notification_consent nc
      where nc.customer_id = p_customer_id and nc.channel = 'whatsapp'
      limit 1
    ),
    'last_payment_at', (
      select max(p.received_at) from public.payments p where p.customer_id = p_customer_id
    )
  ) into v_result
  from public.customers c
  where c.id = p_customer_id;

  return v_result;
end;
$function$;

-- 2. get_customer_financial_account -- ledger page + summary block both
-- switched from per-row lateral calls to one batched call each.
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

  with page_ids as (
    select i.id, i.invoice_number, i.issued_at, i.status
    from public.invoices i
    where i.customer_id = p_customer_id and i.club_id = p_club_id and i.status not in ('draft', 'void')
    order by i.issued_at desc nulls last
    limit p_limit offset p_offset
  ),
  page as (
    select pi.id, pi.invoice_number, pi.issued_at, pi.status, s.total, s.paid, s.outstanding, s.payment_status,
      case
        when exists (select 1 from public.bookings b where b.invoice_id = pi.id) then 'booking'
        when exists (select 1 from public.subscriptions sub where sub.invoice_id = pi.id) then 'academy_subscription'
        else 'other'
      end as source
    from page_ids pi
    join public.get_invoice_payment_summary(
      (select coalesce(array_agg(pi2.id), array[]::uuid[]) from page_ids pi2)
    ) s on s.invoice_id = pi.id
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

  with all_cust_invoices as (
    select i.id
    from public.invoices i
    where i.customer_id = p_customer_id and i.club_id = p_club_id and i.status not in ('draft', 'void')
  )
  select jsonb_build_object(
    'total_invoiced', coalesce(sum(s.total), 0),
    'total_paid', coalesce(sum(s.paid), 0),
    'total_refunded', coalesce(sum(s.refunded), 0),
    'outstanding', coalesce(sum(s.outstanding), 0)
  ) into v_summary
  from public.get_invoice_payment_summary(
    (select coalesce(array_agg(aci.id), array[]::uuid[]) from all_cust_invoices aci)
  ) s;

  return jsonb_build_object(
    'summary', coalesce(v_summary, jsonb_build_object('total_invoiced', 0, 'total_paid', 0, 'total_refunded', 0, 'outstanding', 0)),
    'ledger', jsonb_build_object('rows', v_ledger_rows, 'total_count', v_ledger_total),
    'payments', jsonb_build_object('rows', v_payment_rows, 'total_count', v_payment_total)
  );
end;
$function$;

comment on function public.get_customer_360_summary(uuid, uuid) is
  'Customer 360 overview summary. Financial totals computed via a single batched call to get_invoice_payment_summary(uuid[]) over all of the customer''s non-draft/void invoice ids (fixed from one call per invoice -- see 20260824070000).';

comment on function public.get_customer_financial_account(uuid, uuid, int, int) is
  'Customer 360 financial account (ledger page + payment history page + lifetime summary). Ledger page and lifetime summary each resolve payment status via a single batched call to get_invoice_payment_summary(uuid[]) (fixed from one call per invoice -- see 20260824070000).';
