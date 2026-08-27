-- MULTI-GATEWAY PAYMENTS (Phase 2, Section 37/45): extends the
-- EXISTING start_gateway_checkout() RPC (kept, not replaced) to work
-- against the new club_gateway_connections model instead of the old
-- single-config payment_gateway_configs table. Section 37's flow:
-- "Invoice/outstanding exists -> server derives amount -> provider
-- selected -> gateway attempt created -> hosted checkout created" --
-- THIS function is exactly "gateway attempt created", the DB-side
-- staging step. The actual hosted-checkout-session creation (the real
-- provider API call, requiring the secret key) happens in a follow-up
-- Edge Function call that reads this staged row -- this function
-- itself never makes an outbound HTTP call and never reads the vault
-- secret (SET search_path deliberately does NOT include 'vault').
--
-- p_provider_key replaces the old p_gateway naming to match the new
-- multi-provider vocabulary; p_connection_id lets a club with
-- multiple connections for the same provider (e.g. both sandbox and
-- live, mid-testing) pick explicitly rather than relying on "the one
-- enabled connection" being unambiguous. p_idempotency_key follows
-- this project's own established pattern -- a retried call with the
-- same key returns the existing staged transaction instead of
-- creating a duplicate (Section 43 -- partial/multi payment already
-- works via the EXISTING record_payment()/payment_allocations engine,
-- unchanged; this only concerns the online-gateway ATTEMPT itself).
create or replace function public.start_gateway_checkout(
  p_invoice_id uuid, p_provider_key text, p_amount numeric,
  p_connection_id uuid default null, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_status text;
  v_outstanding numeric;
  v_connection public.club_gateway_connections;
  v_id uuid;
  v_existing_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not exists (select 1 from public.payment_gateway_providers where key = p_provider_key and status = 'active') then
    raise exception 'invalid gateway';
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  select club_id, status into v_club_id, v_status from public.invoices where id = p_invoice_id;
  if v_club_id is null then
    raise exception 'invoice not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('invoice.view', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if v_status <> 'issued' then
    raise exception 'can only start a checkout for an issued invoice';
  end if;

  if p_idempotency_key is not null then
    select id into v_existing_id from public.payment_gateway_transactions
    where club_id = v_club_id and idempotency_key = p_idempotency_key;
    if v_existing_id is not null then
      return v_existing_id;
    end if;
  end if;

  -- Resolve the connection: an explicit connection_id (must belong to
  -- this club+provider), or fall back to that provider's own enabled
  -- connection for this club. Section 45: "if unavailable, do not
  -- silently charge through another provider" -- there is no fallback
  -- to a DIFFERENT provider here, only ambiguity resolution within the
  -- SAME provider the caller explicitly chose.
  if p_connection_id is not null then
    select * into v_connection from public.club_gateway_connections
    where id = p_connection_id and club_id = v_club_id and provider_key = p_provider_key;
    if v_connection.id is null then
      raise exception 'connection not found for this club/provider';
    end if;
  else
    select * into v_connection from public.club_gateway_connections
    where club_id = v_club_id and provider_key = p_provider_key and enabled = true
    order by is_default desc, environment = 'live' desc
    limit 1;
    if v_connection.id is null then
      raise exception '% is not enabled for this club', p_provider_key;
    end if;
  end if;

  if not v_connection.enabled then
    raise exception '% is not enabled for this club', p_provider_key;
  end if;
  if v_connection.secret_vault_id is null then
    raise exception '% has no credentials configured for this club', p_provider_key;
  end if;

  select outstanding into v_outstanding from public.get_invoice_payment_summary(array[p_invoice_id]::uuid[]);
  if p_amount > v_outstanding then
    raise exception 'checkout amount (%) exceeds the invoice''s outstanding balance (%)', p_amount, v_outstanding;
  end if;

  insert into public.payment_gateway_transactions (
    club_id, invoice_id, gateway, amount, status, connection_id, environment, idempotency_key
  ) values (
    v_club_id, p_invoice_id, p_provider_key, p_amount, 'pending', v_connection.id, v_connection.environment, p_idempotency_key
  )
  returning id into v_id;

  return v_id;
end;
$function$;
