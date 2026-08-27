-- BUG FOUND VIA LIVE VERIFICATION: get_gateway_transaction_status's
-- RETURNS TABLE declares an output column named `id`, which collided
-- with the plain `id` column reference inside the function body's
-- first lookup query ("column reference \"id\" is ambiguous" --
-- PL/pgSQL prefers the OUT parameter over the table column). Fixed by
-- table-qualifying every column reference in that lookup, matching the
-- discipline already used in the function's second query (`return
-- query select t.id, ...`). Live-tested after this fix: the positive
-- (club-manager) case now returns the expected row instead of erroring.
create or replace function public.get_gateway_transaction_status(p_transaction_id uuid)
returns table (
  id uuid,
  status text,
  failure_reason text,
  amount numeric,
  currency text,
  invoice_id uuid,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select t.club_id into v_club_id from public.payment_gateway_transactions t where t.id = p_transaction_id;

  if v_club_id is null then
    raise exception 'gateway transaction not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('invoice.view', v_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
  select t.id, t.status, t.failure_reason, t.amount, t.currency, t.invoice_id, t.updated_at
  from public.payment_gateway_transactions t
  where t.id = p_transaction_id;
end;
$function$;

revoke all on function public.get_gateway_transaction_status(uuid) from public, anon;
grant execute on function public.get_gateway_transaction_status(uuid) to authenticated;
