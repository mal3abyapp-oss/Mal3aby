-- WHATSAPP BUSINESS MESSAGING FINAL HARDENING (2026-08-22) -- real bug
-- found live during production QA acceptance testing (item 14, PDF
-- verification): the PDF invoice attached to a real Academy payment
-- (media_type='document', sent via record_payment()'s
-- 'academy-payment-received' branch) correctly showed NO booking_ref/
-- field_name (there is no booking for an Academy invoice -- that part
-- is correct), but ALSO showed no player_name/group_name in their
-- place -- the exact information a guardian actually needs to
-- identify which child/subscription the invoice is for (the same
-- Section 29 requirement already enforced in the WhatsApp message text
-- itself). Confirmed live: a real QA invoice
-- (3708e782-4ecd-4d37-9c9e-e9cdfd39f095, "QA Acceptance Player",
-- group "QA Monthly") returned player_name/group_name as columns that
-- DON'T EXIST in this function's output at all -- a genuine,
-- structural cross-surface gap between the WhatsApp message (which
-- already correctly names the player) and the PDF attached to that
-- exact same payment.
--
-- Fix: additive columns only -- player_name, group_name,
-- subscription_start_date, subscription_end_date, joined via the same
-- subscriptions -> enrollments -> players/groups path record_payment()
-- already uses for its own Academy-detection. All existing columns
-- unchanged in name/type/position. A Field Booking invoice (no linked
-- subscription) simply gets null for all four new columns, exactly
-- like it already gets null for booking_ref/field_name on a
-- (hypothetical) Academy invoice -- symmetric, no invoice ever shows
-- both a booking AND a subscription's identity fields populated,
-- since a real invoice_items row only ever links to one reference_type
-- per this codebase's architecture.
--
-- Postgres requires DROP before CREATE OR REPLACE when a function's
-- return row shape changes (42P13) -- explicit DROP + CREATE, grants
-- re-applied immediately after (confirmed via information_schema.
-- routine_privileges before this change: service_role, postgres only
-- -- this is a connector-only function, never exposed to
-- authenticated/anon).
drop function if exists public.whatsapp_connector_get_invoice_document_data(uuid);

create function public.whatsapp_connector_get_invoice_document_data(p_invoice_id uuid)
returns table(
  invoice_id uuid,
  invoice_number text,
  club_id uuid,
  club_name text,
  customer_name text,
  booking_ref text,
  field_name text,
  booking_start_at timestamp with time zone,
  booking_end_at timestamp with time zone,
  club_timezone text,
  issued_at timestamp with time zone,
  total numeric,
  paid numeric,
  refunded numeric,
  outstanding numeric,
  payment_status text,
  currency text,
  payment_method text,
  receipt_serial text,
  receipt_book text,
  receipt_series text,
  receipt_date date,
  player_name text,
  group_name text,
  subscription_start_date date,
  subscription_end_date date
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select
    i.id as invoice_id,
    i.invoice_number,
    i.club_id,
    c.name as club_name,
    cust.full_name as customer_name,
    ('MB-' || upper(substring(b.id::text, 1, 8))) as booking_ref,
    f.name as field_name,
    b.start_at as booking_start_at,
    b.end_at as booking_end_at,
    c.timezone as club_timezone,
    i.issued_at,
    s.total,
    s.paid,
    s.refunded,
    s.outstanding,
    s.payment_status,
    coalesce(c.currency, 'EGP') as currency,
    (select p.method from public.payments p
     join public.payment_allocations pa on pa.payment_id = p.id
     where pa.invoice_id = i.id
     order by p.received_at desc limit 1) as payment_method,
    ocr.receipt_serial,
    ocr.receipt_book,
    ocr.receipt_series,
    ocr.receipt_date,
    plyr.full_name as player_name,
    grp.name as group_name,
    sub.start_date as subscription_start_date,
    sub.end_date as subscription_end_date
  from public.invoices i
  join public.clubs c on c.id = i.club_id
  left join public.customers cust on cust.id = i.customer_id
  left join public.bookings b on b.invoice_id = i.id
  left join public.fields f on f.id = b.field_id
  left join public.official_collection_receipts ocr
    on ocr.invoice_id = i.id and ocr.status = 'active'
  left join public.subscriptions sub on sub.invoice_id = i.id
  left join public.enrollments enr on enr.id = sub.enrollment_id
  left join public.players plyr on plyr.id = enr.player_id
  left join public.groups grp on grp.id = enr.group_id
  cross join lateral public.get_invoice_payment_summary(array[i.id]::uuid[]) s
  where i.id = p_invoice_id;
$function$;

grant execute on function public.whatsapp_connector_get_invoice_document_data(uuid) to service_role;
