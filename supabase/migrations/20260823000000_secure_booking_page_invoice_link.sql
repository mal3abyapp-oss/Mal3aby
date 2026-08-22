-- WHATSAPP BUSINESS MESSAGING / QR CHECK-IN LIFECYCLE HARDENING
-- (2026-08-23) -- real bug found while re-verifying the Secure Booking
-- Page during the mandated "test the existing QR button first" QR-
-- credential-contract investigation: the page's own "View Invoice"
-- link built `/verify/${token}` using the BOOKING QR token (the only
-- token the page's URL carries), but `/verify/:token` is the invoice-
-- verification route, which needs an INVOICE token from a completely
-- different table (invoice_verification_tokens, not qr_credentials).
-- Confirmed live: verify_invoice_public() called with a real booking
-- QR token returns result='invalid' every time -- this link has never
-- actually worked, regardless of the invoice's real state.
--
-- verify_booking_qr_public() could only ever return a boolean
-- (invoice_token_available) rather than the real invoice token,
-- because the raw invoice token is never persisted (hash-only
-- storage, same architecture as booking QR tokens) -- there is no
-- existing valid invoice token this RPC could hand back even if it
-- wanted to.
--
-- Fix: a new, narrowly-scoped public RPC. Possessing a currently-VALID
-- booking QR token is treated as sufficient proof of legitimate access
-- to that booking's own invoice (the same trust model
-- verify_booking_qr_public() itself already uses -- no login, just a
-- real, unguessable, unexpired, non-revoked credential) -- this
-- function re-validates the booking credential itself (status/
-- expiry/booking-status, mirroring verify_booking_qr_public()'s own
-- checks) before minting anything, so a cancelled/revoked/expired
-- booking credential can never be used to mint a fresh invoice link.
-- Reuses _mint_invoice_token_internal() (safe to call repeatedly now,
-- per migration 20260822060000 -- minting no longer revokes other
-- active tokens, including the one already sent via WhatsApp).
create or replace function public.mint_invoice_token_for_booking_qr(p_booking_qr_token text)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_token_hash text;
  v_cred record;
  v_booking record;
  v_raw_invoice_token text;
begin
  v_token_hash := encode(extensions.digest(p_booking_qr_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash and type = 'booking';
  if v_cred.id is null then
    raise exception 'invalid credential';
  end if;

  if v_cred.status = 'revoked' then
    raise exception 'credential revoked';
  end if;

  if v_cred.expires_at is not null and v_cred.expires_at < now() then
    raise exception 'credential expired';
  end if;

  select * into v_booking from public.bookings where id = v_cred.reference_id;
  if v_booking.id is null then
    raise exception 'booking not found';
  end if;

  if v_booking.status in ('cancelled', 'no_show') then
    raise exception 'booking is cancelled or no-show';
  end if;

  if v_booking.invoice_id is null then
    raise exception 'this booking has no invoice';
  end if;

  v_raw_invoice_token := public._mint_invoice_token_internal(v_booking.invoice_id, v_booking.club_id, null);

  return v_raw_invoice_token;
end;
$function$;

grant execute on function public.mint_invoice_token_for_booking_qr(text) to anon;
grant execute on function public.mint_invoice_token_for_booking_qr(text) to authenticated;
