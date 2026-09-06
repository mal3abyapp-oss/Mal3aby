-- P1 FIX: players.medical_notes has no server-side enforcement on SELECT
-- despite a dedicated permission key (player.medical_notes.view) existing
-- in the catalog and being assigned selectively per role.
--
-- ROOT CAUSE (confirmed live against gxkrtlvpjwxhcqdisyob before this
-- migration, on branch release/pre-sales-hardening):
--   `players_select_club_staff` (see 20260815190000_phase4_customers_players.sql)
--   only checks `has_permission('player.view', club_id)`:
--     qual: (club_id IN (SELECT user_club_ids())) AND has_permission('player.view', club_id)
--   RLS is row-granular, not column-granular, so any role holding
--   player.view gets the FULL row back on a direct
--   `select * from players` / `select medical_notes from players`,
--   including medical_notes -- regardless of whether that role also
--   holds player.medical_notes.view.
--
--   Live-confirmed role/permission split (role_permissions, active
--   system roles): coach, receptionist, branch_manager and accountant
--   all hold player.view WITHOUT player.medical_notes.view, while
--   academy_manager, club_manager and club_owner hold both. The write
--   side is already correctly gated -- update_player() explicitly
--   requires public.has_permission('player.medical_notes.update', v_club_id)
--   before writing a non-null p_medical_notes, raising 'not authorized
--   to update medical notes' otherwise (see 20260815190000). Only the
--   read side was left open.
--
--   Not currently exploitable via the shipped UI: an exhaustive grep of
--   src/ found zero call sites that select medical_notes from anywhere
--   (base table or view) -- PlayersSection.tsx only reads/writes
--   full_name directly and routes medical_notes edits through
--   update_player(); every player-list/search query
--   (EnrollmentSection.tsx, MembershipsSection.tsx, GlobalSearch.tsx)
--   already goes through players_safe or selects id/full_name only; the
--   guardian portal RPC get_my_portal_academy() deliberately never
--   selects medical_notes either. But a direct
--   `supabase.from('players').select('medical_notes')` PostgREST call
--   from any authenticated session holding player.view (which, per the
--   codebase's RLS pattern in project_mal3aby_whatsapp docs and
--   RLS_MATRIX.md, is meant to be reachable straight from the browser,
--   not just via RPC) succeeds today for coach/receptionist/
--   branch_manager/accountant sessions, and for platform_owner via the
--   separate players_platform_owner_select policy (bare
--   is_platform_owner(), same as ~30 other platform-wide read policies
--   in this codebase -- not itself a bug, just not medical_notes-aware).
--
-- WHY THIS GAP EXISTS DESPITE A DESIGNED FIX ALREADY BEING PARTWAY IN:
--   docs/RLS_SECURITY.md ("Sensitive column protection: medical_notes",
--   ADR-019) already chose the "restricted view" pattern over
--   column-level GRANT/REVOKE for V1 ("heavier to manage per-role in
--   Supabase's role model for V1's scale") and players_safe (created in
--   the same migration as players) already implements the view half of
--   that design -- but the *other* half the doc calls for, "gated by an
--   additional RLS check on the base table itself... enforced by which
--   relation the client is authorized/expected to query, backed by
--   application-layer discipline", was never actually enforced at the
--   database level. players_safe existing and being used everywhere in
--   practice (confirmed above) means the "application-layer discipline"
--   half of the design has in fact held up so far -- but nothing stops
--   a direct REST/RPC call to the base table, so it was never a real
--   security boundary, only a convention.
--
-- FIX CHOSEN: column-level REVOKE (pattern b from RLS_SECURITY.md's own
-- "alternative considered" list), not a further view/RPC change --
-- because:
--   1. The view-based pattern (a) already exists (players_safe) and is
--      already the exclusive path every read-only UI surface uses; the
--      residual gap is purely that the base table itself is still
--      unrestricted, which a view sitting beside it cannot fix (a view
--      is opt-in for the querier -- it does not stop someone from
--      quering the underlying table instead).
--   2. Column-level REVOKE is exactly the "more correct at the database
--      level" alternative the doc already flagged and deferred -- V1's
--      per-role management concern the doc raised does not apply here,
--      since this REVOKE is a single blanket column-level grant removal
--      from authenticated/anon, not a per-role rule; per-role
--      enforcement stays entirely in the permissions catalog via
--      update_player()'s existing check and the (new, below)
--      get_player_medical_notes() RPC.
--   3. Every legitimate read need is exhaustively confirmed absent from
--      the shipped frontend today (see grep evidence above), so nothing
--      breaks. A SECURITY DEFINER RPC is added below for the one
--      legitimate need the intended authorization matrix identifies
--      (roles holding player.medical_notes.view) so the permission is
--      actually usable, not just theoretically granted in the catalog
--      with no code path to exercise it.
--
-- INTENDED AUTHORIZATION MATRIX (verified against existing
-- role_permissions/permissions catalog, not invented fresh):
--   - club_owner, club_manager, academy_manager: already hold
--     player.medical_notes.view in the live permissions catalog -> can
--     read via the new RPC.
--   - coach, branch_manager, accountant, receptionist: hold player.view
--     but NOT player.medical_notes.view -> RPC correctly denies; no
--     change to their existing (unaffected) ability to view/edit
--     non-medical player fields via players_safe / update_player().
--   - custom club roles: follow whatever the permission catalog grants
--     them for player.medical_notes.view, same as every other
--     permission-gated RPC in this codebase -- no special-casing needed.
--   - guardian/customer portal: get_my_portal_academy() already never
--     surfaces medical_notes and no portal UI reads the base table
--     directly (confirmed via grep) -- this migration does not add a
--     portal-facing read path, since no existing product surface shows
--     medical data to guardians and the task background did not confirm
--     one is intended; the REVOKE simply closes the direct-table route
--     a guardian session could otherwise have used.
--   - platform_owner: the codebase's existing, consistent convention
--     for platform-wide visibility (players_platform_owner_select and
--     ~30 sibling tables) is a bare is_platform_owner() SELECT policy --
--     this migration does NOT change that policy or introduce
--     support-session gating for it, since doing so would be an
--     unrelated architectural change to an established, intentional
--     pattern used everywhere else, far outside this fix's scope.
--     Column-level REVOKE still applies to platform_owner sessions same
--     as everyone else (column privileges are independent of which RLS
--     policy grants row visibility), so this migration incidentally
--     narrows platform_owner's medical_notes exposure too, consistent
--     with "not an implicit universal match" from the task brief --
--     without touching the broader platform-owner support-access model.
--
-- WHAT'S PRESERVED (verified, not assumed):
--   - players_safe (search, list views) is unaffected -- it never
--     selected medical_notes and does not depend on column grants for
--     the columns it does select.
--   - update_player() is SECURITY DEFINER, owned by `postgres` (table
--     owner) -- column-level REVOKE from authenticated/anon has zero
--     effect on it; medical-notes writes continue to work exactly as
--     before, still gated by its own explicit
--     has_permission('player.medical_notes.update', ...) check.
--   - get_player_360_summary() never selected medical_notes either
--     (confirmed via pg_get_functiondef) -- unaffected.
--   - No frontend call site anywhere in src/ selects medical_notes from
--     any relation (confirmed via exhaustive grep) -- so nothing in the
--     shipped product breaks.

