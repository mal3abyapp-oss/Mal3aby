-- Phase 8 -- QR + Scanner + Check-in.
-- See docs/IMPLEMENTATION_PLAN.md Phase 8, docs/DECISIONS.md ADR-005/
-- ADR-011d/ADR-011e, docs/DATABASE_BLUEPRINT.md #qr_credentials/#qr_scan_events,
-- docs/RLS_MATRIX.md (qr_credentials validate vs confirm rows), docs/RLS_SECURITY.md
-- (ensure_booking_qr / qr_validate / qr_confirm_checkin function inventory).

-- ============================================================
-- Tables
-- ============================================================

create table public.qr_credentials (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  type text not null check (type in ('booking', 'player_membership')),
  reference_id uuid not null,
  token_hash text not null unique,
  status text not null default 'active' check (status in ('active', 'consumed', 'expired', 'revoked')),
  single_use boolean not null,
  expires_at timestamptz,
  used_at timestamptz,
  used_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index qr_credentials_club_id_idx on public.qr_credentials (club_id);
create index qr_credentials_reference_idx on public.qr_credentials (type, reference_id);

alter table public.qr_credentials enable row level security;

-- SELECT: club-scoped, same pattern as every other tenant-scoped table.
-- token_hash is a column on the row -- it is never surfaced through the
-- frontend query layer (features query specific columns, never `select *`
-- against this table), and the validate/confirm RPCs below are the only
-- code paths that need it.
create policy "qr_credentials_select" on public.qr_credentials for select
  using (club_id in (select public.user_club_ids()));

-- No direct client INSERT/UPDATE policy at all -- qr_credentials rows are
-- written only by SECURITY DEFINER functions (ensure_booking_qr,
-- qr_confirm_checkin), which bypass RLS by design.

alter table public.qr_credentials force row level security;

create table public.qr_scan_events (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: a garbage/forged token that doesn't resolve to any credential
  -- has no resolvable club either -- still logged, with club_id = null.
  club_id uuid references public.clubs(id),
  credential_id uuid references public.qr_credentials(id),
  scanner_user_id uuid references auth.users(id),
  action text not null check (action in ('validate', 'check_in', 'attendance_mark')),
  result text not null check (result in ('success', 'already_used', 'expired', 'invalid', 'wrong_club', 'permission_denied')),
  reference_type text check (reference_type in ('booking', 'player_membership')),
  reference_id uuid,
  scanned_at timestamptz not null default now(),
  device_metadata jsonb
);

create index qr_scan_events_club_id_idx on public.qr_scan_events (club_id);
create index qr_scan_events_credential_idx on public.qr_scan_events (credential_id);

alter table public.qr_scan_events enable row level security;

-- SELECT: club-scoped for staff roles; a Scanner-role account (device-only
-- login, no wider staff access) sees only its own scan events, matching
-- RLS_MATRIX.md's "S (own scans)" cell. Rows with club_id = null
-- (unresolvable/garbage-token attempts) carry no tenant to scope by --
-- visible only to the scanning user and Platform Owner (abuse review).
create policy "qr_scan_events_select" on public.qr_scan_events for select
  using (
    (club_id is not null and club_id in (select public.user_club_ids())
      and (public.has_permission('booking.view', club_id) or scanner_user_id = auth.uid()))
    or (club_id is null and scanner_user_id = auth.uid())
    or public.is_platform_owner()
  );

-- No direct client INSERT/UPDATE/DELETE policy -- written only via
-- SECURITY DEFINER RPCs (qr_validate, qr_confirm_checkin), never a direct
-- client insert, per DATABASE_BLUEPRINT.md.

alter table public.qr_scan_events force row level security;

-- ============================================================
-- Permissions -- qr.scan (validate) and qr.checkin.confirm (consume +
-- mutate booking status), matching RLS_MATRIX.md's split of "validate
-- only" vs "confirm/consume via RPC" qr_credentials access.
-- ============================================================

insert into public.permissions (key, description) values
  ('qr.scan', 'Validate a QR code (read-only lookup)'),
  ('qr.checkin.confirm', 'Confirm booking check-in from a validated QR scan')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where p.key = 'qr.scan'
  and r.key in ('platform_owner', 'club_owner', 'club_manager', 'branch_manager', 'receptionist', 'academy_manager', 'coach', 'scanner')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where p.key = 'qr.checkin.confirm'
  and r.key in ('platform_owner', 'club_owner', 'club_manager', 'branch_manager', 'receptionist', 'scanner')
on conflict do nothing;

-- ============================================================
-- ensure_booking_qr: idempotently generates/regenerates a booking's QR
-- credential. Returns the raw token (only time it's ever seen). Never
-- persists the raw token -- only sha256(token) is stored.
-- ============================================================

create or replace function public.ensure_booking_qr(p_booking_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_status text;
  v_raw_token text;
  v_token_hash text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id, status into v_club_id, v_status from public.bookings where id = p_booking_id;
  if v_club_id is null then
    raise exception 'booking not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.view', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if v_status in ('cancelled', 'no_show') then
    raise exception 'cannot generate a QR for a cancelled or no-show booking';
  end if;

  -- Revoke any prior still-active credential for this booking before
  -- issuing a new one -- at most one active booking QR per booking.
  update public.qr_credentials
  set status = 'revoked'
  where type = 'booking' and reference_id = p_booking_id and status = 'active';

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  insert into public.qr_credentials (club_id, type, reference_id, token_hash, status, single_use, expires_at, created_by)
  values (v_club_id, 'booking', p_booking_id, v_token_hash, 'active', true, (select end_at from public.bookings where id = p_booking_id) + interval '2 hours', auth.uid());

  return v_raw_token;
end;
$$;

revoke execute on function public.ensure_booking_qr(uuid) from public;
revoke execute on function public.ensure_booking_qr(uuid) from anon;
grant execute on function public.ensure_booking_qr(uuid) to authenticated;

-- ============================================================
-- qr_validate: read-only lookup + status/expiry/club check. Logs to
-- qr_scan_events regardless of outcome. Never mutates qr_credentials.
-- ============================================================

create or replace function public.qr_validate(p_token text)
returns table(
  result text,
  credential_id uuid,
  reference_type text,
  reference_id uuid,
  club_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token_hash text;
  v_cred record;
  v_result text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash;

  if v_cred.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (null, null, auth.uid(), 'validate', 'invalid', null, null);
    return query select 'invalid'::text, null::uuid, null::text, null::uuid, null::uuid;
    return;
  end if;

  if not (v_cred.club_id in (select public.user_club_ids()) and public.has_permission('qr.scan', v_cred.club_id)) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', 'wrong_club', v_cred.type, v_cred.reference_id);
    return query select 'wrong_club'::text, null::uuid, null::text, null::uuid, null::uuid;
    return;
  end if;

  if v_cred.status = 'consumed' then
    v_result := 'already_used';
  elsif v_cred.status = 'revoked' then
    v_result := 'invalid';
  elsif v_cred.expires_at is not null and v_cred.expires_at < now() then
    v_result := 'expired';
  else
    v_result := 'success';
  end if;

  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', v_result, v_cred.type, v_cred.reference_id);

  return query select v_result, v_cred.id, v_cred.type, v_cred.reference_id, v_cred.club_id;
end;
$$;

revoke execute on function public.qr_validate(text) from public;
revoke execute on function public.qr_validate(text) from anon;
grant execute on function public.qr_validate(text) to authenticated;

-- ============================================================
-- qr_confirm_checkin: atomically consumes a booking QR credential and
-- transitions bookings.status -> checked_in together. Explicit staff
-- confirmation step, separate from validate (ADR-011e). Replay-safe:
-- a row lock on the credential plus a status re-check inside the same
-- transaction closes the race between two concurrent confirms of the
-- same token.
-- ============================================================

create or replace function public.qr_confirm_checkin(p_token text)
returns table(result text, booking_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token_hash text;
  v_cred record;
  v_booking record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash for update;

  if v_cred.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (null, null, auth.uid(), 'check_in', 'invalid', null, null);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if v_cred.type != 'booking' then
    raise exception 'not a booking credential';
  end if;

  if not (v_cred.club_id in (select public.user_club_ids()) and public.has_permission('qr.checkin.confirm', v_cred.club_id)) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'permission_denied', v_cred.type, v_cred.reference_id);
    return query select 'permission_denied'::text, null::uuid;
    return;
  end if;

  if v_cred.status = 'consumed' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'already_used', v_cred.type, v_cred.reference_id);
    return query select 'already_used'::text, v_cred.reference_id;
    return;
  end if;

  if v_cred.status = 'revoked' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if v_cred.expires_at is not null and v_cred.expires_at < now() then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'expired', v_cred.type, v_cred.reference_id);
    return query select 'expired'::text, null::uuid;
    return;
  end if;

  select * into v_booking from public.bookings where id = v_cred.reference_id for update;

  if v_booking.id is null or v_booking.status not in ('pending_payment', 'confirmed') then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  update public.qr_credentials
  set status = 'consumed', used_at = now(), used_by = auth.uid()
  where id = v_cred.id;

  update public.bookings
  set status = 'checked_in', marked_by = auth.uid(), marked_at = now()
  where id = v_booking.id;

  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'success', v_cred.type, v_cred.reference_id);

  perform public.write_audit_log(v_cred.club_id, 'booking.check_in', 'booking', v_booking.id, jsonb_build_object('status', v_booking.status), jsonb_build_object('status', 'checked_in'), null);

  return query select 'success'::text, v_booking.id;
end;
$$;

revoke execute on function public.qr_confirm_checkin(text) from public;
revoke execute on function public.qr_confirm_checkin(text) from anon;
grant execute on function public.qr_confirm_checkin(text) to authenticated;

-- Note: bookings.status already allows 'checked_in' (and 'completed') --
-- Phase 6's bookings_status_check and no_overlapping_field_bookings
-- exclusion constraint were defined with check-in already anticipated.
-- Nothing to alter here.
