-- LAUNCH READINESS AUDIT finding: payment_gateway_configs and
-- payment_gateway_transactions both carried default INSERT/UPDATE/
-- DELETE/SELECT grants to anon AND authenticated at the table level.
-- RLS is enabled+forced on both, and the existing policies correctly
-- scope reads/writes (payment_gateway_configs_write_with_permission
-- requires club_id in user_club_ids() + has_permission('payment.methods.manage')
-- + has_server_credentials=false; payment_gateway_transactions has NO
-- write policy at all, so writes are currently denied by Postgres's
-- own FORCE RLS default -- but that safety is incidental (a future
-- policy addition for an unrelated purpose could silently reopen it)
-- rather than an explicit, intentional lockdown. This revokes the
-- direct grants entirely, matching this project's own established
-- convention everywhere else: no client-writable table grants, every
-- write goes through a SECURITY DEFINER RPC
-- (start_gateway_checkout() already does this correctly for inserts;
-- future gateway RPCs will do the same for status updates).
revoke all on public.payment_gateway_configs from public, anon, authenticated;
revoke all on public.payment_gateway_transactions from public, anon, authenticated;

-- Re-grant only the SELECT the existing RLS policies were designed
-- to allow (read own club's config/transactions) -- writes now go
-- through RPCs exclusively.
grant select on public.payment_gateway_configs to authenticated;
grant select on public.payment_gateway_transactions to authenticated;
