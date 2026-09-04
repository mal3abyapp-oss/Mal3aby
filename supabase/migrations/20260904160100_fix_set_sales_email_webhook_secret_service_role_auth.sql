-- Follow-up to 20260904160000_sales_outreach_response_events.sql --
-- SAME defect class already documented and fixed twice in this module
-- (20260904130300_fix_sales_upsert_discovered_lead_service_role_auth.sql,
-- 20260904140100_fix_sales_service_role_auth_current_user_bug_class.sql):
-- a function granted EXECUTE to service_role ONLY (not authenticated)
-- must still explicitly bypass the is_platform_owner()/
-- has_platform_permission() check for that caller, because those two
-- helpers both resolve against auth.uid(), which is NULL for a
-- service_role caller regardless of role membership -- "granted to
-- service_role" alone does not make the body's own authorization check
-- pass.
--
-- Found immediately (before this function was ever used against real
-- data) while wiring the actual Resend webhook signing secret into
-- sales_email_webhook_config via `set role service_role; select
-- set_sales_email_webhook_secret(...)` -- reproduced directly: "ERROR:
-- P0001: not authorized". No secret was lost or exposed; the vault
-- entry (holding the real whsec_... value) was already created
-- successfully and is reused as-is once this fix lands -- only the
-- config-row UPDATE step failed.
--
-- Fix: add the same `auth.uid() is null` discriminator already proven
-- correct elsewhere in this module. Safe here for the identical reason
-- documented in the prior two fixes: this function's grants (revoke all
-- from public/anon/authenticated, grant execute to service_role only)
-- mean auth.uid() is null can ONLY be true for the trusted service_role
-- caller reaching this point -- no anon/authenticated session can ever
-- invoke this function at all, let alone with a null auth.uid().
create or replace function public.set_sales_email_webhook_secret(p_webhook_id text, p_secret_vault_id uuid, p_enabled boolean default true)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (
    auth.uid() is null  -- service_role caller: the only grantee of this function, see grants below
    or public.is_platform_owner()
    or public.has_platform_permission('platform.sales.manage_settings')
  ) then
    raise exception 'not authorized';
  end if;

  update public.sales_email_webhook_config
  set webhook_id = p_webhook_id, secret_vault_id = p_secret_vault_id, enabled = p_enabled, updated_at = now(), updated_by = auth.uid()
  where id = true;

  perform public.write_audit_log(null, 'sales.email_webhook.configure', 'sales_email_webhook_config', null, null,
    jsonb_build_object('webhook_id', p_webhook_id, 'enabled', p_enabled), 'Sales Intelligence inbound email webhook configured');
end;
$$;
-- Grants unchanged (already correct -- only the in-body logic was broken, matching the exact shape of the two prior fixes in this module).
