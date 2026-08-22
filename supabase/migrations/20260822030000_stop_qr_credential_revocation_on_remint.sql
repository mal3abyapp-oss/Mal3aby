-- WHATSAPP BUSINESS MESSAGING FINAL HARDENING (2026-08-22), Section 22
-- ("QR MUST NOT ROTATE WITHOUT REASON"): confirmed real bug, via direct
-- source inspection of both _mint_booking_qr_token_internal() and
-- ensure_booking_qr(): every single call unconditionally revoked the
-- booking's currently-active qr_credentials row before minting a new
-- one, with no check for whether a valid credential already existed.
--
-- Concretely: a customer receives a secure booking link via WhatsApp
-- (minted once at booking-create/payment time). If a STAFF MEMBER later
-- opens that booking's detail sheet and clicks "Show QR" (a real,
-- routine staff action -- e.g. to check the customer in manually while
-- looking at the booking), or the SAME customer separately opens their
-- own authenticated portal QR page for the same booking,
-- ensure_booking_qr() silently revokes the credential already sent via
-- WhatsApp -- the customer's own saved/bookmarked WhatsApp link stops
-- working with zero warning to anyone, for a reason completely
-- unrelated to the link itself (no security event occurred; nothing
-- about the original credential was compromised).
--
-- The public verification page the WhatsApp link actually opens
-- (SecureBookingPage.tsx -> verify_booking_qr_public()) is READ-ONLY
-- and does not remint anything -- confirmed via direct source read, so
-- customers clicking their own WhatsApp link were never the trigger;
-- the bug was always cross-surface (a different viewing context
-- silently invalidating an earlier one).
--
-- Root cause of the "revoke first" design: presumably an assumption
-- that only one active credential per booking should exist at a time.
-- Confirmed via direct read of qr_confirm_checkin() (the real scan/
-- check-in consumption path) that this assumption is unnecessary for
-- correctness: it operates purely on the scanned credential's own row
-- (looked up by token_hash) and the booking's own current status --
-- scanning ANY currently-valid credential for a booking correctly
-- marks that credential 'consumed' and the booking 'checked_in'; any
-- OTHER still-active credential for the same booking, if scanned
-- afterward, is correctly rejected anyway because
-- qr_confirm_checkin() requires the booking's own status to still be
-- 'pending_payment'/'confirmed' (a booking already 'checked_in' fails
-- that check regardless of which credential is presented). So multiple
-- simultaneously-active credentials for the same booking are safe:
-- checking in via any one of them naturally invalidates the practical
-- usefulness of the others through the booking's own state transition,
-- without needing to explicitly revoke sibling rows.
--
-- Fix: both functions now mint a genuinely NEW credential on every
-- call (unchanged -- a fresh raw token must still be generated each
-- time, since the raw token is never persisted and cannot be recovered
-- from a stored hash to "return the same one again"), but WITHOUT
-- first revoking whatever credential(s) already exist for this
-- booking. Cancellation-triggered revocation (a genuine security-
-- relevant event) is unaffected -- that is handled by a separate,
-- unchanged code path (cancel_booking's own credential-invalidation
-- logic, if any, or the booking-status check in qr_confirm_checkin/
-- verify_booking_qr_public itself, both of which already correctly
-- reject a cancelled booking's credential regardless of its own
-- status).
create or replace function public._mint_booking_qr_token_internal(
  p_booking_id uuid,
  p_club_id uuid,
  p_expires_at timestamptz,
  p_created_by uuid
)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_raw_token text;
  v_token_hash text;
begin
  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  insert into public.qr_credentials (club_id, type, reference_id, token_hash, status, single_use, expires_at, created_by)
  values (p_club_id, 'booking', p_booking_id, v_token_hash, 'active', true, p_expires_at, p_created_by);

  return v_raw_token;
end;
$function$;

create or replace function public.ensure_booking_qr(p_booking_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_customer_id uuid;
  v_status text;
  v_raw_token text;
  v_token_hash text;
  v_is_owner boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id, status, customer_id into v_club_id, v_status, v_customer_id from public.bookings where id = p_booking_id;
  if v_club_id is null then
    raise exception 'booking not found';
  end if;

  select exists(
    select 1 from public.customers where id = v_customer_id and user_id = auth.uid()
  ) into v_is_owner;

  if not (
    (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.view', v_club_id))
    or v_is_owner
  ) then
    raise exception 'not authorized';
  end if;

  if v_status in ('cancelled', 'no_show') then
    raise exception 'cannot generate a QR for a cancelled or no-show booking';
  end if;

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  insert into public.qr_credentials (club_id, type, reference_id, token_hash, status, single_use, expires_at, created_by)
  values (v_club_id, 'booking', p_booking_id, v_token_hash, 'active', true, (select end_at from public.bookings where id = p_booking_id) + interval '2 hours', auth.uid());

  return v_raw_token;
end;
$function$;

-- Same bug, arguably more impactful: _mint_invoice_token_internal() is
-- called from record_payment() on EVERY payment recorded against an
-- invoice, including ordinary installment/partial payments -- a
-- routine, expected business flow, not an edge case. A customer who
-- receives an invoice link after their first partial payment finds it
-- broken the moment a second partial payment is recorded, purely
-- because a new token was minted and the old one revoked -- even
-- though both links point to the exact same invoice, and
-- verify_invoice_public() (confirmed via direct source read) is
-- purely read-only, always reflecting the invoice's CURRENT live
-- state regardless of which still-active token was used to reach it.
-- Multiple simultaneously-active invoice_verification_tokens for the
-- same invoice are unambiguously safe: there is no
-- consume-on-first-use semantics for invoice tokens at all (unlike
-- booking QR's check-in flow) -- every one of them just proves "this
-- person has a legitimate link to this invoice" and always renders
-- the same live data.
create or replace function public._mint_invoice_token_internal(
  p_invoice_id uuid,
  p_club_id uuid,
  p_created_by uuid
)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_raw_token text;
  v_token_hash text;
begin
  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  insert into public.invoice_verification_tokens (club_id, invoice_id, token_hash, status, created_by)
  values (p_club_id, p_invoice_id, v_token_hash, 'active', p_created_by);

  return v_raw_token;
end;
$function$;
