-- Government / Ministry Collection Compliance -- Platform Owner
-- cross-tenant visibility (directive sections 45-46).
--
-- Government-affiliated clubs, receipt counts, collected amounts --
-- deliberately NO receipt images or per-receipt detail exposed to the
-- platform owner (directive section 45: "لا تعرض Sensitive receipt
-- images بلا حاجة"). This is a summary view for platform-wide
-- compliance oversight, not a duplicate of the club-level report.
create or replace function public.get_platform_government_compliance_summary()
returns table(
  club_id uuid,
  club_name text,
  enabled boolean,
  authority_type text,
  official_receipt_required boolean,
  receipt_count bigint,
  active_receipt_count bigint,
  reversed_receipt_count bigint,
  total_collected numeric,
  latest_receipt_date date
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  return query
  select
    c.id as club_id, c.name_ar as club_name,
    coalesce(gcp.enabled, false) as enabled,
    gcp.authority_type,
    coalesce(gcp.official_receipt_required, false) as official_receipt_required,
    count(ocr.id) as receipt_count,
    count(ocr.id) filter (where ocr.status='active') as active_receipt_count,
    count(ocr.id) filter (where ocr.status='reversed') as reversed_receipt_count,
    coalesce(sum(ocr.receipt_amount) filter (where ocr.status='active'), 0) as total_collected,
    max(ocr.receipt_date) as latest_receipt_date
  from public.clubs c
  left join public.government_collection_policies gcp on gcp.club_id = c.id and gcp.branch_id is null and gcp.field_id is null
  left join public.official_collection_receipts ocr on ocr.club_id = c.id
  group by c.id, c.name_ar, gcp.enabled, gcp.authority_type, gcp.official_receipt_required
  order by coalesce(gcp.enabled, false) desc, c.name_ar;
end;
$function$;

revoke all on function public.get_platform_government_compliance_summary() from public;
revoke all on function public.get_platform_government_compliance_summary() from anon;
grant execute on function public.get_platform_government_compliance_summary() to authenticated;
