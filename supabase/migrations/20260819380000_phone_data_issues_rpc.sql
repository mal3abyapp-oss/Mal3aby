-- Directive section 76: minimal actionable view of phone data issues
-- (customers with no canonical phone_e164 -- either never had a phone,
-- or had one that couldn't be safely normalized during backfill and
-- was deliberately left NULL rather than guessed, per section 32/75).
-- Tenant-scoped, reuses the existing customer.view permission.
create or replace function public.get_phone_data_issues(p_club_id uuid)
returns table(
  customer_id uuid,
  full_name text,
  mobile_display text,
  issue text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
  select c.id, c.full_name, c.mobile_display,
    case
      when c.mobile_display is null or trim(c.mobile_display) = '' then 'no_phone_on_file'
      else 'unparseable_historical_phone'
    end as issue
  from public.customers c
  where c.club_id = p_club_id
    and c.phone_e164 is null
    and c.mobile_display is not null
    and trim(c.mobile_display) != '';
end;
$function$;

revoke all on function public.get_phone_data_issues(uuid) from public;
revoke all on function public.get_phone_data_issues(uuid) from anon;
grant execute on function public.get_phone_data_issues(uuid) to authenticated;
