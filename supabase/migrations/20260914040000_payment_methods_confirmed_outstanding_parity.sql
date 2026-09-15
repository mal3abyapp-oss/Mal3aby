-- FULL-PLATFORM AUDIT ROUND 2 FIX (2026-09-14): get_public_booking_context()'s
-- can_pay flag (20260913084547_booking_resume_payment_context.sql) was
-- deliberately widened to cover a CONFIRMED booking with an outstanding
-- balance (invoice_id not null, status in pending_payment/confirmed) --
-- e.g. a confirmed booking that was later partially refunded (goodwill,
-- not return-driven) and still owes money. But
-- get_public_payment_methods_for_booking() was never updated to match:
-- it still gates strictly on status = 'pending_payment', so a
-- confirmed-with-outstanding booking (can_pay=true per the frontend)
-- always got zero payment method rows back, rendering "no payment
-- methods available" with no way to pay, contradicting the flag that
-- told the customer they could.
--
-- Fix: allow 'confirmed' through this RPC too, but ONLY when the
-- booking's invoice genuinely has outstanding > 0 -- computed via
-- get_invoice_payment_summary(), the SAME canonical financial source
-- verify_booking_qr_public()/Reports/Billing already use (never
-- recomputed independently, per that function's own documented
-- convention) -- not just loosening the status check on its own,
-- which would re-expose payment details for a fully-paid confirmed
-- booking with no reason to see them.
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
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_booking record;
  v_outstanding numeric;
begin
  select b.id, b.club_id, b.status, b.invoice_id into v_booking
    from public.bookings b where b.id = p_booking_id;

  if v_booking.id is null then
    return;
  end if;

  if v_booking.status = 'pending_payment' then
    -- unchanged fast path, no invoice lookup needed
    return query
      select pmc.id, pmc.underlying_method, pmc.provider, pmc.name_ar, pmc.name_en,
             pmc.instructions_ar, pmc.instructions_en, pmc.details, pmc.reference_required,
             pmc.proof_required, pmc.display_order
      from public.payment_method_configs pmc
      where pmc.club_id = v_booking.club_id
        and pmc.is_active = true
        and pmc.customer_visible = true
      order by pmc.display_order;
    return;
  end if;

  if v_booking.status = 'confirmed' and v_booking.invoice_id is not null then
    select s.outstanding into v_outstanding
      from public.get_invoice_payment_summary(array[v_booking.invoice_id]::uuid[]) s;

    if coalesce(v_outstanding, 0) > 0 then
      return query
        select pmc.id, pmc.underlying_method, pmc.provider, pmc.name_ar, pmc.name_en,
               pmc.instructions_ar, pmc.instructions_en, pmc.details, pmc.reference_required,
               pmc.proof_required, pmc.display_order
        from public.payment_method_configs pmc
        where pmc.club_id = v_booking.club_id
          and pmc.is_active = true
          and pmc.customer_visible = true
        order by pmc.display_order;
    end if;
  end if;

  return;
end;
$$;

comment on function public.get_public_payment_methods_for_booking(uuid) is
  'Anon-safe: scoped to one booking''s own club. Allows pending_payment (active payment flow) and confirmed-with-a-real-outstanding-balance (e.g. after a goodwill partial refund reopened an amount owed on an already-confirmed booking, per get_invoice_payment_summary -- the same canonical outstanding computation verify_booking_qr_public()/Reports/Billing use) -- matching get_public_booking_context()''s can_pay flag exactly. A fully-paid confirmed booking, or any cancelled/no_show/completed booking, still returns zero rows: defense-in-depth, since booking_id carries no independent secret factor.';
