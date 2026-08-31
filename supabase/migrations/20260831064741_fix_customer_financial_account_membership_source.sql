-- CUSTOMER PORTAL / CUSTOMER360 ACCEPTANCE (2026-08-31): real defect
-- confirmed via live cross-check between the customer portal ("My
-- Payments") and the staff-side Customer 360 financial account view --
-- get_customer_financial_account()'s per-invoice `source` derivation
-- (added in 20260824070000_fix_customer_360_invoice_summary_n_plus_one.sql)
-- only ever checks `bookings.invoice_id` and `subscriptions.invoice_id`
-- (academy), never `club_membership_subscriptions.invoice_id` -- every
-- club-membership sale/renewal invoice therefore always falls through
-- to the generic 'other' bucket, while the exact same invoice shows a
-- correct, specific source everywhere else in the product (Finance
-- Invoices list already has a working 'club_membership' source
-- classification elsewhere; only this one RPC's CASE expression was
-- missing the branch). Live-reproduced on a fresh QA fixture: a real
-- club-membership sale (invoice QAFULL-MAIN-2026-000057) and its
-- renewal (QAFULL-MAIN-2026-000059) both returned source:'other' from
-- this RPC while the sibling booking and academy-subscription invoices
-- on the same customer correctly returned 'booking'/
-- 'academy_subscription'.
--
-- Minimal fix: add the missing CASE branch, ordered after booking/
-- academy (an invoice can only ever be linked to one source table by
-- construction, so branch order doesn't change any existing row's
-- classification -- this can only ever change a current 'other' into
-- 'club_membership', never regress an already-correct booking/
-- academy_subscription classification). Everything else in the
-- function body is byte-identical to the live 20260824070000 version.
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
        when exists (select 1 from public.club_membership_subscriptions cms where cms.invoice_id = pi.id) then 'club_membership'
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

comment on function public.get_customer_financial_account(uuid, uuid, int, int) is
  'Customer 360 financial account (ledger page + payment history page + lifetime summary). Ledger page and lifetime summary each resolve payment status via a single batched call to get_invoice_payment_summary(uuid[]) (fixed from one call per invoice -- see 20260824070000). Per-row `source` classification now also recognizes club_membership_subscriptions.invoice_id, not just bookings/subscriptions -- see 20260831030000.';
