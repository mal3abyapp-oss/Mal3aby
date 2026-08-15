-- Fix: qr_scan_events.club_id was not null, but DATABASE_BLUEPRINT.md's own
-- spec for this table describes exactly the case where it can't be known --
-- "credential_id (nullable -- null if the token didn't resolve to any
-- credential, e.g. garbage/forged input)". A garbage/forged token has no
-- resolvable club either, so qr_validate/qr_confirm_checkin correctly try
-- to log club_id = null for that case and were failing the not-null
-- constraint. Discovered live during Phase 8 abuse testing (invalid-token
-- scan attempt).

alter table public.qr_scan_events alter column club_id drop not null;

-- SELECT policy: rows with club_id = null (unresolvable-token attempts)
-- carry no tenant to scope by. Restrict visibility of those rows to the
-- scanning user themselves (same "own scans" fallback already used for the
-- Scanner role) plus Platform Owner (abuse review) -- never broadly
-- visible across a club's staff, since there is no club to check
-- membership against.
drop policy if exists "qr_scan_events_select" on public.qr_scan_events;

create policy "qr_scan_events_select" on public.qr_scan_events for select
  using (
    (club_id is not null and club_id in (select public.user_club_ids())
      and (public.has_permission('booking.view', club_id) or scanner_user_id = auth.uid()))
    or (club_id is null and scanner_user_id = auth.uid())
    or public.is_platform_owner()
  );
