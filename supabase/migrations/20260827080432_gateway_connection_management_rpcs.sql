-- MULTI-GATEWAY PAYMENTS (Phase 2, Section 29/52): Club Owner UI RPCs.
-- All gated on payment.methods.manage (existing permission, reused --
-- Section 52: "at minimum capabilities equivalent to gateway
-- manage"). Secrets are written ONLY via vault.create_secret()/
-- update_secret() -- this RPC never returns a stored secret back to
-- the client (Section 34: "UI after save: Configured, or masked
-- suffix only. Never retrieve/display saved secret").
create or replace function public.list_club_gateway_connections(p_club_id uuid)
returns table (
  id uuid, provider_key text, provider_display_name text, environment text,
  public_key text, has_secret boolean, provider_merchant_ref text,
  enabled boolean, is_default boolean,
  last_verified_at timestamptz, last_verification_error text,
  last_webhook_at timestamptz, last_webhook_error text,
  last_success_at timestamptz, last_failure_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (
    (p_club_id in (select public.user_club_ids()) and public.has_permission('payment.methods.view', p_club_id))
    or public.has_platform_support_access(p_club_id, false)
  ) then
    raise exception 'not authorized';
  end if;

  return query
  select c.id, c.provider_key, p.display_name, c.environment,
    c.public_key, (c.secret_vault_id is not null), c.provider_merchant_ref,
    c.enabled, c.is_default,
    c.last_verified_at, c.last_verification_error,
    c.last_webhook_at, c.last_webhook_error,
    c.last_success_at, c.last_failure_at,
    c.updated_at
  from public.club_gateway_connections c
  join public.payment_gateway_providers p on p.key = c.provider_key
  where c.club_id = p_club_id
  order by p.display_name, c.environment;
end;
$function$;

revoke all on function public.list_club_gateway_connections(uuid) from public, anon;
grant execute on function public.list_club_gateway_connections(uuid) to authenticated;

create or replace function public.list_payment_gateway_providers()
returns table (
  key text, display_name text, supported_countries text[], supported_currencies text[],
  supports_sandbox boolean, supports_live boolean, supports_partial_refund boolean,
  supports_native_idempotency_key boolean
)
language sql
stable security invoker
set search_path to 'public', 'pg_temp'
as $function$
  select key, display_name, supported_countries, supported_currencies,
    supports_sandbox, supports_live, supports_partial_refund, supports_native_idempotency_key
  from public.payment_gateway_providers where status = 'active' order by display_name;
$function$;

revoke all on function public.list_payment_gateway_providers() from public, anon;
grant execute on function public.list_payment_gateway_providers() to authenticated;
