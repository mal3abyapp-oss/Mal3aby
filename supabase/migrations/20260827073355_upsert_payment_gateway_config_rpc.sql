-- Temporary bridge RPC replacing PaymentGatewaysCard.tsx's direct
-- table .upsert() (broken by the direct-grant revoke in
-- revoke_direct_payment_gateway_table_grants -- that revoke was
-- correct per this project's RPC-only convention, but left the
-- existing UI's save action with no write path). This exact 2-gateway
-- shape will be superseded by the full multi-provider connection
-- model (Phase 2 of the payment gateway directive); kept minimal and
-- behaviorally identical to the RLS policy it replaces so the
-- existing Settings UI keeps working without a redesign mid-fix.
create or replace function public.upsert_payment_gateway_config(
  p_club_id uuid, p_gateway text, p_enabled boolean, p_public_key text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('payment.methods.manage', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_gateway not in ('stripe', 'paypal') then
    raise exception 'invalid gateway';
  end if;

  insert into public.payment_gateway_configs (club_id, gateway, enabled, public_key, has_server_credentials, updated_at, updated_by)
  values (p_club_id, p_gateway, p_enabled, p_public_key, false, now(), auth.uid())
  on conflict (club_id, gateway) do update
    set enabled = excluded.enabled, public_key = excluded.public_key, updated_at = now(), updated_by = auth.uid();
end;
$function$;

revoke all on function public.upsert_payment_gateway_config(uuid, text, boolean, text) from public, anon;
grant execute on function public.upsert_payment_gateway_config(uuid, text, boolean, text) to authenticated;
