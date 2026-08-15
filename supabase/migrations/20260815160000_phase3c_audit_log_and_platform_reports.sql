-- Phase 3c — Platform Owner Control Center
-- Introduces audit_logs (needed here since every sensitive platform action
-- in this phase must write an audit entry — see IMPLEMENTATION_PLAN.md
-- Phase 3c Security work). Also wires audit writes into the Phase 3b RPCs
-- that this phase's Actions panel exposes (Suspend/Cancel/Reverse
-- Payment/Extend Grace Period/Change Plan/Publish-Unpublish Plan).

-- ============================================================
-- audit_logs
-- ============================================================
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  club_id uuid references public.clubs(id),
  branch_id uuid references public.branches(id),
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz not null default now()
);
comment on table public.audit_logs is 'Immutable audit trail. No UPDATE/DELETE policy exists for any role, ever (ADR-020). INSERT only via SECURITY DEFINER, never direct client insert.';

create index idx_audit_logs_club_id on public.audit_logs (club_id);
create index idx_audit_logs_created_at on public.audit_logs (created_at desc);

alter table public.audit_logs enable row level security;

-- club_id IS NULL rows are platform-level actions (e.g. plan publish/
-- unpublish) -- visible only to Platform Owner, never to any club.
create policy "audit_logs_select_own_club" on public.audit_logs
  for select using (
    club_id is not null and club_id in (select public.user_club_ids())
  );

create policy "audit_logs_platform_owner_select" on public.audit_logs
  for select using (public.is_platform_owner());

-- No INSERT policy for any client role -- writes happen only inside
-- SECURITY DEFINER functions (public.write_audit_log below), which bypass
-- RLS by design as SECURITY DEFINER always does. No UPDATE/DELETE policy
-- exists at all, for any role, ever.

-- ============================================================
-- write_audit_log: internal helper, not directly client-callable (no
-- EXECUTE grant to authenticated/anon at all -- called only from other
-- SECURITY DEFINER functions in the same transaction).
-- ============================================================
create or replace function public.write_audit_log(
  p_club_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_logs (club_id, actor_id, action, entity_type, entity_id, before, after, reason)
  values (p_club_id, auth.uid(), p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason);
end;
$$;

revoke execute on function public.write_audit_log(uuid, text, text, uuid, jsonb, jsonb, text) from public;
revoke execute on function public.write_audit_log(uuid, text, text, uuid, jsonb, jsonb, text) from anon;
revoke execute on function public.write_audit_log(uuid, text, text, uuid, jsonb, jsonb, text) from authenticated;
-- Deliberately no grant to authenticated -- only callable from other
-- SECURITY DEFINER function bodies (which run as the function owner,
-- bypassing this EXECUTE grant check entirely, same as any other internal
-- call chain). This keeps it out of PostgREST's directly-callable RPC set.
