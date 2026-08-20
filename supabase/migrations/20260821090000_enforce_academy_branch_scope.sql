-- Extend branch assignment enforcement through the Academy graph:
-- groups -> sessions/enrollments -> subscriptions/attendance.
-- Guardian self-service policies remain intentionally independent.

drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups for select using (
  club_id in (select public.user_club_ids())
  and public.user_has_branch_access(club_id, branch_id)
  and (
    exists (
      select 1 from public.club_memberships cm join public.roles r on r.id = cm.role_id
      where cm.user_id = (select auth.uid()) and cm.club_id = groups.club_id
        and cm.status = 'active' and r.key <> all(array['accountant','scanner','coach'])
    )
    or coach_id = (select auth.uid()) or assistant_coach_id = (select auth.uid())
  )
);
drop policy if exists groups_insert on public.groups;
create policy groups_insert on public.groups for insert with check (
  club_id in (select public.user_club_ids()) and public.has_permission('academy.group.manage', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);
drop policy if exists groups_update on public.groups;
create policy groups_update on public.groups for update using (
  club_id in (select public.user_club_ids()) and public.has_permission('academy.group.manage', club_id)
  and public.user_has_branch_access(club_id, branch_id)
) with check (
  club_id in (select public.user_club_ids()) and public.has_permission('academy.group.manage', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);

drop policy if exists training_sessions_select on public.training_sessions;
create policy training_sessions_select on public.training_sessions for select using (
  club_id in (select public.user_club_ids())
  and exists (
    select 1 from public.groups g where g.id = training_sessions.group_id
      and public.user_has_branch_access(training_sessions.club_id, g.branch_id)
      and (public.has_permission('session.view', training_sessions.club_id)
        or g.coach_id = (select auth.uid()) or g.assistant_coach_id = (select auth.uid()))
  )
);
drop policy if exists training_sessions_update on public.training_sessions;
create policy training_sessions_update on public.training_sessions for update using (
  club_id in (select public.user_club_ids()) and public.has_permission('session.manage', club_id)
  and exists (select 1 from public.groups g where g.id = training_sessions.group_id
    and public.user_has_branch_access(training_sessions.club_id, g.branch_id)
    and (public.has_permission('attendance.view', training_sessions.club_id)
      or g.coach_id = (select auth.uid()) or g.assistant_coach_id = (select auth.uid())))
) with check (
  club_id in (select public.user_club_ids()) and public.has_permission('session.manage', club_id)
  and exists (select 1 from public.groups g where g.id = training_sessions.group_id
    and public.user_has_branch_access(training_sessions.club_id, g.branch_id))
);

drop policy if exists enrollments_select on public.enrollments;
create policy enrollments_select on public.enrollments for select using (
  club_id in (select public.user_club_ids())
  and exists (select 1 from public.groups g where g.id = enrollments.group_id
    and public.user_has_branch_access(enrollments.club_id, g.branch_id)
    and (public.has_permission('enrollment.view', enrollments.club_id)
      or g.coach_id = (select auth.uid()) or g.assistant_coach_id = (select auth.uid())))
);
drop policy if exists enrollments_insert on public.enrollments;
create policy enrollments_insert on public.enrollments for insert with check (
  club_id in (select public.user_club_ids()) and public.has_permission('enrollment.create', club_id)
  and exists (select 1 from public.groups g where g.id = enrollments.group_id
    and public.user_has_branch_access(enrollments.club_id, g.branch_id))
);
drop policy if exists enrollments_update on public.enrollments;
create policy enrollments_update on public.enrollments for update using (
  club_id in (select public.user_club_ids()) and public.has_permission('enrollment.update', club_id)
  and exists (select 1 from public.groups g where g.id = enrollments.group_id
    and public.user_has_branch_access(enrollments.club_id, g.branch_id))
) with check (
  club_id in (select public.user_club_ids()) and public.has_permission('enrollment.update', club_id)
  and exists (select 1 from public.groups g where g.id = enrollments.group_id
    and public.user_has_branch_access(enrollments.club_id, g.branch_id))
);

drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions for select using (
  club_id in (select public.user_club_ids()) and public.has_permission('subscription.view', club_id)
  and exists (select 1 from public.enrollments e join public.groups g on g.id = e.group_id
    where e.id = subscriptions.enrollment_id
      and public.user_has_branch_access(subscriptions.club_id, g.branch_id))
);
drop policy if exists subscriptions_update on public.subscriptions;
create policy subscriptions_update on public.subscriptions for update using (
  club_id in (select public.user_club_ids()) and public.has_permission('subscription.update', club_id)
  and exists (select 1 from public.enrollments e join public.groups g on g.id = e.group_id
    where e.id = subscriptions.enrollment_id
      and public.user_has_branch_access(subscriptions.club_id, g.branch_id))
) with check (
  club_id in (select public.user_club_ids()) and public.has_permission('subscription.update', club_id)
  and exists (select 1 from public.enrollments e join public.groups g on g.id = e.group_id
    where e.id = subscriptions.enrollment_id
      and public.user_has_branch_access(subscriptions.club_id, g.branch_id))
);

drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance for select using (
  club_id in (select public.user_club_ids())
  and exists (select 1 from public.training_sessions ts join public.groups g on g.id = ts.group_id
    where ts.id = attendance.session_id
      and public.user_has_branch_access(attendance.club_id, g.branch_id)
      and (public.has_permission('attendance.view', attendance.club_id)
        or g.coach_id = (select auth.uid()) or g.assistant_coach_id = (select auth.uid())))
);
drop policy if exists attendance_insert on public.attendance;
create policy attendance_insert on public.attendance for insert with check (
  club_id in (select public.user_club_ids()) and public.has_permission('attendance.mark', club_id)
  and exists (select 1 from public.training_sessions ts join public.groups g on g.id = ts.group_id
    where ts.id = attendance.session_id
      and public.user_has_branch_access(attendance.club_id, g.branch_id)
      and (g.coach_id = (select auth.uid()) or g.assistant_coach_id = (select auth.uid())
        or public.has_permission('attendance.view', attendance.club_id)))
);
drop policy if exists attendance_update on public.attendance;
create policy attendance_update on public.attendance for update using (
  club_id in (select public.user_club_ids()) and public.has_permission('attendance.mark', club_id)
  and exists (select 1 from public.training_sessions ts join public.groups g on g.id = ts.group_id
    where ts.id = attendance.session_id
      and public.user_has_branch_access(attendance.club_id, g.branch_id)
      and (g.coach_id = (select auth.uid()) or g.assistant_coach_id = (select auth.uid())
        or public.has_permission('attendance.view', attendance.club_id)))
) with check (
  club_id in (select public.user_club_ids()) and public.has_permission('attendance.mark', club_id)
  and exists (select 1 from public.training_sessions ts join public.groups g on g.id = ts.group_id
    where ts.id = attendance.session_id
      and public.user_has_branch_access(attendance.club_id, g.branch_id))
);