-- ============================================================
-- 1. Column-level REVOKE: the direct-table bypass is closed at the
--    database grant level, not just by convention.
--
--    IMPORTANT (verified live via dry-run before this migration was
--    finalized): `authenticated`/`anon` hold Supabase's standard
--    TABLE-WIDE `GRANT SELECT ... ON ALL TABLES` on `players`, not a
--    per-column grant. A bare `REVOKE SELECT (medical_notes) ... FROM
--    authenticated` has NO EFFECT while a broader table-level SELECT
--    grant coexists -- Postgres resolves column access against the
--    UNION of all applicable grants, and the table-wide grant already
--    covers every column including medical_notes. Confirmed empirically:
--    running the column-only REVOKE alone left
--    has_column_privilege('authenticated', 'players', 'medical_notes',
--    'select') = true. The correct sequence, used below, is to REVOKE
--    the table-wide SELECT first, then re-GRANT SELECT on the explicit
--    column allow-list (every column except medical_notes) -- this is
--    the only ordering that actually changes has_column_privilege() to
--    false, which was re-verified after making this change.
-- ============================================================
revoke select on public.players from authenticated;
revoke select on public.players from anon;

grant select (id, club_id, full_name, date_of_birth, gender, photo_url, status, created_at, updated_at, created_by)
  on public.players to authenticated;
grant select (id, club_id, full_name, date_of_birth, gender, photo_url, status, created_at, updated_at, created_by)
  on public.players to anon;

-- Also revoke the unused write-side column grants for anon (anon has no
-- players RLS policy at all today so this was already unreachable, but
-- an authenticated-only product has no legitimate reason for `anon` to
-- hold INSERT/UPDATE column privileges on medical_notes either --
-- hygiene, matching the "revoke dead grants" precedent already used
-- elsewhere in this codebase, e.g. payments/refunds in the 20260829
-- club-staff-permissions audit).
revoke insert (medical_notes), update (medical_notes) on public.players from anon;

-- ============================================================
-- 2. The one legitimate read path: a SECURITY DEFINER RPC that checks
--    player.medical_notes.view explicitly, mirroring update_player()'s
--    existing pattern for the write side.
-- ============================================================
create or replace function public.get_player_medical_notes(p_player_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_medical_notes text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id into v_club_id
  from public.players
  where id = p_player_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('player.view', club_id);

  if v_club_id is null then
    raise exception 'player not found or you do not have permission to view it';
  end if;

  if not public.has_permission('player.medical_notes.view', v_club_id) then
    raise exception 'not authorized to view medical notes';
  end if;

  select medical_notes into v_medical_notes
  from public.players
  where id = p_player_id;

  return v_medical_notes;
end;
$function$;

revoke all on function public.get_player_medical_notes(uuid) from public;
revoke all on function public.get_player_medical_notes(uuid) from anon;
grant execute on function public.get_player_medical_notes(uuid) to authenticated;

comment on function public.get_player_medical_notes(uuid) is
  'The only server-side read path for players.medical_notes. Requires player.view (row visibility) AND player.medical_notes.view (column-level permission) on the players club. Companion to update_player()''s existing p_medical_notes write gate. See 20260906160000_revoke_medical_notes_column_grant.sql for full root-cause and design rationale.';
