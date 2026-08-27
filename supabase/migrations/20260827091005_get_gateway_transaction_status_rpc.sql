-- MULTI-GATEWAY PAYMENTS (Phase 2, item 1/5): read-only, authenticated,
-- club-scoped RPC for the hosted-checkout REDIRECT LANDING page to poll.
-- Hard rule (governing directive): "redirect result is never
-- authoritative" -- the redirect page must have ZERO write path to
-- payments/payment_gateway_transactions. This RPC is SELECT-only by
-- construction (language sql, no writes possible) so that invariant is
-- structurally enforced, not just a convention someone could violate
-- later by editing the wrong function.
--
-- Returns status/failure_reason only (never the secret-adjacent columns
-- like connection_id, provider_session_ref raw payloads) -- the caller
-- must have invoice.view on the transaction's club, same permission
-- start_gateway_checkout() itself requires.
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
