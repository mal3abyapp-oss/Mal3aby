-- Gate 3 (Unified Accounts / My QR): ensure_booking_qr() only ever
-- authorized staff with booking.view -- discovered while building the
-- self-service "My QR" portal screen that a real customer, having no
-- club_memberships row at all, would ALWAYS fail this check for their
-- own booking, making self-service QR generation impossible. This is
-- exactly the kind of bug this session's own Gate 1/2 work already
-- established a pattern for: a permission check written with only the
-- staff persona in mind, silently breaking the customer persona.
--
-- Fix: authorize the caller if EITHER they hold staff booking.view
-- permission for the club OR the booking's own customer_id is linked
-- (customers.user_id) to their auth.uid() -- i.e. they own the booking
-- themselves.
create or replace function public.ensure_booking_qr(p_booking_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
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
