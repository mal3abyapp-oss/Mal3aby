-- Lockdown EXECUTE grants on every new Club Membership function to match
-- the project's established convention (revoke PUBLIC default grant,
-- grant only to service_role/authenticated/postgres) -- mirrors
-- lockdown_trigger_function_grants / phase2_lockdown_function_execute_grants.
--
-- This migration was required because the platform's schema-creation
-- default (PostgREST/Supabase's own default EXECUTE grants) applies a
-- PUBLIC grant to every newly created function unless explicitly
-- revoked -- verified live and closed before any QA/live traffic ever
-- reached these functions.

revoke all on function public.protect_club_membership_status_transitions() from public;
revoke all on function public.protect_club_membership_subscription_snapshot() from public;
revoke all on function public.get_club_membership_effective_end_date(uuid) from public;
revoke all on function public.get_club_membership_effective_status(text, date, date, date) from public;
revoke all on function public._activate_club_membership_if_due_internal(uuid) from public;
revoke all on function public._next_club_membership_number_internal(uuid) from public;
revoke all on function public.sell_club_membership(uuid, uuid, uuid, uuid, date, numeric, uuid) from public;
revoke all on function public.renew_club_membership(uuid, uuid, date, numeric, uuid) from public;
revoke all on function public.freeze_club_membership(uuid, date, date, text) from public;
revoke all on function public.resume_club_membership(uuid, text) from public;
revoke all on function public.cancel_club_membership(uuid, text) from public;

grant execute on function public.get_club_membership_effective_end_date(uuid) to service_role, authenticated;
grant execute on function public.get_club_membership_effective_status(text, date, date, date) to service_role, authenticated;
grant execute on function public.sell_club_membership(uuid, uuid, uuid, uuid, date, numeric, uuid) to service_role, authenticated;
grant execute on function public.renew_club_membership(uuid, uuid, date, numeric, uuid) to service_role, authenticated;
grant execute on function public.freeze_club_membership(uuid, date, date, text) to service_role, authenticated;
grant execute on function public.resume_club_membership(uuid, text) to service_role, authenticated;
grant execute on function public.cancel_club_membership(uuid, text) to service_role, authenticated;

-- Internal-only helpers and trigger functions: service_role/postgres only,
-- never authenticated directly (mirrors _activate_subscription_if_due_internal's
-- own lockdown -- called only from within other SECURITY DEFINER functions).
grant execute on function public.protect_club_membership_status_transitions() to service_role;
grant execute on function public.protect_club_membership_subscription_snapshot() to service_role;
grant execute on function public._activate_club_membership_if_due_internal(uuid) to service_role;
grant execute on function public._next_club_membership_number_internal(uuid) to service_role;
