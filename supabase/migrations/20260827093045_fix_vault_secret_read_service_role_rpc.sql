-- CRITICAL BUG FOUND VIA LIVE VERIFICATION (item 7 duplicate-webhook
-- test): PostgREST does not expose the `vault` schema by default in
-- this project (confirmed live: admin.schema('vault').from(...) from
-- inside a deployed Edge Function returns "Invalid schema: vault" --
-- NOT an RLS/permission denial, a genuine "this schema is not queryable
-- via the REST API at all" rejection). This means EVERY Edge Function
-- using the `.schema('vault').from('decrypted_secrets')` pattern
-- (stripe-gateway-webhook's HMAC secret lookup, stripe-create-checkout-session's
-- and stripe-create-refund's Stripe API secret key lookup) was
-- SILENTLY FAILING to ever read a real secret -- every webhook
-- signature verification attempt was failing not because of a bad
-- HMAC computation (independently confirmed correct via a scratch
-- test) but because the secret read itself never succeeded, in EVERY
-- one of these three functions. This was inherited from the
-- prior session's stripe-gateway-webhook (already deployed before
-- this session) and was never actually exercised end-to-end until
-- this session's live item-7 test -- the prior session's
-- PAYMENT_GATEWAY_WEBHOOK_MODEL.md claim that this pattern was
-- "confirmed live this session" evidently tested the REJECTION paths
-- (missing header, malformed timestamp) which never reach the vault
-- read, not a genuine successful verification.
--
-- FIX: a SECURITY DEFINER RPC, service_role-only, that reads
-- vault.decrypted_secrets via plain SQL (which has full access to the
-- vault schema regardless of PostgREST schema exposure -- this is a
-- database-side function call, not a PostgREST REST request) and
-- returns just the decrypted value. This replaces every
-- `.schema('vault').from('decrypted_secrets')` call across all three
-- gateway Edge Functions with `admin.rpc('get_vault_secret_service', ...)`.
create or replace function public.get_vault_secret_service(p_secret_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public', 'vault', 'pg_temp'
as $function$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$function$;

revoke all on function public.get_vault_secret_service(uuid) from public, anon, authenticated;
grant execute on function public.get_vault_secret_service(uuid) to service_role;
