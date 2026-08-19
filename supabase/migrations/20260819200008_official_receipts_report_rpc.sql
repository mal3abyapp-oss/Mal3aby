-- Government / Ministry Collection Compliance -- report RPC (directive
-- sections 39-42, 61).
--
-- Follows the same rpc_name(p_club_id, p_start_date, p_end_date, ...)
-- convention every other Reports RPC in this codebase already uses
-- (confirmed via the useDateRangeReport hook audit), so this report
-- reuses the shared hook/filter components rather than a bespoke
-- pattern. Returns rows (already tenant-scoped, filterable) plus
-- aggregate totals -- directive section 41: reversed receipts must
-- NOT count toward the active-collected total.
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
returns table(
  receipts jsonb,
  total_count bigint,
  active_count bigint,
  reversed_count bigint,
  total_collected_amount numeric
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('payment.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
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
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'receipt_book', f.receipt_book, 'receipt_series', f.receipt_series,
      'receipt_serial', f.receipt_serial, 'receipt_date', f.receipt_date, 'receipt_amount', f.receipt_amount,
      'payment_method', f.payment_method, 'status', f.status,
      'branch_name', f.branch_name, 'field_name', f.field_name, 'customer_name', f.customer_name,
      'entered_by_name', f.entered_by_name, 'booking_id', f.booking_id,
      'reversed_at', f.reversed_at, 'reversal_reason', f.reversal_reason
    ) order by f.receipt_date desc, f.created_at desc), '[]'::jsonb) as receipts,
    count(*) as total_count,
    count(*) filter (where f.status = 'active') as active_count,
    count(*) filter (where f.status = 'reversed') as reversed_count,
    -- Directive section 41: reversed receipts excluded from the
    -- collected total -- they represent money that was corrected/
    -- undone, not actually retained.
    coalesce(sum(f.receipt_amount) filter (where f.status = 'active'), 0) as total_collected_amount
  from filtered f;
end;
$function$;

revoke all on function public.get_official_receipts_report(uuid, date, date, text, text, text, uuid, uuid, uuid, text, text) from public;
revoke all on function public.get_official_receipts_report(uuid, date, date, text, text, text, uuid, uuid, uuid, text, text) from anon;
grant execute on function public.get_official_receipts_report(uuid, date, date, text, text, text, uuid, uuid, uuid, text, text) to authenticated;
