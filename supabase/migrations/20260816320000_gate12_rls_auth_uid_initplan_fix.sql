-- Gate 12 (Full Regression/Security/Tenant QA) -- fix auth_rls_initplan
-- performance advisor findings. See AUTONOMOUS_DECISION_LOG.md D-012.
--
-- 32 RLS policies called auth.uid() directly inside USING/WITH CHECK,
-- which Postgres re-evaluates once PER ROW instead of once per query.
-- Wrapping as (select auth.uid()) lets the planner treat it as a stable
-- sub-select evaluated once and reused -- a pure performance fix with
-- zero logic change (same function, same operands, only added a scalar
-- subquery wrapper Postgres itself recommends for this exact pattern).
--
-- Every statement below was generated directly from Postgres's own
-- pg_policies catalog (qual/with_check/permissive/cmd/roles), via a
-- regex substitution that only wraps auth.uid() -- it cannot alter
-- policy logic since operands and structure are otherwise untouched.
-- This guarantees exact preservation of existing authorization behavior;
-- verified post-apply via get_advisors(performance) showing zero
-- remaining auth_rls_initplan findings, and via re-running this
-- session's real black-box tenant-isolation checks.

drop policy age_groups_select on public.age_groups;
create policy age_groups_select on public.age_groups as PERMISSIVE for SELECT to public using (((club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND (EXISTS ( SELECT 1
   FROM (club_memberships cm
     JOIN roles r ON ((r.id = cm.role_id)))
  WHERE ((cm.user_id = (select auth.uid())) AND (cm.club_id = age_groups.club_id) AND (cm.status = 'active'::text) AND (r.key <> ALL (ARRAY['accountant'::text, 'scanner'::text, 'coach'::text])))))));

drop policy attendance_insert on public.attendance;
create policy attendance_insert on public.attendance as PERMISSIVE for INSERT to public with check (((club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND has_permission('attendance.mark'::text, club_id) AND (EXISTS ( SELECT 1
   FROM (training_sessions ts
     JOIN groups g ON ((g.id = ts.group_id)))
  WHERE ((ts.id = attendance.session_id) AND ((g.coach_id = (select auth.uid())) OR (g.assistant_coach_id = (select auth.uid()))))))));

drop policy attendance_select on public.attendance;
create policy attendance_select on public.attendance as PERMISSIVE for SELECT to public using (((club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND (has_permission('attendance.view'::text, club_id) OR (EXISTS ( SELECT 1
   FROM (training_sessions ts
     JOIN groups g ON ((g.id = ts.group_id)))
  WHERE ((ts.id = attendance.session_id) AND ((g.coach_id = (select auth.uid())) OR (g.assistant_coach_id = (select auth.uid())))))))));

drop policy attendance_update on public.attendance;
create policy attendance_update on public.attendance as PERMISSIVE for UPDATE to public using (((club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND has_permission('attendance.mark'::text, club_id) AND (EXISTS ( SELECT 1
   FROM (training_sessions ts
     JOIN groups g ON ((g.id = ts.group_id)))
  WHERE ((ts.id = attendance.session_id) AND ((g.coach_id = (select auth.uid())) OR (g.assistant_coach_id = (select auth.uid()))))))));

drop policy audit_logs_select_own_club on public.audit_logs;
create policy audit_logs_select_own_club on public.audit_logs as PERMISSIVE for SELECT to public using (((club_id IS NOT NULL) AND (club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND (EXISTS ( SELECT 1
   FROM (club_memberships cm
     JOIN roles r ON ((r.id = cm.role_id)))
  WHERE ((cm.user_id = (select auth.uid())) AND (cm.club_id = audit_logs.club_id) AND (cm.status = 'active'::text) AND ((r.key = ANY (ARRAY['club_owner'::text, 'club_manager'::text])) OR ((r.key = 'branch_manager'::text) AND (audit_logs.branch_id IS NOT NULL) AND has_branch_access(cm.id, audit_logs.branch_id))))))));

drop policy bookings_self_service_select on public.bookings;
create policy bookings_self_service_select on public.bookings as PERMISSIVE for SELECT to public using ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.user_id = (select auth.uid())))));

drop policy branches_self_service_select on public.branches;
create policy branches_self_service_select on public.branches as PERMISSIVE for SELECT to public using ((club_id IN ( SELECT c.club_id
   FROM customers c
  WHERE (c.user_id = (select auth.uid())))));

drop policy club_memberships_select_own on public.club_memberships;
create policy club_memberships_select_own on public.club_memberships as PERMISSIVE for SELECT to public using ((user_id = (select auth.uid())));

drop policy clubs_self_service_select on public.clubs;
create policy clubs_self_service_select on public.clubs as PERMISSIVE for SELECT to public using ((id IN ( SELECT c.club_id
   FROM customers c
  WHERE (c.user_id = (select auth.uid())))));

drop policy commercial_upgrade_requests_insert_own_club on public.commercial_upgrade_requests;
create policy commercial_upgrade_requests_insert_own_club on public.commercial_upgrade_requests as PERMISSIVE for INSERT to public with check (((club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND (requested_by = (select auth.uid()))));

drop policy photo_requests_self_service_insert on public.customer_photo_update_requests;
create policy photo_requests_self_service_insert on public.customer_photo_update_requests as PERMISSIVE for INSERT to public with check (((requested_by = (select auth.uid())) AND ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.user_id = (select auth.uid())))) OR (player_id IN ( SELECT p.id
   FROM ((players p
     JOIN guardian_links gl ON ((gl.player_id = p.id)))
     JOIN customers c ON ((c.id = gl.customer_id)))
  WHERE (c.user_id = (select auth.uid())))))));

