-- Secure Booking Page (directive Sections 28-32): the WhatsApp link
-- (bookingQrUrl(), already the message's leading link) must open a
-- COMPREHENSIVE page -- Club, Field, Sport, Date, Time, Booking
-- reference, Booking status, Payment summary, QR, full-screen QR --
-- not just the current minimal attendance-status card. This migration
-- extends verify_booking_qr_public() with the additional fields the
-- page needs, reusing get_invoice_payment_summary() (the same
-- canonical financial source of truth verify_invoice_public()/Reports/
-- Billing already use) rather than recomputing payment figures
-- independently.
--
-- Additive only: every existing column stays in the same position with
-- the same meaning (VerifyInvoicePage-style callers reading only the
-- original columns are unaffected) -- Postgres requires a DROP before
-- adding new OUT columns to an existing function, done here safely
-- since this is a pure lookup function with no dependent views/triggers.
drop function if exists public.verify_booking_qr_public(text);

create function public.verify_booking_qr_public(p_token text)
returns table(
  result text,
  booking_ref text,
  field_name text,
  sport text,
  start_at timestamptz,
  end_at timestamptz,
  timezone text,
  booking_status text,
  club_name text,
  branch_name text,
  customer_name text,
  total numeric,
  paid numeric,
  outstanding numeric,
  payment_status text,
  invoice_token_available boolean
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_token_hash text;
  v_cred record;
  v_booking record;
  v_summary record;
  v_branch_name text;
  v_customer_name text;
  v_invoice_token_available boolean;
begin
  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash and type = 'booking';

  if v_cred.id is null then
    return query select 'invalid'::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::text, null::text,
      null::text, null::text, null::text, null::numeric, null::numeric, null::numeric, null::text, null::boolean;
    return;
  end if;

  select b.*, f.name as field_name, f.sport as sport, cl.timezone as club_timezone, cl.name as club_name
    into v_booking
    from public.bookings b
    join public.fields f on f.id = b.field_id
    join public.clubs cl on cl.id = b.club_id
    where b.id = v_cred.reference_id;

  if v_booking.id is null then
    return query select 'invalid'::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::text, null::text,
      null::text, null::text, null::text, null::numeric, null::numeric, null::numeric, null::text, null::boolean;
    return;
  end if;

  select br.name into v_branch_name from public.branches br where br.id = v_booking.branch_id;
  select c.full_name into v_customer_name from public.customers c where c.id = v_booking.customer_id;

  -- Payment summary via the booking's own invoice, using the exact
  -- same canonical function as verify_invoice_public()/Reports/Billing
  -- -- never recomputed independently here.
  if v_booking.invoice_id is not null then
    select * into v_summary from public.get_invoice_payment_summary(array[v_booking.invoice_id]::uuid[]);
  end if;

  v_invoice_token_available := v_booking.invoice_id is not null and exists (
    select 1 from public.invoice_verification_tokens
    where invoice_id = v_booking.invoice_id and status = 'active'
  );

  -- Directive rule 3 & 4 (preserved unchanged): cancelled/no-show
  -- booking, a revoked credential, or an expired credential all read
  -- as their own honest non-success state -- now also carrying the
  -- full booking/payment context so the page can show what happened,
  -- not just that it failed.
  if v_booking.status in ('cancelled', 'no_show') then
    return query select 'cancelled'::text,
      'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name, v_booking.sport,
      v_booking.start_at, v_booking.end_at, v_booking.club_timezone, v_booking.status,
      v_booking.club_name, v_branch_name, v_customer_name,
      v_summary.total, v_summary.paid, v_summary.outstanding, v_summary.payment_status, v_invoice_token_available;
    return;
  end if;

  if v_cred.status = 'revoked' then
    return query select 'invalid'::text,
      'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name, v_booking.sport,
      v_booking.start_at, v_booking.end_at, v_booking.club_timezone, v_booking.status,
      v_booking.club_name, v_branch_name, v_customer_name,
      v_summary.total, v_summary.paid, v_summary.outstanding, v_summary.payment_status, v_invoice_token_available;
    return;
  end if;

  if v_cred.status = 'consumed' then
    return query select 'already_used'::text,
      'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name, v_booking.sport,
      v_booking.start_at, v_booking.end_at, v_booking.club_timezone, v_booking.status,
      v_booking.club_name, v_branch_name, v_customer_name,
      v_summary.total, v_summary.paid, v_summary.outstanding, v_summary.payment_status, v_invoice_token_available;
    return;
  end if;

  if v_cred.expires_at is not null and v_cred.expires_at < now() then
    return query select 'expired'::text,
      'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name, v_booking.sport,
      v_booking.start_at, v_booking.end_at, v_booking.club_timezone, v_booking.status,
      v_booking.club_name, v_branch_name, v_customer_name,
      v_summary.total, v_summary.paid, v_summary.outstanding, v_summary.payment_status, v_invoice_token_available;
    return;
  end if;

  return query select 'valid'::text,
    'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name, v_booking.sport,
    v_booking.start_at, v_booking.end_at, v_booking.club_timezone, v_booking.status,
    v_booking.club_name, v_branch_name, v_customer_name,
    v_summary.total, v_summary.paid, v_summary.outstanding, v_summary.payment_status, v_invoice_token_available;
end;
$$;

revoke execute on function public.verify_booking_qr_public(text) from public, anon, authenticated;
grant execute on function public.verify_booking_qr_public(text) to anon, authenticated;

comment on function public.verify_booking_qr_public(text) is
  'PUBLIC, anon-callable, read-only booking-QR verification lookup opened from the WhatsApp Secure Booking Link (directive Sections 28-32) -- now the PRIMARY page a customer lands on, not just an attendance-QR status check. Returns result in (valid|expired|cancelled|already_used|invalid) plus club_name/branch_name/customer_name/payment summary (via get_invoice_payment_summary(), the canonical financial source, never recomputed here) and whether a still-active invoice token exists (so the page can offer an invoice link without exposing the token itself). customer_name is included matching verify_invoice_public()''s exact precedent (this link is only ever reached by the customer themselves via their own WhatsApp message, so showing their own name back to them is correct, not an over-exposure) -- still never exposes phone/email/internal IDs. Never mutates anything, never writes qr_scan_events.';
