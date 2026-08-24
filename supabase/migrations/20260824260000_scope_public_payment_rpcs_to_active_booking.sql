-- SECURITY FIX (confirmed-exploitable, low severity, verified live via
-- Supabase MCP execute_sql against project gxkrtlvpjwxhcqdisyob):
-- get_public_payment_methods_for_booking(), get_public_booking_receipt_
-- contact(), and get_public_payment_proof_status() -- all anon-callable,
-- security definer -- accept a bare booking_id with no independent
-- secret factor, unlike every sibling RPC on this same Secure Booking
-- surface (verify_booking_qr_public(), mint_invoice_token_for_booking_
-- qr(), get_booking_qr_for_invoice_token() all require a real token,
-- never a bare id). Confirmed live: `set role anon; select * from
-- get_public_payment_methods_for_booking('<real booking_id>')` returns
-- the club's live Instapay wallet phone + beneficiary name to anon.
--
-- booking_id is a full gen_random_uuid() (122 bits) never displayed on
-- any public/unauthenticated listing page -- create_public_booking()
-- returns it only into React useState (PublicClubBookingPage.tsx),
-- never into the URL -- so brute-force enumeration is computationally
-- infeasible, which is why this stays low severity rather than
-- high/critical. But the correct fix (requiring the same token the
-- sibling RPCs already use) needs create_public_booking() to return
-- and the frontend to thread a brand-new secret end-to-end -- real
-- churn, disproportionate to a finding whose entropy already makes
-- practical exploitation infeasible.
--
-- Instead: minimal, no-signature-change, no-frontend-change defense in
-- depth at the correct layer -- bound these RPCs to the booking's real
-- business-state lifecycle instead of serving forever for any
-- booking_id anyone ever holds. There is no legitimate product reason
-- for these RPCs to keep returning a club's live payment/contact
-- details once a booking is no longer awaiting payment:
--
--   * get_public_payment_methods_for_booking / get_public_booking_
--     receipt_contact are only ever shown by PaymentMethodsPanel.tsx
--     while the guest is actively completing payment -- i.e. while
--     bookings.status = 'pending_payment'. Once payment is confirmed
--     (record_payment() flips status -> 'confirmed') or the booking is
--     cancelled/no_show/completed, there is nothing left to pay and no
--     legitimate reason to keep exposing the club's wallet/bank/contact
--     details to whoever still holds that old booking_id.
--
--   * get_public_payment_proof_status is polled by PaymentProofUpload.
--     tsx (refetchInterval 15s) both while pending_payment AND for a
--     brief window right after approval, when record_payment() has
--     already flipped the booking to 'confirmed' but the same browser
--     session is still rendering the final "approved" success state --
--     so this one RPC additionally allows 'confirmed', unlike the other
--     two, to avoid a UX regression. cancelled/no_show/completed are
--     still excluded -- no legitimate session is still polling those.
--
-- This shrinks the exposure window from "forever, for any booking ever
-- created" down to "only while that specific booking is actually
-- awaiting payment" -- the correct blast-radius bound given the actual
-- product lifecycle, without inventing new client-facing plumbing.
--
-- Signatures are unchanged (create or replace, same exact arg/return
-- types as 20260819190000_public_payment_methods_rpc.sql and
-- 20260819200000_payment_proof_upload_review.sql) -- verified via
-- pg_proc that no later migration has touched any of these three
-- functions, so this is a safe in-place replace, not a new overload.

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
    and b.status = 'pending_payment'
    and pmc.is_active = true
    and pmc.customer_visible = true
  order by pmc.display_order;
$$;

comment on function public.get_public_payment_methods_for_booking(uuid) is
  'Anon-safe: scoped to one booking''s own club, and (defense-in-depth, since booking_id carries no independent secret factor) only while that booking is still pending_payment -- a confirmed/cancelled/completed booking no longer exposes the club''s payment details to holders of its old booking_id.';

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
  where b.id = p_booking_id
    and b.status = 'pending_payment';
$$;

comment on function public.get_public_booking_receipt_contact(uuid) is
  'Anon-safe: scoped to one booking''s own club, and (defense-in-depth, since booking_id carries no independent secret factor) only while that booking is still pending_payment.';

create or replace function public.get_public_payment_proof_status(p_booking_id uuid)
returns table(status text, uploaded_at timestamptz, rejection_reason text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select pp.status, pp.uploaded_at, pp.rejection_reason
  from public.payment_proofs pp
  join public.bookings b on b.id = pp.booking_id
  where pp.booking_id = p_booking_id
    and b.status in ('pending_payment', 'confirmed')
  order by pp.uploaded_at desc
  limit 1;
$$;

comment on function public.get_public_payment_proof_status(uuid) is
  'Anon-safe: scoped to one booking. Allows pending_payment (active payment flow) and confirmed (so the same session still sees the final approved/rejected state right after record_payment() confirms the booking) -- but not cancelled/no_show/completed, where no legitimate session would still be polling.';

-- Grants are unchanged (already anon+authenticated from the original
-- migrations) -- re-stating them here is harmless and keeps this
-- migration self-contained/idempotent if ever re-run in isolation.
revoke all on function public.get_public_payment_methods_for_booking(uuid) from public;
grant execute on function public.get_public_payment_methods_for_booking(uuid) to anon, authenticated;

revoke all on function public.get_public_booking_receipt_contact(uuid) from public;
grant execute on function public.get_public_booking_receipt_contact(uuid) to anon, authenticated;

revoke all on function public.get_public_payment_proof_status(uuid) from public;
grant execute on function public.get_public_payment_proof_status(uuid) to anon, authenticated;
