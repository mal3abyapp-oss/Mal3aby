-- Finding M-6 (frozen production audit baseline): commercial entitlement
-- caps (branches, fields, academy programs) were enforced only by
-- BEFORE INSERT triggers (enforce_branch_limit, enforce_field_limit,
-- enforce_academy_limit -- 20260816100000_commercial_entitlements.sql),
-- counting status='active' rows. A club sitting at its cap could:
--   1. deactivate an existing active resource (UPDATE ... SET status =
--      'inactive' -- not covered by any trigger),
--   2. insert a new resource (passes the INSERT check, since the
--      deactivated row no longer counts),
--   3. reactivate the original resource via UPDATE ... SET status =
--      'active' (also not covered by any trigger, since the existing
--      triggers only fire `before insert`),
-- ending up with one MORE active resource than the entitlement allows.
--
-- This is a shared invariant gap across all three resource types, not a
-- single-table bug: "count only fires on INSERT" was wrong for all of
-- branches/fields/programs alike. Fixed the same way in all three by
-- widening each trigger from `before insert` to `before insert or
-- update` and running the limit-check logic whenever a row is
-- transitioning INTO status = 'active' (on INSERT, or on UPDATE where
-- OLD.status was not already 'active'). Any other update -- renames,
-- edits to a still-inactive row, moving between two non-active statuses
-- (e.g. fields 'inactive' -> 'maintenance') -- skips the check entirely,
-- so unrelated writes are neither slowed down nor newly blocked.
--
-- Reactivation paths confirmed by reading the call sites before writing
-- this:
--   - branches: public.manage_branch() (20260821123200) does a single
--     generic `update public.branches set ... status = p_status`, no
--     INSERT/UPDATE split and no existing limit pre-check. A raw
--     UPDATE (RLS-gated, no RPC) is also possible for any caller with
--     an UPDATE grant/policy on public.branches, so the fix must live
--     in the trigger (table-level), not only in the RPC.
--   - fields: public.manage_field() (20260821123200) -- same shape as
--     manage_branch, single generic UPDATE, no limit pre-check.
--   - programs: NO dedicated manage_program()/RPC exists in this schema
--     at all (verified: only `programs_insert`/`programs_update` RLS
--     policies gated on academy.program.manage). The frontend writes
--     public.programs directly, so table-level trigger enforcement is
--     the *only* place this can be enforced for programs.
-- Given RPC writes and raw table writes both funnel through the same
-- table-level BEFORE trigger, and neither manage_branch nor
-- manage_field nor any program RPC currently translates the existing
-- INSERT-path P0001 exception into a friendlier message (grepped the
-- frontend: no code parses branch_limit_reached/field_limit_reached/
-- academy_limit_reached today), the trigger remains the single source
-- of truth per the audit's "consolidate shared invariants" guidance.
-- Not adding RPC pre-checks preserves that -- one place to read, one
-- place that can drift. (A friendlier client-side pre-flight check
-- using commercial_entitlements_usage before submitting the reactivate
-- action is a reasonable future UX enhancement, but it is optional
-- polish, not a correctness requirement, since the trigger already
-- hard-blocks the over-cap write either way.)
--
-- Concurrency: the pre-existing INSERT-path trigger has NO explicit row
-- locking -- it runs a plain `select count(*)` under READ COMMITTED,
-- so two concurrent INSERT transactions racing toward the same cap
-- could theoretically both read the same pre-commit count and both
-- pass (a pre-existing gap this migration is not strictly obligated to
-- fix beyond parity). Rather than only mirroring that gap, this
-- migration closes it cheaply for both INSERT and UPDATE paths by
-- taking `select ... for update` on the club's commercial_entitlements
-- row before counting. Every insert/reactivation for a given club now
-- serializes on that one row: the second concurrent transaction blocks
-- at the `for update` until the first commits (or rolls back), then
-- re-reads the now-committed count, so two concurrent reactivations
-- (or an insert racing a reactivation) toward the same cap can no
-- longer both succeed. A club with no commercial_entitlements row
-- (NULL limit = unlimited) has nothing to lock and nothing to check,
-- exactly as before -- this never newly blocks an uncapped club, and
-- never blocks concurrent writes for *different* clubs since each
-- club's row is independent.
-- ============================================================

create or replace function public.enforce_branch_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_count integer;
begin
  -- Only run the cap check on INSERT, or on an UPDATE that transitions
  -- the row INTO 'active' from something else. Renames, edits to an
  -- already-active row, or edits that leave the row non-active are
  -- irrelevant to the cap and skip straight through.
  if TG_OP = 'UPDATE' and not (new.status = 'active' and old.status is distinct from 'active') then
    return new;
  end if;

  -- Lock the club's entitlement row first so concurrent inserts/
  -- reactivations for the same club serialize here rather than racing
  -- on an unlocked count(*). No row to lock (no entitlements row at
  -- all) means no limit configured -- fall through as unlimited.
  perform 1 from public.commercial_entitlements where club_id = new.club_id for update;

  select branch_limit into v_limit from public.commercial_entitlements where club_id = new.club_id;
  if v_limit is null then
    return new;
  end if;

  select count(*) into v_count from public.branches where club_id = new.club_id and status = 'active';
  if v_count >= v_limit then
    raise exception 'branch_limit_reached: club has reached its commercial branch limit (%)', v_limit
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_branch_limit() from public, anon, authenticated;

drop trigger if exists trg_enforce_branch_limit on public.branches;
create trigger trg_enforce_branch_limit
  before insert or update on public.branches
  for each row execute function public.enforce_branch_limit();

create or replace function public.enforce_field_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_count integer;
begin
  if TG_OP = 'UPDATE' and not (new.status = 'active' and old.status is distinct from 'active') then
    return new;
  end if;

  perform 1 from public.commercial_entitlements where club_id = new.club_id for update;

  select field_limit into v_limit from public.commercial_entitlements where club_id = new.club_id;
  if v_limit is null then
    return new;
  end if;

  -- Section E/F/G: the license is club-wide, summed across ALL branches
  -- of the same club, never per-branch.
  select count(*) into v_count from public.fields where club_id = new.club_id and status = 'active';
  if v_count >= v_limit then
    raise exception 'field_limit_reached: club has reached its commercial field limit (%)', v_limit
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_field_limit() from public, anon, authenticated;

drop trigger if exists trg_enforce_field_limit on public.fields;
create trigger trg_enforce_field_limit
  before insert or update on public.fields
  for each row execute function public.enforce_field_limit();

create or replace function public.enforce_academy_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_count integer;
begin
  if TG_OP = 'UPDATE' and not (new.status = 'active' and old.status is distinct from 'active') then
    return new;
  end if;

  perform 1 from public.commercial_entitlements where club_id = new.club_id for update;

  select academy_limit into v_limit from public.commercial_entitlements where club_id = new.club_id;
  if v_limit is null then
    return new;
  end if;

  -- Section I: one active Academy Program = one licensed academy unit
  -- (the V1 interpretation adopted per the directive's own preferred
  -- reading, since nothing in the locked schema defines a narrower
  -- billable academy unit than "program").
  select count(*) into v_count from public.programs where club_id = new.club_id and status = 'active';
  if v_count >= v_limit then
    raise exception 'academy_limit_reached: club has reached its commercial academy limit (%)', v_limit
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_academy_limit() from public, anon, authenticated;

drop trigger if exists trg_enforce_academy_limit on public.programs;
create trigger trg_enforce_academy_limit
  before insert or update on public.programs
  for each row execute function public.enforce_academy_limit();
