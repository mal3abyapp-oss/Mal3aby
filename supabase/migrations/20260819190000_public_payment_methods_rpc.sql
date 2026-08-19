-- MAL3ABY PRODUCT/UX/BOOKING/PAYMENT DIRECTIVE -- Part 4: payment
-- methods for the public booking success / Secure Booking screens.
--
-- payment_method_configs already has correct RLS (staff full access,
-- authenticated-customer-with-linked-account read of their own club's
-- active+visible methods) -- but a GUEST public-booking customer has no
-- authenticated session at all, so neither policy applies. Rather than
-- widen RLS to all of anon (which would let anyone enumerate any
-- club's payment details just by guessing a club_id, with no proof
-- they have a real booking there), this RPC requires a real booking_id
-- and only returns methods for that booking's own club -- the
-- directive's own "Secure Booking: show actual receiving details FOR
-- THE BOOKING, Public Club Page: names only if needed" security
-- posture, applied at the RPC layer.
create or replace function public.get_public_payment_methods_for_booking(p_booking_id uuid)
returns table(
  id uuid,
  underlying_method text,
  provider text,
  name_ar text,
  name_en text,
  instructions_ar text,
  instructions_en text,
  details jsonb,
  reference_required boolean,
  proof_required boolean,
  display_order int
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select pmc.id, pmc.underlying_method, pmc.provider, pmc.name_ar, pmc.name_en,
         pmc.instructions_ar, pmc.instructions_en, pmc.details, pmc.reference_required,
         pmc.proof_required, pmc.display_order
  from public.payment_method_configs pmc
  join public.bookings b on b.club_id = pmc.club_id
  where b.id = p_booking_id
    and pmc.is_active = true
    and pmc.customer_visible = true
  order by pmc.display_order;
$$;

revoke all on function public.get_public_payment_methods_for_booking(uuid) from public;
grant execute on function public.get_public_payment_methods_for_booking(uuid) to anon, authenticated;

-- Also expose the club's payment-receipt WhatsApp number for this
-- exact booking (never the club's general contact -- directive:
-- "Payment Receipt: يستخدم CLUB PAYMENT RECEIPT WHATSAPP" specifically,
-- falling back to the club's general WhatsApp number only if no
-- dedicated receipt number was configured, per the directive's own
-- "may be the same number" allowance).
create or replace function public.get_public_booking_receipt_contact(p_booking_id uuid)
returns table(payment_receipt_whatsapp_number text, whatsapp_number text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select c.payment_receipt_whatsapp_number, c.whatsapp_number
  from public.bookings b
  join public.clubs c on c.id = b.club_id
  where b.id = p_booking_id;
$$;

revoke all on function public.get_public_booking_receipt_contact(uuid) from public;
grant execute on function public.get_public_booking_receipt_contact(uuid) to anon, authenticated;
