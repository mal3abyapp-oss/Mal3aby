-- Phase 16 (E2E QA fix) -- ensure_player_qr.
-- USER_FLOWS.md Flow 3 (Academy Enrollment) explicitly ends with "QR
-- generated for player (type: player_membership, single_use=false,
-- reusable)", and Flow 4 (Attendance)/Flow 6 (QR Scan) both depend on a
-- player_membership credential existing to scan against -- but no RPC to
-- create one was ever built (Phase 12's qr_mark_attendance only consumes/
-- validates an existing credential). Found during Phase 16's end-to-end
-- flow chaining. Mirrors ensure_booking_qr's pattern exactly, with the
-- two differences the type requires: single_use = false (reusable, per
-- ADR-011d) and no expires_at (a membership card doesn't expire on a
-- per-scan basis the way a booking window does).

create or replace function public.ensure_player_qr(p_player_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  -- Revoke any prior still-active credential for this player before
  -- issuing a new one -- at most one active player_membership QR per
  -- player, same invariant ensure_booking_qr maintains per booking.
  update public.qr_credentials
  set status = 'revoked'
  where type = 'player_membership' and reference_id = p_player_id and status = 'active';

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  insert into public.qr_credentials (club_id, type, reference_id, token_hash, status, single_use, expires_at, created_by)
  values (v_club_id, 'player_membership', p_player_id, v_token_hash, 'active', false, null, auth.uid());

  return v_raw_token;
end;
$$;

revoke execute on function public.ensure_player_qr(uuid) from public;
revoke execute on function public.ensure_player_qr(uuid) from anon;
grant execute on function public.ensure_player_qr(uuid) to authenticated;
