-- FINANCIAL INTEGRITY & RECONCILIATION ACCEPTANCE (Stage A, correction,
-- 2026-08-30): the prior migration in this same batch
-- (20260830113907) attempted `revoke select (secret_vault_id,
-- webhook_secret_vault_id) on club_gateway_connections from
-- authenticated` -- but `authenticated` ALSO holds a plain
-- TABLE-level `GRANT SELECT` on this table (confirmed via
-- information_schema.table_privileges), and Postgres privilege grants
-- are additive: a narrower column-level REVOKE cannot carve out an
-- exception from a broader table-level GRANT. Verified live
-- immediately after applying the prior migration: both columns still
-- showed up in information_schema.column_privileges for
-- `authenticated`, proving the revoke had no practical effect.
--
-- Real fix: revoke the table-level SELECT entirely, then re-grant
-- SELECT only on the columns that are safe for direct client reads.
-- Confirmed safe -- every function that reads this table
-- (list_club_gateway_connections, set_club_gateway_default,
-- disconnect_club_gateway, start_gateway_checkout,
-- connect_club_gateway, set_club_gateway_enabled,
-- get_platform_club_gateway_overview) is SECURITY DEFINER, so none of
-- them depend on the calling role's own table grant -- they read via
-- the function owner's privileges regardless of what `authenticated`
-- can see directly. RLS itself is untouched by this migration (same
-- payment.methods.view-gated SELECT policy as before) -- this only
-- narrows which COLUMNS of an already-RLS-visible row are readable.
revoke select on public.club_gateway_connections from authenticated;

grant select (
  id, club_id, provider_key, environment, public_key,
  provider_merchant_ref, enabled, is_default,
  last_verified_at, last_verification_error,
  last_webhook_at, last_webhook_error,
  last_success_at, last_failure_at,
  created_at, updated_at, updated_by
) on public.club_gateway_connections to authenticated;

-- secret_vault_id / webhook_secret_vault_id are deliberately EXCLUDED
-- from the grant above -- direct client reads of the raw Vault object
-- IDs are no longer possible; list_club_gateway_connections() remains
-- the only path, and it already redacts these to a boolean has_secret.
