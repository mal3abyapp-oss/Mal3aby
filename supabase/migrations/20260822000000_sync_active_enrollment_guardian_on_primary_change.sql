-- BUSINESS MESSAGING AUDIT FIX (P2, confirmed real): renew_academy_subscription()
-- resolves the billing/notification recipient as
-- `coalesce(v_enrollment.guardian_id, live-primary-guardian-lookup)` --
-- enrollments.guardian_id, once set at enrollment creation time (either
-- explicitly via create_enrollment_with_subscription's p_guardian_id,
-- or implicitly whenever a primary guardian existed at that moment),
-- ALWAYS wins over a fresh live lookup on every future renewal, with
-- nothing keeping it in sync when set_primary_guardian() is later
-- called for that player.
--
-- Confirmed live during an independent audit: enrolled a player with
-- explicit guardian A as the billing guardian, reassigned primary to
-- guardian B via set_primary_guardian(), renewed the subscription on
-- the same enrollment -- the renewal invoice still billed/notified
-- guardian A, silently ignoring the reassignment.
--
-- Root cause is NOT simply "prefer the live lookup always" -- that
-- would break a genuinely different, legitimate case:
-- create_enrollment_with_subscription's p_guardian_id lets a staff
-- member deliberately bill a SPECIFIC guardian for ONE enrollment,
-- which may intentionally differ from whichever guardian happens to be
-- marked primary (e.g. a grandparent pays for one specific program
-- while a parent remains the player's general primary contact) -- that
-- deliberate choice must survive until the staff member takes an
-- explicit action to change it, not silently flip on every renewal.
--
-- set_primary_guardian() is itself PLAYER-scoped (not enrollment-
-- scoped) -- a staff member calling it is making a player-wide
-- decision ("this player's guardian is now X, going forward"), which
-- is exactly the deliberate re-assignment action that SHOULD propagate
-- to future billing. The correct fix: when set_primary_guardian() is
-- called, it also updates guardian_id on that player's currently
-- ACTIVE enrollments (future renewals only) -- never touching:
--   - historical/closed enrollments (their guardian_id is a correct
--     historical fact, not to be rewritten)
--   - any already-issued invoice's customer_id (financial immutability,
--     unaffected by this migration -- record_payment's own recipient
--     resolution, which reads an existing invoice's customer_id
--     directly, is untouched and remains correct)
--   - an enrollment whose guardian_id was never set at all (already
--     correctly falls through to a live lookup, no bug there)
create or replace function public.set_primary_guardian(p_player_id uuid, p_customer_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id into v_club_id from public.players where id = p_player_id;
  if v_club_id is null then
    raise exception 'player not found';
  end if;

  if not (v_club_id in (select public.user_club_ids())
          and public.has_permission('player.update', v_club_id)
          and public.has_permission('customer.update', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.guardian_links where player_id = p_player_id and customer_id = p_customer_id) then
    raise exception 'this customer is not a linked guardian of this player';
  end if;

  perform 1 from public.guardian_links where player_id = p_player_id for update;

  update public.guardian_links set is_primary = false
  where player_id = p_player_id and is_primary = true and customer_id != p_customer_id;

  update public.guardian_links set is_primary = true
  where player_id = p_player_id and customer_id = p_customer_id;

  -- Propagate to this player's ACTIVE enrollments only -- a deliberate
  -- player-wide guardian reassignment should be reflected in future
  -- renewal billing/notifications. Historical/closed enrollments are
  -- untouched (their guardian_id remains a correct record of who was
  -- billed at the time), and no existing invoice is ever modified.
  update public.enrollments
  set guardian_id = p_customer_id
  where player_id = p_player_id and status = 'active';

  perform public.write_audit_log(v_club_id, 'guardian_link.set_primary', 'players', p_player_id, null,
    jsonb_build_object('new_primary_customer_id', p_customer_id), null);
end;
$function$;
