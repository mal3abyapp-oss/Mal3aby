-- Reports + Invoices + Universal Entity Drill-Down audit: official_
-- collection_receipts already has a real, populated invoice_id column
-- (confirmed via information_schema -- not an invented relation), but
-- get_official_receipts_report()'s jsonb payload only ever exposed
-- booking_id, so the Official Receipts report could link a receipt to
-- its booking but never directly to its invoice -- the receipt->invoice
-- requirement was genuinely unmet, not just unimplemented in the UI.
--
-- Zero signature change (same 11 args, same RETURNS jsonb), zero
-- RETURNS TABLE shape change -- only one additional key added to the
-- existing jsonb_build_object() call, so this carries none of this
-- project's own "orphaned overload"/signature-drift regression risk
-- (CREATE OR REPLACE only silently drops+recreates grants when the
-- argument list or RETURNS TABLE shape changes; neither happens here).
-- GRANT is re-stated explicitly below anyway, matching this project's
-- own standing verification discipline for every RPC touch. Live-DB
-- signature and grants were read and confirmed unchanged before and
-- after this migration (single overload; authenticated/postgres/
-- service_role only, no anon/public).
create or replace function public.get_official_receipts_report(
  p_club_id uuid,
  p_start_date date,
  p_end_date date,
  p_receipt_serial text default null::text,
  p_receipt_book text default null::text,
  p_receipt_series text default null::text,
  p_entered_by uuid default null::uuid,
  p_branch_id uuid default null::uuid,
  p_field_id uuid default null::uuid,
  p_payment_method text default null::text,
  p_status text default null::text
)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('payment.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  with filtered as (
    select ocr.*, b.name as branch_name, f.name as field_name, c.full_name as customer_name, p.full_name as entered_by_name
    from public.official_collection_receipts ocr
    left join public.branches b on b.id = ocr.branch_id
    left join public.fields f on f.id = ocr.field_id
    left join public.customers c on c.id = ocr.customer_id
    left join public.profiles p on p.user_id = ocr.entered_by
    where ocr.club_id = p_club_id
      and ocr.receipt_date >= p_start_date
      and ocr.receipt_date <= p_end_date
      and (p_receipt_serial is null or ocr.normalized_receipt_serial ilike '%' || lower(trim(p_receipt_serial)) || '%')
      and (p_receipt_book is null or ocr.receipt_book = p_receipt_book)
      and (p_receipt_series is null or ocr.receipt_series = p_receipt_series)
      and (p_entered_by is null or ocr.entered_by = p_entered_by)
      and (p_branch_id is null or ocr.branch_id = p_branch_id)
      and (p_field_id is null or ocr.field_id = p_field_id)
      and (p_payment_method is null or ocr.payment_method = p_payment_method)
      and (p_status is null or ocr.status = p_status)
  )
  select jsonb_build_object(
    'receipts', coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'receipt_book', f.receipt_book, 'receipt_series', f.receipt_series,
      'receipt_serial', f.receipt_serial, 'receipt_date', f.receipt_date, 'receipt_amount', f.receipt_amount,
      'payment_method', f.payment_method, 'status', f.status,
      'branch_name', f.branch_name, 'field_name', f.field_name, 'customer_name', f.customer_name,
      'entered_by_name', f.entered_by_name, 'booking_id', f.booking_id, 'invoice_id', f.invoice_id,
      'reversed_at', f.reversed_at, 'reversal_reason', f.reversal_reason
    ) order by f.receipt_date desc, f.created_at desc), '[]'::jsonb),
    'total_count', count(*),
    'active_count', count(*) filter (where f.status = 'active'),
    'reversed_count', count(*) filter (where f.status = 'reversed'),
    'total_collected_amount', coalesce(sum(f.receipt_amount) filter (where f.status = 'active'), 0)
  )
  into v_result
  from filtered f;

  return v_result;
end;
$function$;

grant execute on function public.get_official_receipts_report(uuid, date, date, text, text, text, uuid, uuid, uuid, text, text) to authenticated;
revoke execute on function public.get_official_receipts_report(uuid, date, date, text, text, text, uuid, uuid, uuid, text, text) from public, anon;