drop policy photo_requests_self_service_select on public.customer_photo_update_requests;
create policy photo_requests_self_service_select on public.customer_photo_update_requests as PERMISSIVE for SELECT to public using ((requested_by = (select auth.uid())));

drop policy customers_self_service_select on public.customers;
create policy customers_self_service_select on public.customers as PERMISSIVE for SELECT to public using ((user_id = (select auth.uid())));

drop policy customers_self_service_update on public.customers;
create policy customers_self_service_update on public.customers as PERMISSIVE for UPDATE to public using ((user_id = (select auth.uid()))) with check ((user_id = (select auth.uid())));

drop policy enrollments_select on public.enrollments;
create policy enrollments_select on public.enrollments as PERMISSIVE for SELECT to public using (((club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND (has_permission('enrollment.view'::text, club_id) OR (EXISTS ( SELECT 1
   FROM groups g
  WHERE ((g.id = enrollments.group_id) AND ((g.coach_id = (select auth.uid())) OR (g.assistant_coach_id = (select auth.uid())))))))));

drop policy enrollments_self_service_select on public.enrollments;
create policy enrollments_self_service_select on public.enrollments as PERMISSIVE for SELECT to public using ((player_id IN ( SELECT gl.player_id
   FROM (guardian_links gl
     JOIN customers c ON ((c.id = gl.customer_id)))
  WHERE (c.user_id = (select auth.uid())))));

drop policy fields_self_service_select on public.fields;
create policy fields_self_service_select on public.fields as PERMISSIVE for SELECT to public using ((club_id IN ( SELECT c.club_id
   FROM customers c
  WHERE (c.user_id = (select auth.uid())))));

drop policy group_schedule_slots_select on public.group_schedule_slots;
create policy group_schedule_slots_select on public.group_schedule_slots as PERMISSIVE for SELECT to public using ((EXISTS ( SELECT 1
   FROM groups g
  WHERE ((g.id = group_schedule_slots.group_id) AND (g.club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND ((EXISTS ( SELECT 1
           FROM (club_memberships cm
             JOIN roles r ON ((r.id = cm.role_id)))
          WHERE ((cm.user_id = (select auth.uid())) AND (cm.club_id = g.club_id) AND (cm.status = 'active'::text) AND (r.key <> ALL (ARRAY['accountant'::text, 'scanner'::text, 'coach'::text]))))) OR (g.coach_id = (select auth.uid())) OR (g.assistant_coach_id = (select auth.uid())))))));

drop policy groups_select on public.groups;
create policy groups_select on public.groups as PERMISSIVE for SELECT to public using (((club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND ((EXISTS ( SELECT 1
   FROM (club_memberships cm
     JOIN roles r ON ((r.id = cm.role_id)))
  WHERE ((cm.user_id = (select auth.uid())) AND (cm.club_id = groups.club_id) AND (cm.status = 'active'::text) AND (r.key <> ALL (ARRAY['accountant'::text, 'scanner'::text, 'coach'::text]))))) OR (coach_id = (select auth.uid())) OR (assistant_coach_id = (select auth.uid())))));

drop policy guardian_links_self_service_select on public.guardian_links;
create policy guardian_links_self_service_select on public.guardian_links as PERMISSIVE for SELECT to public using ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.user_id = (select auth.uid())))));

drop policy notification_consent_self_service_select on public.notification_consent;
create policy notification_consent_self_service_select on public.notification_consent as PERMISSIVE for SELECT to public using ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.user_id = (select auth.uid())))));

drop policy notification_consent_self_service_update on public.notification_consent;
create policy notification_consent_self_service_update on public.notification_consent as PERMISSIVE for UPDATE to public using ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.user_id = (select auth.uid()))))) with check ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.user_id = (select auth.uid())))));

