-- PRE-LAUNCH HARDENING (2026-08-29) -- closing the last two real
-- findings from a full security-advisor sweep before real usage. The
-- other 333 advisor warnings (330 "security_definer_function_executable"
-- + 3 "rls_enabled_no_policy") are confirmed intentional, established
-- architecture, not bugs: every RPC in this codebase is deliberately
-- SECURITY DEFINER (the whole authorization model), and the 3 flagged
-- tables (club_membership_number_sequences, club_membership_sale_keys,
-- whatsapp_accounts) all have FORCE ROW LEVEL SECURITY set with zero
-- policies -- correct default-deny for internal tables reachable only
-- through SECURITY DEFINER RPCs, not an oversight. Verified live via
-- pg_class.relforcerowsecurity before writing this migration.

-- whatsapp_delivery_confirmation_overdue() had no SET search_path,
-- matching the established convention used by every other function in
-- this codebase (see e.g. _compute_audit_log_row_hash, has_permission,
-- etc. -- all explicitly pin search_path). This function only takes
-- scalar params and touches no tables, so the real exploitability here
-- is low, but there is no reason to leave it as the one function that
-- doesn't follow the project's own established pattern.
create or replace function public.whatsapp_delivery_confirmation_overdue(p_status text, p_provider_accepted_at timestamp with time zone, p_delivered_at timestamp with time zone)
 returns boolean
 language sql
 stable
 set search_path to 'public', 'pg_temp'
as $function$
  select p_status = 'sent'
     and p_provider_accepted_at is not null
     and p_delivered_at is null
     and now() - p_provider_accepted_at > interval '5 minutes'
$function$;
