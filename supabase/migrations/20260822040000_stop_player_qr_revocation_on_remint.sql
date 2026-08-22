-- WHATSAPP BUSINESS MESSAGING FINAL HARDENING (2026-08-22), Section 22 /
-- Section 31 (Academy QR must follow the same no-unnecessary-rotation
-- rule as Field Booking QR): ensure_player_qr() has the exact same bug
-- already fixed in 20260822030000 for ensure_booking_qr() /
-- _mint_booking_qr_token_internal() / _mint_invoice_token_internal() --
-- confirmed via direct pg_get_functiondef read, this function
-- unconditionally revokes the player's currently-active
-- 'player_membership' qr_credentials row before minting a new one, on
-- every call, with no check for whether a valid credential already
-- existed.
--
-- Same real-world impact: a guardian/player receives an Academy
-- attendance link (however it was originally minted). If a staff
-- member later opens the player's record and re-triggers this
-- function (e.g. a "Show QR" action, mirroring BookingDetailSheet's
-- staff flow for bookings), the previously-issued credential is
-- silently revoked for a reason unrelated to the credential's own
-- validity -- identical failure mode to the booking case.
--
-- Same safety argument applies: qr_confirm_checkin() gates on both the
-- scanned credential's own status AND the underlying entity's current
-- state; nothing in this codebase's scan/attendance flow requires
-- "at most one active credential per player" for correctness. This
-- comment in the prior migration (ensure_booking_qr) documented that
-- reasoning in full; the same reasoning applies unchanged here since
-- 'player_membership' credentials are validated through the same
-- qr_credentials table and (per the existing architecture) the same
-- class of scan/verification RPC.
--
-- Fix: mint a genuinely new credential on every call (unchanged --
-- the raw token is never persisted and cannot be recovered from a
-- stored hash), WITHOUT first revoking whatever credential(s) already
-- exist for this player. No other line changed -- authorization logic
-- (club membership + 'player.view' permission) is byte-for-byte
-- identical to the original.
create or replace function public.ensure_player_qr(p_player_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_raw_token text;
  v_token_hash text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id into v_club_id from public.players where id = p_player_id;
  if v_club_id is null then
    raise exception 'player not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('player.view', v_club_id)) then
    raise exception 'not authorized';
  end if;

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  insert into public.qr_credentials (club_id, type, reference_id, token_hash, status, single_use, expires_at, created_by)
  values (v_club_id, 'player_membership', p_player_id, v_token_hash, 'active', false, null, auth.uid());

  return v_raw_token;
end;
$function$;
