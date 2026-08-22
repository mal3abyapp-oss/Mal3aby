-- QR CHECK-IN LIFECYCLE HARDENING (2026-08-23) -- "عرض رمز QR" inside
-- the customer-facing invoice verification page.
--
-- ARCHITECTURAL CONSTRAINT (confirmed, not assumed): VerifyInvoicePage.
-- tsx is deliberately a NO-LOGIN, anon-reachable page (verify_invoice_
-- public() is anon-granted by design, per its own doc comment). The
-- existing canonical mint RPC, ensure_booking_qr(p_booking_id), REQUIRES
-- auth.uid() (raises 'authentication required' otherwise) -- it can
-- never be called directly from this anonymous page. This is the same
-- real constraint already solved once this session for the "View
-- Invoice" button on SecureBookingPage.tsx (migration 20260823000000,
-- mint_invoice_token_for_booking_qr): possessing a currently-valid,
-- already-issued token is treated as sufficient proof of legitimate
-- access, mirroring verify_invoice_public()'s own no-login trust model
-- -- not a new authorization concept, the same one already accepted
-- for this exact page.
--
-- Also confirmed, and directly relevant to the directive's "no mint
-- just for clicking" instruction: qr_credentials stores ONLY
-- token_hash (sha256), never the raw token -- there is no way for any
-- RPC to "just look up and return" a previously-issued raw token, by
-- design (this is what makes the raw token safe to put in a WhatsApp
-- message/URL at all -- it can never be recovered from the DB even by
-- a compromised service_role session). A literal zero-mutation "view"
-- of an EXISTING credential's raw value is architecturally impossible.
-- ensure_booking_qr() (the two already-canonical surfaces --
-- BookingDetailSheet.tsx's staff button and PortalQrPage.tsx's
-- customer-portal page) already resolves this tension the same way:
-- mint a fresh credential on every open, but (per this session's
-- earlier fix, migration 20260822030000) NEVER revoke any sibling
-- credential -- so repeated opens are safe and non-destructive, even
-- though each open is technically one more INSERT. This function
-- follows the exact same, already-accepted pattern -- not a new or
-- looser one.
--
-- Real server-side chain enforced (directive item 4/11 -- never trust
-- a frontend-supplied booking_id): invoice token -> hash lookup ->
-- REAL invoice_id/club_id from invoice_verification_tokens -> REAL
-- booking row via bookings.invoice_id = that invoice_id (never a
-- second, independently-passed id) -> booking's own club_id used for
-- the credential (never the invoice's club_id blindly trusted without
-- this join, closing any cross-tenant path). Academy safety (item 5/F):
-- an invoice with NO linked booking (Academy/subscription invoice) is
-- explicitly and honestly reported as such -- never silently returns
-- an unrelated or wrong QR.
create or replace function public.get_booking_qr_for_invoice_token(p_invoice_token text)
returns table(status text, raw_token text, booking_ref text, field_name text, start_at timestamptz, end_at timestamptz, timezone text, booking_status text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_token_hash text;
  v_vt record;
  v_booking record;
  v_raw_token text;
begin
  v_token_hash := encode(extensions.digest(p_invoice_token, 'sha256'), 'hex');

  select * into v_vt from public.invoice_verification_tokens ivt where ivt.token_hash = v_token_hash and ivt.status = 'active';
  if v_vt.id is null then
    return query select 'invalid_invoice_token'::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
    return;
  end if;

  -- Real join, never a frontend-supplied booking_id -- this invoice's
  -- OWN linked booking, scoped to the SAME invoice_id the token itself
  -- resolved to.
  select b.*, f.name as field_name, cl.timezone as tz
    into v_booking
    from public.bookings b
    join public.fields f on f.id = b.field_id
    join public.clubs cl on cl.id = b.club_id
    where b.invoice_id = v_vt.invoice_id;

  if v_booking.id is null then
    -- Directive item 5/F: this invoice has no linked booking at all
    -- (an Academy/subscription invoice, or any other non-booking
    -- invoice) -- honestly reported, never a wrong/unrelated QR.
    return query select 'not_a_booking_invoice'::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::text, null::text;
    return;
  end if;

  if v_booking.status in ('cancelled', 'no_show') then
    return query select 'booking_cancelled'::text, null::text,
      'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name,
      v_booking.start_at, v_booking.end_at, v_booking.tz, v_booking.status;
    return;
  end if;

  if v_booking.status = 'checked_in' then
    return query select 'already_checked_in'::text, null::text,
      'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name,
      v_booking.start_at, v_booking.end_at, v_booking.tz, v_booking.status;
    return;
  end if;

  if v_booking.status not in ('pending_payment', 'confirmed') then
    return query select 'booking_not_eligible'::text, null::text,
      'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name,
      v_booking.start_at, v_booking.end_at, v_booking.tz, v_booking.status;
    return;
  end if;

  -- Mint via the SAME canonical primitive ensure_booking_qr()/
  -- _create_booking_internal() already use -- no duplicated token-
  -- generation logic. p_created_by is null (no real auth.uid() exists
  -- in this anonymous context), matching mint_invoice_token_for_
  -- booking_qr()'s identical precedent.
  v_raw_token := public._mint_booking_qr_token_internal(v_booking.id, v_booking.club_id, v_booking.end_at + interval '2 hours', null);

  return query select 'active'::text, v_raw_token,
    'MB-' || upper(substring(v_booking.id::text, 1, 8)), v_booking.field_name,
    v_booking.start_at, v_booking.end_at, v_booking.tz, v_booking.status;
end;
$function$;

revoke all on function public.get_booking_qr_for_invoice_token(text) from public;
revoke all on function public.get_booking_qr_for_invoice_token(text) from anon;
grant execute on function public.get_booking_qr_for_invoice_token(text) to anon;
grant execute on function public.get_booking_qr_for_invoice_token(text) to authenticated;
grant execute on function public.get_booking_qr_for_invoice_token(text) to service_role;
