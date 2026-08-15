-- Fix: audit_logs SELECT was over-broad -- the live "audit_logs_select_
-- own_club" policy granted read access to any club member (any role),
-- but RLS_MATRIX.md's audit_logs row specifies club_owner/club_manager
-- get S (own club), branch_manager gets S (own branch) only, and
-- receptionist/accountant/academy_manager/coach/scanner get no access at
-- all (`-`). Discovered during Phase 14's independent RLS re-audit.
--
-- Replaces the single blanket policy with one that: (a) restricts to
-- club_owner/club_manager/branch_manager roles only, and (b) further
-- restricts branch_manager to rows matching their own branch_id (rows
-- with a null branch_id -- e.g. platform-onboarding-level actions -- are
-- correctly invisible to branch_manager, who only ever needs branch-scoped
-- operational history).

drop policy if exists "audit_logs_select_own_club" on public.audit_logs;

create policy "audit_logs_select_own_club" on public.audit_logs for select
  using (
    club_id is not null
    and club_id in (select public.user_club_ids())
    and exists (
      select 1 from public.club_memberships cm
      join public.roles r on r.id = cm.role_id
      where cm.user_id = auth.uid() and cm.club_id = audit_logs.club_id and cm.status = 'active'
        and (
          r.key in ('club_owner', 'club_manager')
          or (
            r.key = 'branch_manager'
            and audit_logs.branch_id is not null
            and public.has_branch_access(cm.id, audit_logs.branch_id)
          )
        )
    )
  );