drop policy permissions_select_all_authenticated on public.permissions;
create policy permissions_select_all_authenticated on public.permissions as PERMISSIVE for SELECT to public using (((select auth.uid()) IS NOT NULL));

drop policy platform_settings_select_authenticated on public.platform_settings;
create policy platform_settings_select_authenticated on public.platform_settings as PERMISSIVE for SELECT to public using (((select auth.uid()) IS NOT NULL));

drop policy players_self_service_select on public.players;
create policy players_self_service_select on public.players as PERMISSIVE for SELECT to public using ((id IN ( SELECT gl.player_id
   FROM (guardian_links gl
     JOIN customers c ON ((c.id = gl.customer_id)))
  WHERE (c.user_id = (select auth.uid())))));

drop policy profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles as PERMISSIVE for SELECT to public using ((user_id = (select auth.uid())));

drop policy profiles_select_same_club_staff on public.profiles;
create policy profiles_select_same_club_staff on public.profiles as PERMISSIVE for SELECT to public using ((EXISTS ( SELECT 1
   FROM (club_memberships cm1
     JOIN club_memberships cm2 ON ((cm2.club_id = cm1.club_id)))
  WHERE ((cm1.user_id = (select auth.uid())) AND (cm1.status = 'active'::text) AND (cm2.user_id = profiles.user_id) AND (cm2.status = 'active'::text)))));

drop policy profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles as PERMISSIVE for UPDATE to public using ((user_id = (select auth.uid())));

drop policy programs_select on public.programs;
create policy programs_select on public.programs as PERMISSIVE for SELECT to public using (((club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND (EXISTS ( SELECT 1
   FROM (club_memberships cm
     JOIN roles r ON ((r.id = cm.role_id)))
  WHERE ((cm.user_id = (select auth.uid())) AND (cm.club_id = programs.club_id) AND (cm.status = 'active'::text) AND (r.key <> ALL (ARRAY['accountant'::text, 'scanner'::text, 'coach'::text])))))));

drop policy qr_scan_events_select on public.qr_scan_events;
create policy qr_scan_events_select on public.qr_scan_events as PERMISSIVE for SELECT to public using ((((club_id IS NOT NULL) AND (club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND (has_permission('booking.view'::text, club_id) OR (scanner_user_id = (select auth.uid())))) OR ((club_id IS NULL) AND (scanner_user_id = (select auth.uid()))) OR is_platform_owner()));

drop policy role_permissions_select_all_authenticated on public.role_permissions;
create policy role_permissions_select_all_authenticated on public.role_permissions as PERMISSIVE for SELECT to public using (((select auth.uid()) IS NOT NULL));

drop policy roles_select_all_authenticated on public.roles;
create policy roles_select_all_authenticated on public.roles as PERMISSIVE for SELECT to public using (((select auth.uid()) IS NOT NULL));

drop policy seasons_select on public.seasons;
create policy seasons_select on public.seasons as PERMISSIVE for SELECT to public using (((club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND (EXISTS ( SELECT 1
   FROM (club_memberships cm
     JOIN roles r ON ((r.id = cm.role_id)))
  WHERE ((cm.user_id = (select auth.uid())) AND (cm.club_id = seasons.club_id) AND (cm.status = 'active'::text) AND (r.key <> ALL (ARRAY['accountant'::text, 'scanner'::text, 'coach'::text])))))));

drop policy subscriptions_self_service_select on public.subscriptions;
create policy subscriptions_self_service_select on public.subscriptions as PERMISSIVE for SELECT to public using ((enrollment_id IN ( SELECT e.id
   FROM ((enrollments e
     JOIN guardian_links gl ON ((gl.player_id = e.player_id)))
     JOIN customers c ON ((c.id = gl.customer_id)))
  WHERE (c.user_id = (select auth.uid())))));

drop policy training_sessions_select on public.training_sessions;
create policy training_sessions_select on public.training_sessions as PERMISSIVE for SELECT to public using (((club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND (has_permission('session.view'::text, club_id) OR (EXISTS ( SELECT 1
   FROM groups g
  WHERE ((g.id = training_sessions.group_id) AND ((g.coach_id = (select auth.uid())) OR (g.assistant_coach_id = (select auth.uid())))))))));

drop policy training_sessions_update on public.training_sessions;
create policy training_sessions_update on public.training_sessions as PERMISSIVE for UPDATE to public using (((club_id IN ( SELECT user_club_ids() AS user_club_ids)) AND has_permission('session.manage'::text, club_id) AND (has_permission('attendance.view'::text, club_id) OR (EXISTS ( SELECT 1
   FROM groups g
  WHERE ((g.id = training_sessions.group_id) AND ((g.coach_id = (select auth.uid())) OR (g.assistant_coach_id = (select auth.uid())))))))));
