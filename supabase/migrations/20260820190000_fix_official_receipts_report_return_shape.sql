-- Academy radical simplification directive section 40: "verify the
-- receipt appears in ... the Official Receipt report." Live QA E2E
-- (2026-08-20) reproduced a real, pre-existing crash reaching this
-- report: get_official_receipts_report() was defined as
-- `RETURNS TABLE(receipts jsonb, total_count bigint, ...)`, which
-- PostgREST serializes as a JSON ARRAY of rows (confirmed via
-- pg_proc.proretset = true). Every sibling report RPC in this module
-- (get_revenue_report, get_collections_report, etc.) instead returns a
-- single scalar `jsonb` object (proretset = false) -- the one this
-- report's own client component (ReportOfficialReceiptsContent,
-- shared verbatim by the standalone /app/reports route and the
-- Finance > Invoices & Receipts > Official receipts sub-tab) was
-- actually written against (`data.receipts.length`, `data.total_count`
-- etc, not `data[0].receipts.length`). The mismatch meant `data` was
-- an array with no `.receipts` property -- immediate
-- "Cannot read properties of undefined (reading 'length')" crash the
-- moment this screen was opened, for every club, in every environment.
--
-- Fix: switch this RPC to the same single-jsonb-object convention as
-- every other report RPC, matching what the client already expects.
-- No client-side change needed.

drop function if exists public.get_official_receipts_report(uuid, date, date, text, text, text, uuid, uuid, uuid, text, text);

create or replace function public.get_official_receipts_report(
  p_club_id uuid,
  p_start_date date,
  p_end_date date,
  p_receipt_serial text default null,
  p_receipt_book text default null,
  p_receipt_series text default null,
  p_entered_by uuid default null,
  p_branch_id uuid default null,
  p_field_id uuid default null,
  p_payment_method text default null,
  p_status text default null
)
returns jsonb
language plpgsql
security definer
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
      'entered_by_name', f.entered_by_name, 'booking_id', f.booking_id,
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
