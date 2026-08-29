-- PLATFORM OWNER MODULE ACTIVATION CONTROL -- finite corrective phase
-- (2026-08-29).
--
-- Accepted authority model (unchanged in shape, corrected in scope):
--   1. MODULE ENTITLEMENT       -- Platform Owner only (unchanged --
--      set_club_module_entitlement already gates on is_platform_owner()
--      OR platform.club.manage).
--   2. MODULE OPERATIONAL ACTIVATION -- previously Club Owner (or an
--      active MANAGE support session) ONLY. Platform Owner had no
--      direct path to flip `active` -- restoring a module they had just
--      re-entitled required either a Club Owner login or a support
--      session, which the current directive explicitly rules out as
--      "no longer the intended product behavior".
--   3. STAFF / ROLE PERMISSIONS inside modules -- Club Owner only,
--      completely untouched by this migration.
--
-- Fix: widen set_club_module_active()'s authorization to ALSO accept
-- is_platform_owner() / has_platform_permission('platform.club.manage')
-- -- the exact same permission set_club_module_entitlement() already
-- uses, so Platform Owner's entitlement and activation authority are
-- symmetric. The Club Owner / support-session path is completely
-- unchanged -- this is purely additive authority, not a replacement.
--
-- No RLS weakening: still SECURITY DEFINER with an explicit
-- authorization check at the top (fail-closed 'not authorized'), still
-- `set search_path to 'public', 'pg_temp'`, still routes through
-- write_audit_log() for a real audit trail, still tenant-scoped via
-- p_club_id. Adds an optional p_reason (default null) to match the
-- existing high-impact-action reason pattern used by
-- set_club_payments_enabled/set_club_gateway_provider_policy -- the
-- base write_audit_log() call (unchanged shape) now records it. actor_id
-- is always auth.uid() there regardless of caller type, so "who did
-- this" is already answerable from the existing Audit Log actor column
-- without a new attribution wrapper; the existing
-- write_audit_log_as_support() call (unchanged, only now also passed
-- p_reason) remains the one place a support-session action gets its
-- extra "acting as platform admin" marker -- a genuine Platform Owner
-- call (not via a support session) does not go through that wrapper,
-- matching write_audit_log_as_support()'s own documented invariant that
-- it requires a real active support session for the exact club.
--
-- Return-shape note: RETURNS void is unchanged, and adding one optional
-- trailing parameter is a documented-safe CREATE OR REPLACE case -- but
-- Postgres treats a new parameter LIST as a distinct function identity
-- (overload), not a true replace: the old 3-arg
-- set_club_module_active(uuid, text, boolean) was left behind as a
-- second, still-callable function with its OLD (narrower) authorization
-- logic. Not a security regression on its own (it still enforces the
-- original Club-Owner/support-session-only check, just without the new
-- Platform Owner authority) -- but it is dead/duplicate surface that
-- could confuse a future caller or PostgREST's function resolution, so
-- it is explicitly dropped below once the 4-arg version is live.

create or replace function public.set_club_module_active(
  p_club_id uuid, p_module_key text, p_active boolean, p_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.club_modules;
  v_via_support boolean;
  v_via_platform_owner boolean;
begin
  v_via_platform_owner := public.is_platform_owner() or public.has_platform_permission('platform.club.manage');
  v_via_support := not public.has_permission('club.update', p_club_id) and public.has_platform_support_access(p_club_id, true);
  if not (public.has_permission('club.update', p_club_id) or v_via_support or v_via_platform_owner) then
    raise exception 'not authorized';
  end if;
  if p_module_key not in ('fields', 'academy', 'shop', 'club_membership') then
    raise exception 'unknown module';
  end if;

  select * into v_before from public.club_modules where club_id = p_club_id and module_key = p_module_key;
  if v_before.id is null then
    raise exception 'module row not found for this club';
  end if;
  if p_active and not v_before.entitled then
    raise exception 'this module is not available on your current plan -- contact support to enable it';
  end if;

  update public.club_modules
  set active = p_active, updated_at = now(), updated_by = auth.uid()
  where club_id = p_club_id and module_key = p_module_key;

  perform public.write_audit_log(
    p_club_id,
    case when p_active then 'module.activated' else 'module.deactivated' end,
    'club_module', v_before.id,
    jsonb_build_object('active', v_before.active),
    jsonb_build_object('active', p_active),
    p_reason
  );

  if v_via_support then
    perform public.write_audit_log_as_support(
      p_club_id,
      case when p_active then 'module.activated' else 'module.deactivated' end,
      'club_module', v_before.id,
      jsonb_build_object('active', v_before.active),
      jsonb_build_object('active', p_active),
      p_reason
    );
  end if;
end;
$$;

revoke all on function public.set_club_module_active(uuid, text, boolean, text) from public;
revoke all on function public.set_club_module_active(uuid, text, boolean, text) from anon;
grant execute on function public.set_club_module_active(uuid, text, boolean, text) to authenticated;

-- Drop the now-superseded 3-arg overload -- see the return-shape note
-- above. Only ever called from the RPC layer (no direct table grants
-- bypass this), so removing it cannot orphan any other object.
drop function if exists public.set_club_module_active(uuid, text, boolean);
