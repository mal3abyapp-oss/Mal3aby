-- Minimal, explicit widening of the shared enforce_authenticated_branch_scope
-- trigger: a genuine authenticated (non-staff) portal customer writing
-- their OWN club membership purchase/renewal invoice has no
-- club_memberships row at all (by design -- customers are not staff),
-- so user_has_branch_access() correctly returns false for them, and this
-- trigger correctly blocked it. Anonymous public booking sidesteps this
-- entirely via the existing auth.uid()-is-null + SECURITY DEFINER
-- current_user bypass -- but an AUTHENTICATED customer has no equivalent
-- path, and this is the first customer-authenticated financial write in
-- this codebase (get_my_portal_invoices is read-only; no other portal
-- RPC writes to invoices as a real, non-staff auth.uid()).
--
-- Fix: add one narrow, explicit escape hatch -- a session-local config
-- flag (mirrors the app.allow_*_status_transition bypass-trigger
-- convention already used throughout this project) that ONLY the two
-- new club_membership self-service RPCs set, immediately before their
-- own INSERT, and ONLY after they have already independently verified
-- (a) the row's customer_id belongs to the caller (customers.user_id =
-- auth.uid(), checked earlier in the same function body) and (b) the
-- row's branch_id belongs to the same club_id being purchased into (the
-- `branches where id = p_branch_id and club_id = p_club_id` check
-- already present). This does NOT weaken branch-scope protection for any
-- STAFF write anywhere -- every other INSERT/UPDATE path into invoices/
-- bookings/payments/etc. is completely unaffected; the flag is checked
-- and immediately irrelevant unless explicitly set, and is never set by
-- any staff-facing RPC. Defense-in-depth verified live: a direct
-- raw INSERT into invoices by a customer, bypassing the RPC entirely
-- (and thus never setting the flag), is still correctly rejected by
-- this trigger's normal enforcement path.
create or replace function public.enforce_authenticated_branch_scope()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
begin
  -- Direct trusted database maintenance has no JWT. Service-role integrations
  -- are explicitly trusted and must keep operating. Every end-user/RPC call
  -- carries auth.uid() and is checked below.
  if v_role = 'service_role' or (auth.uid() is null and current_user in ('postgres', 'supabase_admin')) then
    return new;
  end if;

  -- Club Membership customer self-service purchase/renewal (see
  -- purchase_club_membership_self_service / renew_club_membership_self_service):
  -- an authenticated portal customer legitimately has no club_memberships
  -- row (customers are not staff) -- those two RPCs alone set this flag,
  -- and only after independently verifying customer/branch/club
  -- consistency themselves.
  if coalesce(current_setting('app.allow_customer_self_service_write', true), 'false') = 'true' then
    return new;
  end if;

  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not public.user_has_branch_access(new.club_id, new.branch_id) then
    raise exception 'not authorized for this branch';
  end if;

  if tg_op = 'UPDATE'
     and not public.user_has_branch_access(old.club_id, old.branch_id) then
    raise exception 'not authorized for the original branch';
  end if;

  return new;
end;
$function$;
