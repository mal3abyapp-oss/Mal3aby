-- Master directive: WhatsApp secure links (booking QR + invoice).
--
-- Goal: WhatsApp booking-confirmation and payment/invoice messages
-- carry a secure, non-guessable link to (1) the booking's attendance
-- QR and (2) the invoice, without a raw/predictable ID ever being the
-- authorization mechanism, and WITHOUT building a second credential
-- system -- this reuses the exact tables/hash pattern that already
-- exist (qr_credentials, invoice_verification_tokens,
-- ensure_booking_qr/ensure_invoice_qr's own token-minting logic) per
-- the directive's explicit "check what exists, reuse it" requirement.
--
-- Why not just call ensure_booking_qr()/ensure_invoice_qr() directly
-- from the business RPCs below: both require auth.uid() + a specific
-- staff permission (booking.view / invoice.view). The business RPCs
-- that need to auto-mint a link run under varying callers --
-- _create_booking_internal and cancel_booking run as whichever
-- authenticated user holds booking.create/booking.cancel,
-- record_payment runs as whoever holds payment.create -- none of
-- which is guaranteed to also hold booking.view/invoice.view in the
-- same call. Re-checking a DIFFERENT permission than the one already
-- verified for the primary action would be an arbitrary new gate, not
-- real security. Instead this migration extracts the token-minting
-- core (gen_random_bytes -> sha256 hash -> revoke-prior -> insert) into
-- two internal-only helpers with NO grants to any role at all --
-- callable exclusively from other SECURITY DEFINER functions in the
-- same transaction, which is exactly how the existing QR/invoice
-- token tables are already designed to be written (their own tables
-- have zero direct INSERT/UPDATE policies, write access is
-- SECURITY-DEFINER-function-only already).
--
-- Booking QR lifecycle used here matches ensure_booking_qr() exactly:
-- single_use=true, expires_at = booking.end_at + 2h, at most one
-- active credential per booking (idempotent re-mint revokes the
-- prior one -- directive rule 15, "reuse a still-valid credential
-- rather than minting a new one needlessly" is satisfied by NOT
-- re-minting inside these business RPCs at all when a WhatsApp
-- message is merely re-queued/retried; the token is minted exactly
-- once per triggering business event, see each call site below).
--
-- Invoice-link lifecycle matches ensure_invoice_qr(): non-expiring
-- lookup reference (not an access credential), at most one active
-- token per invoice.
--
-- Tokens themselves are NEVER put in the notification payload as a
-- URL -- only the raw token string, under new keys booking_qr_token /
-- invoice_token. URL composition (prefixing the public base URL) is
-- done entirely in the WhatsApp connector (a separate Node process
-- with real env-var access), never in SQL and never in the frontend --
-- this repo has no PUBLIC_APP_URL concept in Postgres and deliberately
-- doesn't need one; see whatsapp-connector/src/templates.ts's companion
-- change in this same directive for where the URL is actually built.

-- ============================================================
-- Internal token-minting helpers. NOT granted to any role -- callable
-- only from other SECURITY DEFINER functions in the same call stack
-- (Postgres function-privilege model: a SECURITY DEFINER function
-- executes with its owner's privileges, so it can call another
-- function with zero grants as long as the owner itself has EXECUTE,
-- which the migration-running role does by virtue of having just
-- created it). This intentionally mirrors ensure_booking_qr /
-- ensure_invoice_qr's exact body, not a new design.
-- ============================================================

create or replace function public._mint_booking_qr_token_internal(p_booking_id uuid, p_club_id uuid, p_expires_at timestamptz, p_created_by uuid)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_raw_token text;
  v_token_hash text;
begin
  update public.qr_credentials
  set status = 'revoked'
  where type = 'booking' and reference_id = p_booking_id and status = 'active';

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  insert into public.qr_credentials (club_id, type, reference_id, token_hash, status, single_use, expires_at, created_by)
  values (p_club_id, 'booking', p_booking_id, v_token_hash, 'active', true, p_expires_at, p_created_by);

  return v_raw_token;
end;
$$;

revoke execute on function public._mint_booking_qr_token_internal(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;

comment on function public._mint_booking_qr_token_internal(uuid, uuid, timestamptz, uuid) is
  'Internal-only (zero grants) -- mints a booking QR credential using the exact same table/hash/revoke-prior pattern as ensure_booking_qr(), for use by business RPCs (booking-created/confirmed) that cannot re-check booking.view in their own auth context. Never call directly from a client.';

create or replace function public._mint_invoice_token_internal(p_invoice_id uuid, p_club_id uuid, p_created_by uuid)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_raw_token text;
  v_token_hash text;
begin
  update public.invoice_verification_tokens
  set status = 'revoked'
  where invoice_id = p_invoice_id and status = 'active';

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  insert into public.invoice_verification_tokens (club_id, invoice_id, token_hash, status, created_by)
  values (p_club_id, p_invoice_id, v_token_hash, 'active', p_created_by);

  return v_raw_token;
end;
$$;

revoke execute on function public._mint_invoice_token_internal(uuid, uuid, uuid) from public, anon, authenticated;

comment on function public._mint_invoice_token_internal(uuid, uuid, uuid) is
  'Internal-only (zero grants) -- mints an invoice verification token using the exact same table/hash/revoke-prior pattern as ensure_invoice_qr(), for use by business RPCs (record_payment) that cannot re-check invoice.view in their own auth context. Never call directly from a client.';

-- ============================================================
-- qr_validate(): directive rule 3 -- a cancelled booking's QR must
-- read as invalid/revoked immediately, not merely "active but the
-- scan happens to be pointless". Confirmed via full-repo read this
-- was a REAL gap: qr_validate() checked credential status/expiry only
-- (consumed/revoked/expired), never the underlying booking's own
-- status -- an active, unexpired credential for a since-cancelled
-- booking would validate as 'success' at the staff scanner too, not
-- just at a hypothetical customer-facing link. Full body preserved
-- from 20260816260000 (the latest prior version, with identity-
-- verification display fields) -- only the new booking-status check is
-- added, inserted before the existing consumed/revoked/expired
-- ladder so a cancelled booking never reaches those branches at all.
-- ============================================================
create or replace function public.qr_validate(p_token text)
returns table(
  result text,
  credential_id uuid,
  reference_type text,
  reference_id uuid,
  club_id uuid,
  display_name text,
  display_photo_url text,
  display_subtitle text,
  subscription_status text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_token_hash text;
  v_cred record;
  v_result text;
  v_display_name text;
  v_display_photo_url text;
  v_display_subtitle text;
  v_subscription_status text;
  v_booking_status text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash;

  if v_cred.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (null, null, auth.uid(), 'validate', 'invalid', null, null);
    return query select 'invalid'::text, null::uuid, null::text, null::uuid, null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  if not (v_cred.club_id in (select public.user_club_ids()) and public.has_permission('qr.scan', v_cred.club_id)) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', 'wrong_club', v_cred.type, v_cred.reference_id);
    return query select 'wrong_club'::text, null::uuid, null::text, null::uuid, null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  -- Directive rule 3: a booking-type credential for a cancelled/no-show
  -- booking is treated as invalid regardless of its own stored status
  -- -- cancel_booking() also actively revokes the row (see below), so
  -- this is a defense-in-depth check for any credential minted before
  -- that revocation logic existed, or any future code path that
  -- forgets to revoke explicitly.
  if v_cred.type = 'booking' then
    select status into v_booking_status from public.bookings where id = v_cred.reference_id;
    if v_booking_status in ('cancelled', 'no_show') then
      insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
      values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', 'invalid', v_cred.type, v_cred.reference_id);
      return query select 'invalid'::text, null::uuid, null::text, null::uuid, null::uuid, null::text, null::text, null::text, null::text;
      return;
    end if;
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

  if v_cred.type = 'booking' then
    select c.full_name,
           f.name || ' — ' || to_char(b.start_at at time zone cl.timezone, 'HH24:MI')
      into v_display_name, v_display_subtitle
    from public.bookings b
    join public.customers c on c.id = b.customer_id
    join public.fields f on f.id = b.field_id
    join public.clubs cl on cl.id = b.club_id
    where b.id = v_cred.reference_id;
    v_display_photo_url := null;

  elsif v_cred.type = 'player_membership' then
    select p.full_name, p.photo_url,
           coalesce(g.name, 'بدون مجموعة'),
           s.status
      into v_display_name, v_display_photo_url, v_display_subtitle, v_subscription_status
    from public.players p
    left join public.enrollments e on e.player_id = p.id and e.status = 'active'
    left join public.groups g on g.id = e.group_id
    left join public.subscriptions s on s.enrollment_id = e.id
    where p.id = v_cred.reference_id;
  end if;

  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', v_result, v_cred.type, v_cred.reference_id);

  return query select v_result, v_cred.id, v_cred.type, v_cred.reference_id, v_cred.club_id,
    v_display_name, v_display_photo_url, v_display_subtitle, v_subscription_status;
end;
$$;

comment on function public.qr_validate(text) is
  'Staff-only QR lookup (qr.scan permission), used by the scanner UI. Now also treats a cancelled/no_show booking''s credential as invalid regardless of its own stored status (directive: WhatsApp secure links, rule 3) -- defense in depth alongside cancel_booking()''s explicit revocation.';

-- ============================================================
-- verify_booking_qr_public(): the new PUBLIC (anon-callable) booking-QR
-- verification lookup a WhatsApp link opens to. Mirrors
-- verify_invoice_public()'s exact security posture: no auth.uid()
-- check, token-only access control, deliberately narrow payload.
--
-- Unlike qr_validate() (staff scanner, consumes/confirms attendance),
-- this NEVER mutates anything and NEVER writes to qr_scan_events --
-- it is a read-only "is this still my valid attendance code" check for
-- the customer themselves, mirroring verify_invoice_public()'s own
-- "never touches the staff audit surface" design note exactly.
-- ============================================================
create or replace function public.verify_booking_qr_public(p_token text)
returns table(
  result text,
  booking_ref text,
  field_name text,
  sport text,
  start_at timestamptz,
  end_at timestamptz,
  timezone text,
  booking_status text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_token_hash text;
  v_cred record;
  v_booking record;
begin
  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash and type = 'booking';

  if v_cred.id is null then
    return query select 'invalid'::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
    return;
  end if;

  select b.*, f.name as field_name, f.sport as sport, cl.timezone as club_timezone
    into v_booking
    from public.bookings b
    join public.fields f on f.id = b.field_id
    join public.clubs cl on cl.id = b.club_id
    where b.id = v_cred.reference_id;

  if v_booking.id is null then
    return query select 'invalid'::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
    return;
  end if;

  -- Directive rule 3 & 4: cancelled/no-show booking, a revoked
  -- credential, or an expired credential must all read as their own
  -- honest non-success state, never a bare "invalid" that hides which
  -- of the three actually applies -- the frontend page renders a
  -- different message per case (cancelled vs expired vs already_used
  -- vs invalid), matching the directive's explicit lifecycle
  -- requirement.
  if v_booking.status in ('cancelled', 'no_show') then
    return query select 'cancelled'::text,
      'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name, v_booking.sport,
      v_booking.start_at, v_booking.end_at, v_booking.club_timezone, v_booking.status;
    return;
  end if;

  if v_cred.status = 'revoked' then
    return query select 'invalid'::text,
      'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name, v_booking.sport,
      v_booking.start_at, v_booking.end_at, v_booking.club_timezone, v_booking.status;
    return;
  end if;

  if v_cred.status = 'consumed' then
    return query select 'already_used'::text,
      'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name, v_booking.sport,
      v_booking.start_at, v_booking.end_at, v_booking.club_timezone, v_booking.status;
    return;
  end if;

  if v_cred.expires_at is not null and v_cred.expires_at < now() then
    return query select 'expired'::text,
      'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name, v_booking.sport,
      v_booking.start_at, v_booking.end_at, v_booking.club_timezone, v_booking.status;
    return;
  end if;

  return query select 'valid'::text,
    'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name, v_booking.sport,
    v_booking.start_at, v_booking.end_at, v_booking.club_timezone, v_booking.status;
end;
$$;

revoke execute on function public.verify_booking_qr_public(text) from public;
grant execute on function public.verify_booking_qr_public(text) to anon, authenticated;

comment on function public.verify_booking_qr_public(text) is
  'PUBLIC, anon-callable, read-only booking-QR verification lookup opened from a WhatsApp link. Returns result in (valid|expired|cancelled|already_used|invalid) per the actual credential+booking state -- never mutates anything, never writes qr_scan_events (that stays scoped to real staff scan actions via qr_validate/qr_confirm_checkin). Payload is deliberately narrow: booking_ref, field_name, sport, start_at/end_at/timezone, booking_status -- never customer name/phone/email/internal IDs, matching verify_invoice_public()''s exact security posture.';

-- ============================================================
-- verify_invoice_public(): additive extension -- adds paid/outstanding
-- (directive rule 6 wants Amount/Paid/Outstanding, not just total) and
-- customer_name/booking_ref/field_name (directive rule 6: Customer,
-- Booking reference, Venue/field). Still never exposes phone/email/
-- internal IDs/line items. This link is only ever reached by the
-- customer themselves via their own WhatsApp message (not a random
-- QR-scanner-in-the-wild scenario for booking invoices the way the
-- printed-receipt case is), so showing their own name back to them is
-- correct, not an over-exposure -- the original narrower version stays
-- exactly as safe for the printed-receipt path since result/invoice_number/
-- issued_at/total/payment_status are all still returned unchanged, this
-- only ADDS columns.
-- ============================================================
-- Postgres requires an explicit DROP before a return-type change (new
-- OUT columns added) -- CREATE OR REPLACE alone is rejected for this
-- case. Safe: this function is a pure lookup with no dependent views/
-- triggers, only client callers (VerifyInvoicePage), which are
-- updated in the same directive to read the new columns.
drop function if exists public.verify_invoice_public(text);

create function public.verify_invoice_public(p_token text)
returns table(
  result text,
  invoice_number text,
  issued_at timestamptz,
  total numeric,
  paid numeric,
  outstanding numeric,
  payment_status text,
  customer_name text,
  booking_ref text,
  field_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token_hash text;
  v_vt record;
  v_inv record;
  v_summary record;
  v_customer_name text;
  v_booking_ref text;
  v_field_name text;
begin
  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_vt from public.invoice_verification_tokens where token_hash = v_token_hash;

  if v_vt.id is null or v_vt.status <> 'active' then
    return query select 'invalid'::text, null::text, null::timestamptz, null::numeric, null::numeric, null::numeric, null::text, null::text, null::text, null::text;
    return;
  end if;

  select * into v_inv from public.invoices where id = v_vt.invoice_id;
  if v_inv.id is null then
    return query select 'invalid'::text, null::text, null::timestamptz, null::numeric, null::numeric, null::numeric, null::text, null::text, null::text, null::text;
    return;
  end if;

  select * into v_summary from public.get_invoice_payment_summary(array[v_inv.id]::uuid[]);

  select c.full_name into v_customer_name from public.customers c where c.id = v_inv.customer_id;

  select 'MB-' || upper(substring(b.id::text, 1, 8)), f.name
    into v_booking_ref, v_field_name
    from public.bookings b
    join public.fields f on f.id = b.field_id
    where b.invoice_id = v_inv.id
    limit 1;

  return query
    select 'success'::text, v_inv.invoice_number, v_inv.issued_at, v_inv.total,
           coalesce(v_summary.paid, 0), coalesce(v_summary.outstanding, v_inv.total),
           coalesce(v_summary.payment_status, 'unpaid'),
           v_customer_name, v_booking_ref, v_field_name;
end;
$$;

revoke execute on function public.verify_invoice_public(text) from public, anon, authenticated;
grant execute on function public.verify_invoice_public(text) to anon, authenticated;

comment on function public.verify_invoice_public(text) is
  'PUBLIC, anon-callable, read-only invoice verification lookup. Extended (WhatsApp secure links directive) to also return paid/outstanding/customer_name/booking_ref/field_name -- still never phone/email/internal IDs/line items. A void invoice verifies honestly as its own payment_status (never silently "not found"). Never mutates any row.';

-- ============================================================
-- cancel_booking(): directive rule 3 -- explicitly revoke the
-- booking's active QR credential at cancellation time (not just rely
-- on qr_validate's defense-in-depth check above). Full body preserved
-- from 20260817124918 (the latest prior version, with enrichment
-- variables) -- only the new revoke statement is added.
-- ============================================================
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_customer_id uuid;
  v_field_id uuid;
  v_field_name text;
  v_sport text;
  v_start_at timestamptz;
  v_event_id uuid;
  v_club_name text;
  v_customer_name text;
  v_timezone text;
  v_booking_ref text;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancellation reason is required';
  end if;

  select club_id, customer_id, field_id, start_at into v_club_id, v_customer_id, v_field_id, v_start_at
  from public.bookings where id = p_booking_id;
  if v_club_id is null then
    raise exception 'booking not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.cancel', v_club_id)) then
    raise exception 'not authorized';
  end if;

  update public.bookings
  set status = 'cancelled', cancelled_reason = p_reason, cancelled_by = auth.uid(), cancelled_at = now()
  where id = p_booking_id and status in ('pending_payment', 'confirmed');

  if not found then
    raise exception 'booking not found or not in a cancellable state';
  end if;

  -- Directive rule 3: any active QR credential for this booking is
  -- revoked immediately on cancellation -- belt-and-suspenders with
  -- qr_validate's own booking-status check above (a credential minted
  -- via a future code path that forgets to call this RPC would still
  -- read as invalid at scan/verify time either way).
  update public.qr_credentials
  set status = 'revoked'
  where type = 'booking' and reference_id = p_booking_id and status = 'active';

  perform public.write_audit_log(v_club_id, 'cancel_booking', 'bookings', p_booking_id, null, jsonb_build_object('status', 'cancelled'), p_reason);

  select name, sport into v_field_name, v_sport from public.fields where id = v_field_id;
  select name into v_club_name from public.clubs where id = v_club_id;
  select full_name into v_customer_name from public.customers where id = v_customer_id;
  select timezone into v_timezone from public.clubs where id = v_club_id;
  v_booking_ref := 'MB-' || upper(substring(p_booking_id::text, 1, 8));

  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.cancelled', 'booking', p_booking_id,
    jsonb_build_object('customer_id', v_customer_id, 'reason', p_reason, 'start_at', v_start_at)
  );

  -- Directive rule 11: BOOKING_CANCELLED never sends a valid QR --
  -- confirmed no qr link variable is added to this payload (booking_ref
  -- only, same as before).
  perform public.queue_whatsapp_notification(
    v_club_id, v_event_id, v_customer_id, 'booking-cancelled', 'booking_confirmations',
    jsonb_build_object(
      'field_name', coalesce(v_field_name, ''), 'sport', v_sport, 'start_at', v_start_at, 'reason', p_reason,
      'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref
    ),
    'transactional', 'booking.cancelled:' || p_booking_id::text
  );

  perform public.cancel_pending_whatsapp_for_booking(p_booking_id);
end;
$$;

revoke execute on function public.cancel_booking(uuid, text) from public;
revoke execute on function public.cancel_booking(uuid, text) from anon;

-- ============================================================
-- _create_booking_internal(): mint a booking QR token for the
-- booking-created message (directive rule 1) and, on the
-- record-payment-at-creation path, refresh it for booking-confirmed
-- (same token/credential family, minted once per state transition --
-- not re-minted needlessly per directive rule 15). Also mints an
-- invoice token for the payment-received message on that same path
-- (directive rule 5/12). Full body preserved from 20260817124918 --
-- only the two new local variables and the two new mint calls +
-- payload keys are added.
-- ============================================================
create or replace function public._create_booking_internal(
  p_field_id uuid,
  p_customer_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_discount_amount numeric,
  p_notes text,
  p_record_payment boolean,
  p_payment_amount numeric,
  p_payment_method text,
  p_booking_series_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_field record;
  v_timezone text;
  v_local_date date;
  v_local_start_time time;
  v_local_end_time time;
  v_price_per_hour numeric;
  v_hours numeric;
  v_total_price numeric;
  v_booking_id uuid;
  v_invoice_id uuid;
  v_invoice_number text;
  v_payment_id uuid;
  v_hours_row record;
  v_event_id uuid;
  v_club_name text;
  v_customer_name text;
  v_booking_ref text;
  v_qr_token text;
  v_invoice_token text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id, branch_id into v_club_id, v_branch_id from public.fields where id = p_field_id;
  if v_club_id is null then
    raise exception 'field not found';
  end if;
  select * into v_field from public.fields where id = p_field_id;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.create', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = v_club_id) then
    raise exception 'customer not found in this club';
  end if;

  if p_booking_series_id is not null and not exists (
    select 1 from public.booking_series
    where id = p_booking_series_id
      and club_id = v_club_id
      and field_id = p_field_id
      and customer_id = p_customer_id
  ) then
    raise exception 'booking series does not match this club/field/customer';
  end if;

  if p_end_at <= p_start_at then
    raise exception 'end time must be after start time';
  end if;

  select timezone into v_timezone from public.clubs where id = v_club_id;
  if v_timezone is null then
    raise exception 'club has no timezone configured';
  end if;

  v_local_date := (p_start_at at time zone v_timezone)::date;
  v_local_start_time := (p_start_at at time zone v_timezone)::time;
  v_local_end_time := (p_end_at at time zone v_timezone)::time;

  if v_local_date <> ((p_end_at - interval '1 second') at time zone v_timezone)::date then
    raise exception 'a booking cannot span more than one calendar day';
  end if;

  select * into v_hours_row from public.resolve_field_operating_hours(p_field_id, v_local_date);
  if v_hours_row.has_any_config and v_hours_row.open_time is null then
    raise exception 'field is closed on this day';
  end if;
  if v_hours_row.has_any_config and (v_local_start_time < v_hours_row.open_time or v_local_end_time > v_hours_row.close_time) then
    raise exception 'booking time is outside the field''s operating hours (% - %)', v_hours_row.open_time, v_hours_row.close_time;
  end if;

  if exists (
    select 1 from public.field_blocks
    where field_id = p_field_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    raise exception 'field is blocked during this time';
  end if;

  v_price_per_hour := public.resolve_field_price(
    p_field_id, v_local_date, v_local_start_time, v_local_end_time
  );
  v_hours := extract(epoch from (p_end_at - p_start_at)) / 3600.0;
  v_total_price := round(v_price_per_hour * v_hours, 2);

  if p_discount_amount > 0 then
    if not public.has_permission('booking.discount.apply', v_club_id) then
      raise exception 'not authorized to apply a discount';
    end if;
    if p_discount_amount > v_total_price * 0.3 and not public.has_permission('booking.discount.override', v_club_id) then
      raise exception 'discount exceeds the standard limit -- requires override permission';
    end if;
  end if;

  insert into public.bookings (
    club_id, branch_id, field_id, customer_id, start_at, end_at,
    status, total_price, discount_amount, notes, booking_series_id, created_by
  ) values (
    v_club_id, v_branch_id, p_field_id, p_customer_id, p_start_at, p_end_at,
    'pending_payment', v_total_price, p_discount_amount, p_notes, p_booking_series_id, auth.uid()
  ) returning id into v_booking_id;

  perform public.write_audit_log(
    v_club_id, 'booking.create', 'booking', v_booking_id, null,
    jsonb_build_object('field_id', p_field_id, 'customer_id', p_customer_id, 'total_price', v_total_price, 'discount_amount', p_discount_amount),
    null
  );

  if p_discount_amount > 0 then
    perform public.write_audit_log(
      v_club_id, 'booking.discount.apply', 'booking', v_booking_id, null,
      jsonb_build_object('discount_amount', p_discount_amount, 'total_price', v_total_price),
      null
    );
  end if;

  v_invoice_number := public.issue_invoice_number(v_branch_id, v_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch_id, v_invoice_number, p_customer_id, 'issued', v_total_price, p_discount_amount, v_total_price - p_discount_amount, now(), auth.uid())
  returning id into v_invoice_id;

  perform public.write_audit_log(
    v_club_id, 'invoice.issue', 'invoice', v_invoice_id, null,
    jsonb_build_object('invoice_number', v_invoice_number, 'total', v_total_price - p_discount_amount),
    null
  );

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ' || v_field.name, 'booking', v_booking_id, v_hours, v_price_per_hour, v_total_price - p_discount_amount);

  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;

  select name, full_name into v_club_name, v_customer_name from public.clubs, public.customers
    where public.clubs.id = v_club_id and public.customers.id = p_customer_id;
  v_booking_ref := 'MB-' || upper(substring(v_booking_id::text, 1, 8));

  -- Directive rule 1/2: mint the booking QR token now (same lifecycle
  -- ensure_booking_qr() itself uses -- single_use, expires end_at + 2h)
  -- so the very first WhatsApp message already carries a working link,
  -- instead of only the customer's own later PortalQrPage visit
  -- minting one on demand.
  v_qr_token := public._mint_booking_qr_token_internal(v_booking_id, v_club_id, p_end_at + interval '2 hours', auth.uid());

  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.created', 'booking', v_booking_id,
    jsonb_build_object('field_name', v_field.name, 'customer_id', p_customer_id, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price)
  );

  perform public.queue_whatsapp_notification(
    v_club_id, v_event_id, p_customer_id, 'booking-created', 'booking_confirmations',
    jsonb_build_object(
      'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
      'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid',
      'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
      'booking_qr_token', v_qr_token
    ),
    'transactional', 'booking.created:' || v_booking_id::text
  );

  if p_record_payment and p_payment_amount is not null and p_payment_amount > 0 then
    if not public.has_permission('payment.create', v_club_id) then
      raise exception 'not authorized to record a payment';
    end if;

    insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by)
    values (v_club_id, v_branch_id, p_customer_id, coalesce(p_payment_method, 'cash'), p_payment_amount, auth.uid())
    returning id into v_payment_id;

    perform public.write_audit_log(
      v_club_id, 'payment.record', 'payment', v_payment_id, null,
      jsonb_build_object('amount', p_payment_amount, 'method', coalesce(p_payment_method, 'cash'), 'invoice_id', v_invoice_id),
      null
    );

    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, v_invoice_id, least(p_payment_amount, v_total_price - p_discount_amount));

    update public.bookings set status = 'confirmed' where id = v_booking_id;

    v_event_id := public.emit_notification_event(
      v_club_id, 'booking.confirmed', 'booking', v_booking_id,
      jsonb_build_object('field_name', v_field.name, 'customer_id', p_customer_id, 'start_at', p_start_at, 'end_at', p_end_at)
    );

    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'booking-confirmed', 'booking_confirmations',
      jsonb_build_object(
        'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price,
        'invoice_number', v_invoice_number, 'payment_status', 'paid',
        'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
        'booking_qr_token', v_qr_token
      ),
      'transactional', 'booking.confirmed:' || v_booking_id::text
    );

    -- Directive rule 5/12: mint an invoice token for payment-received.
    v_invoice_token := public._mint_invoice_token_internal(v_invoice_id, v_club_id, auth.uid());

    v_event_id := public.emit_notification_event(
      v_club_id, 'payment.received', 'payment', v_payment_id,
      jsonb_build_object('amount', p_payment_amount, 'method', coalesce(p_payment_method, 'cash'), 'customer_id', p_customer_id, 'invoice_id', v_invoice_id)
    );

    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'payment-received', 'payment_confirmations',
      jsonb_build_object(
        'amount', p_payment_amount, 'invoice_number', v_invoice_number, 'payment_status', 'paid', 'method', coalesce(p_payment_method, 'cash'),
        'club_name', v_club_name, 'customer_name', v_customer_name, 'booking_ref', v_booking_ref,
        'invoice_token', v_invoice_token
      ),
      'transactional', 'payment.received:' || v_payment_id::text
    );
  end if;

  return v_booking_id;
