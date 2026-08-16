-- V1 Implementation Gap Audit (2026-08-16): P1 SECURITY GAP found and
-- fixed while regression-testing the new Club Settings UI. RLS_MATRIX.md
-- explicitly specs clubs' club_owner access as "S,U (own, excl. status)"
-- -- status changes (active/suspended/closed) must be platform_owner-only,
-- per docs/DECISIONS.md ADR-027 ("clubs.status is administrative only").
--
-- But clubs_update_own_club_owner's USING clause only checked
-- (id in user_club_ids() and has_permission('club.update', id)) with no
-- WITH CHECK and no column-level restriction -- confirmed live: a
-- club_owner session successfully changed their own club's status to
-- 'suspended' via a direct REST PATCH, something RLS's row-level model
-- cannot express on its own (a WITH CHECK only re-validates row
-- visibility, not "which columns changed"). Restored to 'active'
-- immediately via execute_sql before writing this fix; no other
-- unintended changes were present.
--
-- Fixed with a BEFORE UPDATE trigger, the standard Postgres pattern for
-- column-level write protection under RLS: revert `status` to its
-- pre-update value whenever the updating role is not platform_owner,
-- rather than raising (a raise would also block otherwise-legitimate
-- updates to other columns in the same statement -- e.g. this migration's
-- own new Club Settings UI, which never touches status, must keep
-- working unaffected). platform_owner's own ALL-policy path is
-- unaffected since is_platform_owner() short-circuits the trigger to a
-- no-op.
create or replace function public.protect_club_status_from_non_platform_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_owner() and new.status is distinct from old.status then
    new.status := old.status;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_club_status on public.clubs;
create trigger trg_protect_club_status
  before update on public.clubs
  for each row
  execute function public.protect_club_status_from_non_platform_owner();
