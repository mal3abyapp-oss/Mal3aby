-- AUDIT ROUND 2 FINDING #1: ActivateAccountPage.tsx's booking date/time
-- was formatted in the BROWSER's local timezone (`new Date(...).
-- toLocaleDateString()` / `toLocaleTimeString()` with no timeZone
-- option) instead of the club's own venue timezone -- unlike
-- SecureBookingPage.tsx, the staff calendar, and the WhatsApp message,
-- which all correctly resolve and format against the club's real IANA
-- timezone. Confirmed get_portal_invite_context() never returned a
-- timezone (or club_id) column at all (its only prior definition,
-- 20260823050000_customer_portal_zero_cost_activation.sql) -- there was
-- no club-scoped timezone value on the frontend for this screen to use.
--
-- Fix: widen the return table by exactly one column, the invite's own
-- club's timezone (public.clubs.timezone, the SAME column
-- get_public_booking_context()/get_my_portal_bookings() already resolve
-- for the identical purpose elsewhere in this codebase) -- resolved
-- once alongside the existing v_club_name lookup, no new join beyond
-- widening that same clubs SELECT. Body is otherwise unchanged; no
-- WHERE-clause/ownership-check/security-model change.
--
-- INTEGRATION FIX (2026-09-14): the original draft of this migration
-- used `create or replace function`, which Postgres rejects outright
-- when a RETURNS TABLE column list changes ("cannot change return
-- type of existing function... Use DROP FUNCTION first") -- confirmed
-- live via a rolled-back dry-run before this fix. Same DROP FUNCTION
-- + CREATE pattern already used correctly by the sibling
-- get_my_portal_qr_bookings widening for the identical reason.
drop function if exists public.get_portal_invite_context(text);

create function public.get_portal_invite_context(p_raw_token text)
returns table(
  customer_name text,
  club_name text,
  masked_phone text,
  status text,
  is_expired boolean,
  booking_field_name text,
  booking_start_at timestamptz,
  booking_end_at timestamptz,
  club_timezone text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invite record;
  v_customer record;
  v_club_name text;
  v_club_timezone text;
  v_field_name text;
  v_start_at timestamptz;
  v_end_at timestamptz;
begin
  if p_raw_token is null or length(p_raw_token) < 32 then
    raise exception 'invalid invite link';
  end if;

  select * into v_invite from public.portal_invites
  where token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex');

  if v_invite.id is null then
    raise exception 'invalid invite link';
  end if;

  select id, full_name, phone_e164 into v_customer from public.customers where id = v_invite.customer_id;
  select name, timezone into v_club_name, v_club_timezone from public.clubs where id = v_invite.club_id;

  if v_invite.triggering_booking_id is not null then
    select f.name, b.start_at, b.end_at into v_field_name, v_start_at, v_end_at
    from public.bookings b join public.fields f on f.id = b.field_id
    where b.id = v_invite.triggering_booking_id;
  end if;

  return query select
    -- First name only -- a light additional privacy step beyond what
    -- the amendment strictly requires, consistent with its own
    -- "مرحبًا مصطفى" example (a first name, not the full legal name).
    split_part(coalesce(v_customer.full_name, ''), ' ', 1),
    v_club_name,
    -- Mask everything except the last 3 digits: +201*********553 style.
    -- Section 8's own example masks the middle of a local-format
    -- number; this masks the E.164 form the same way, keeping only
    -- enough visible to let a genuine customer recognize their own
    -- number without letting an attacker holding just the link infer
    -- more than 3 digits of it.
    case when v_customer.phone_e164 is not null
      then left(v_customer.phone_e164, 3) || repeat('*', greatest(length(v_customer.phone_e164) - 6, 0)) || right(v_customer.phone_e164, 3)
      else null
    end,
    v_invite.status,
    v_invite.expires_at <= now(),
    v_field_name,
    v_start_at,
    v_end_at,
    v_club_timezone;
end;
$function$;

revoke all on function public.get_portal_invite_context(text) from public;
grant execute on function public.get_portal_invite_context(text) to anon;
grant execute on function public.get_portal_invite_context(text) to authenticated;
grant execute on function public.get_portal_invite_context(text) to service_role;