end;
$$;

-- ============================================================
-- record_payment(): mint (or reuse) an invoice token for the
-- payment-received message (directive rule 5/12). Full body preserved
-- from 20260817124918 -- only the new local variable and mint call +
-- payload key are added.
-- ============================================================
create or replace function public.record_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice record;
  v_payment_id uuid;
  v_pending_subscription_id uuid;
  v_outstanding numeric;
  v_event_id uuid;
  v_new_outstanding numeric;
  v_pending_booking_id uuid;
  v_club_name text;
  v_customer_name text;
  v_booking_ref text;
  v_invoice_token text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if p_method not in ('cash', 'card', 'bank_transfer', 'wallet', 'other') then
    raise exception 'invalid method';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id;
  if v_invoice is null then
    raise exception 'invoice not found';
  end if;

  if not (v_invoice.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_invoice.club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_invoice.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  if v_invoice.status != 'issued' then
    raise exception 'can only record payment against an issued invoice';
  end if;

  select v_invoice.total
    - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = v_invoice.id), 0)
    + coalesce((select sum(r.amount) from public.payment_allocations pa
                join public.refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
                where pa.invoice_id = v_invoice.id), 0)
  into v_outstanding;

  if p_amount > v_outstanding then
    raise exception 'payment amount (%) exceeds the invoice''s outstanding balance (%)', p_amount, v_outstanding;
  end if;

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by)
  values (v_invoice.club_id, v_invoice.branch_id, v_invoice.customer_id, p_method, p_amount, p_reference, auth.uid())
  returning id into v_payment_id;

  perform public.write_audit_log(
    v_invoice.club_id, 'payment.record', 'payment', v_payment_id, null,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'invoice_id', p_invoice_id),
    null
  );

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, p_invoice_id, p_amount);

  select id into v_pending_subscription_id from public.subscriptions
  where invoice_id = p_invoice_id and status = 'pending'
  limit 1;

  if v_pending_subscription_id is not null then
    perform public._activate_subscription_if_due_internal(v_pending_subscription_id);
  end if;

  v_new_outstanding := greatest(v_outstanding - p_amount, 0);

  if v_new_outstanding <= 0 then
    select id into v_pending_booking_id from public.bookings
    where invoice_id = p_invoice_id and status = 'pending_payment'
    limit 1;

    if v_pending_booking_id is not null then
      update public.bookings set status = 'confirmed' where id = v_pending_booking_id;

      perform public.write_audit_log(
        v_invoice.club_id, 'booking.auto_confirmed_on_full_payment', 'bookings', v_pending_booking_id, null,
        jsonb_build_object('invoice_id', p_invoice_id, 'triggering_payment_id', v_payment_id),
        null
      );
    end if;
  end if;

  select name into v_club_name from public.clubs where id = v_invoice.club_id;
  select full_name into v_customer_name from public.customers where id = v_invoice.customer_id;
  select 'MB-' || upper(substring(id::text, 1, 8)) into v_booking_ref
    from public.bookings where invoice_id = p_invoice_id limit 1;

  -- Directive rule 5/12/15: mint (revoke-and-reissue) an invoice token
  -- for this payment-received message. Deliberately re-minted on every
  -- payment event rather than reused across the invoice's lifetime --
  -- each payment-received message should carry a link that's provably
  -- fresh for THIS event, and ensure_invoice_qr()'s own idempotency
  -- rule (at most one ACTIVE token at a time) is preserved either way;
  -- this is not "unnecessary re-minting on retry" (directive rule 15)
  -- since it happens once per genuine new payment event, not on
  -- notification retry/resend (a stuck/retried queue row reuses its
  -- already-queued variables, it does not re-invoke this RPC).
  v_invoice_token := public._mint_invoice_token_internal(p_invoice_id, v_invoice.club_id, auth.uid());

  v_event_id := public.emit_notification_event(
    v_invoice.club_id, 'payment.received', 'payment', v_payment_id,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'customer_id', v_invoice.customer_id, 'invoice_id', p_invoice_id, 'remaining_outstanding', v_new_outstanding)
  );

  perform public.queue_whatsapp_notification(
    v_invoice.club_id, v_event_id, v_invoice.customer_id, 'payment-received', 'payment_confirmations',
    jsonb_build_object(
      'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
      'payment_status', case when v_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
      'remaining_outstanding', v_new_outstanding, 'method', p_method,
      'club_name', v_club_name, 'customer_name', v_customer_name, 'booking_ref', v_booking_ref,
      'invoice_token', v_invoice_token
    ),
    'transactional', 'payment.received:' || v_payment_id::text
  );

  return v_payment_id;
end;
$$;

revoke execute on function public.record_payment(uuid, numeric, text, text) from public;
revoke execute on function public.record_payment(uuid, numeric, text, text) from anon;
grant execute on function public.record_payment(uuid, numeric, text, text) to authenticated;
