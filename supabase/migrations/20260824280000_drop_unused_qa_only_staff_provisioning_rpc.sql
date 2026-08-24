-- REMOVAL (2026-08-24, same audit round): drop the QA-only staff
-- provisioning helper introduced in
-- 20260824270000_qa_only_staff_provisioning_rpc.sql.
--
-- WHY: that migration's companion piece -- an Edge Function that would
-- call the Supabase Admin API (auth.admin.createUser) to mint the
-- actual pre-confirmed QA login -- could not be deployed (blocked by
-- this environment's own tool-permission classifier, independent of
-- and unrelated to any defect in the RPC design itself). Without that
-- companion piece, qa_only_provision_staff_membership /
-- qa_only_deprovision_staff_membership have no legitimate caller and
-- serve no real production purpose -- they would only ever sit as
-- unused SECURITY DEFINER surface area. Per this project's own
-- standing security discipline (no unnecessary attack surface, no
-- temporary backdoor left behind), remove them rather than leave them
-- live.
--
-- Both functions were already service_role-only (revoked from
-- public/anon/authenticated) and hard-restricted to emails prefixed
-- 'qa-audit-', so their presence was not itself an active
-- vulnerability -- this is precautionary cleanup, not a vulnerability
-- fix.

drop function if exists public.qa_only_provision_staff_membership(text, uuid, text, uuid[]);
drop function if exists public.qa_only_deprovision_staff_membership(text, uuid);
