-- get_customer_activity's rows previously had no stable identifier
-- (only action/before/after/created_at/actor_name), forcing the
-- frontend to key React list rows by `${created_at}-${index}` which
-- is fragile across refetch/pagination reordering. Add audit_logs.id
-- so the frontend can use a real stable row key.

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
    select al.id, al.action, al.before, al.after, al.created_at, prof.full_name as actor_name
    from public.audit_logs al
    left join public.profiles prof on prof.user_id = al.actor_id
    where al.club_id = p_club_id and al.entity_type = 'customer' and al.entity_id = p_customer_id
    order by al.created_at desc
    limit p_limit offset p_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id, 'action', page.action, 'before', page.before, 'after', page.after,
    'created_at', page.created_at, 'actor_name', page.actor_name
  ) order by page.created_at desc), '[]'::jsonb) into v_rows
  from page;

  return jsonb_build_object('rows', v_rows, 'total_count', v_total);
end;
$function$;
