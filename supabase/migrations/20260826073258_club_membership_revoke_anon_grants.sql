-- Explicit anon revocation -- PostgREST/Supabase grants EXECUTE to anon
-- by default at function-creation time (separate from the PUBLIC
-- pseudo-role revoke already done in club_membership_lockdown_grants),
-- matching the established lockdown_trigger_function_grants convention
-- exactly. Verified live afterward: public=false, anon=false,
-- authenticated=true, service_role=true, exactly 1 overload, for every
-- new Club Membership function.

revoke all on function public.protect_club_membership_status_transitions() from anon;
revoke all on function public.protect_club_membership_subscription_snapshot() from anon;
revoke all on function public.get_club_membership_effective_end_date(uuid) from anon;
revoke all on function public.get_club_membership_effective_status(text, date, date, date) from anon;
revoke all on function public._activate_club_membership_if_due_internal(uuid) from anon;
revoke all on function public._next_club_membership_number_internal(uuid) from anon;
revoke all on function public.sell_club_membership(uuid, uuid, uuid, uuid, date, numeric, uuid) from anon;
revoke all on function public.renew_club_membership(uuid, uuid, date, numeric, uuid) from anon;
revoke all on function public.freeze_club_membership(uuid, date, date, text) from anon;
revoke all on function public.resume_club_membership(uuid, text) from anon;
revoke all on function public.cancel_club_membership(uuid, text) from anon;
