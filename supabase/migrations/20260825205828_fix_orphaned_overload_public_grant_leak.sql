-- STAFF ACCESS CONTROL & CUSTOM ROLES -- CRITICAL security hotfix.
--
-- ROOT CAUSE: invite_staff_member and set_staff_role were widened with
-- an added trailing-default parameter (p_custom_role_id). Because
-- Postgres treats a different parameter COUNT as a genuinely different
-- function (new OID), this created a real orphaned-overload situation
-- (the exact class of bug this project's own history explicitly warns
-- about) -- AND, critically, the newly-created 5-arg/4-arg functions
-- never had explicit REVOKE/GRANT statements in the migration that
-- created them, so they inherited Postgres's default privilege
-- behavior for a newly created function: EXECUTE granted to PUBLIC
-- (which cascades to anon). Confirmed live: the new invite_staff_member
-- and set_staff_role overloads were anon-executable -- a real,
-- unauthenticated-callable security exposure, found and fixed same-day,
-- same-phase, before any known exploitation.
--
-- FIX: drop both old, now-truly-orphaned overloads (the original
-- pre-existing 4-arg/3-arg versions -- their bodies are now dead code,
-- fully superseded by the new versions' logic, and per this project's
-- own established pattern for this exact bug class, the correct fix is
-- DROP + re-create with explicit grants, not leaving two competing
-- overloads alive). Re-grant the surviving (already-correct-body)
-- versions explicitly to authenticated only, matching every other
-- staff RPC in this schema.

drop function if exists public.invite_staff_member(uuid, text, text, uuid[]);
drop function if exists public.set_staff_role(uuid, uuid, text);

revoke all on function public.invite_staff_member(uuid, text, text, uuid[], uuid) from public;
revoke all on function public.invite_staff_member(uuid, text, text, uuid[], uuid) from anon;
grant execute on function public.invite_staff_member(uuid, text, text, uuid[], uuid) to authenticated;

revoke all on function public.set_staff_role(uuid, uuid, text, uuid) from public;
revoke all on function public.set_staff_role(uuid, uuid, text, uuid) from anon;
grant execute on function public.set_staff_role(uuid, uuid, text, uuid) to authenticated;
