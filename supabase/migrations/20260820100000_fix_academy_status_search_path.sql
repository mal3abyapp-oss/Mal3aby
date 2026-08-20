-- Advisor finding (function_search_path_mutable, WARN): this pure-SQL
-- helper had no explicit search_path, unlike every other function in the
-- schema. It doesn't touch any table so it was never exploitable, but fix
-- it anyway to stay consistent with the rest of the codebase and clear
-- the only "new-looking" advisor finding from today's migrations.
create or replace function public.get_academy_subscription_display_status(p_status text, p_end_date date)
returns text
language sql
immutable
set search_path = 'public', 'pg_temp'
as $function$
  select case
    when p_status in ('expired', 'cancelled', 'frozen') then p_status
    when p_end_date < current_date then 'expired'
    when p_end_date <= current_date + interval '7 days' then 'due'
    else p_status
  end
$function$;
