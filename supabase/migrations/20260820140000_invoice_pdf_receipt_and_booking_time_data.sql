-- MASTER OPERATIONAL SIMPLIFICATION DIRECTIVE (2026-08-20), section 9:
-- the PDF invoice must include "official receipt serial/date/book/
-- series" when applicable, and booking date/time/payment method.
-- Confirmed missing via dedicated audit: whatsapp_connector_get_
-- invoice_document_data() (the PDF's sole data source, per its own
-- comment "never recomputes ... independently") predates
-- official_collection_receipts (added a day later) and was never
-- revisited. Fixed here by left-joining the ACTIVE receipt linked to
-- this invoice (never a reversed one -- a reversed receipt is no
-- longer the operative record) and adding booking start/end time +
-- payment method, which the audit also found missing.
--
-- The return row shape changed (new columns), so the function must be
-- dropped before being recreated (Postgres refuses an OUT-parameter
-- signature change via plain CREATE OR REPLACE).
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
  booking_start_at timestamptz,
  booking_end_at timestamptz,
  club_timezone text,
  issued_at timestamptz,
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
  receipt_date date
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
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
    -- Directive: payment method. Most recent completed payment on this
    -- invoice -- an invoice can in principle have multiple payments
    -- (split payment), but the PDF is a single document so the most
    -- recent method is the most representative single value to show.
    (select p.method from public.payments p
     join public.payment_allocations pa on pa.payment_id = p.id
     where pa.invoice_id = i.id
     order by p.received_at desc limit 1) as payment_method,
    -- Directive Sections 4/7/9: official receipt fields, only the
    -- currently-ACTIVE receipt for this invoice (a reversed receipt is
    -- no longer the operative record -- if a correction/reversal
    -- happened, the PDF should reflect the current valid receipt, not
    -- a superseded one).
    ocr.receipt_serial,
    ocr.receipt_book,
    ocr.receipt_series,
    ocr.receipt_date
  from public.invoices i
  join public.clubs c on c.id = i.club_id
  left join public.customers cust on cust.id = i.customer_id
  left join public.bookings b on b.invoice_id = i.id
  left join public.fields f on f.id = b.field_id
  left join public.official_collection_receipts ocr
    on ocr.invoice_id = i.id and ocr.status = 'active'
  cross join lateral public.get_invoice_payment_summary(array[i.id]::uuid[]) s
  where i.id = p_invoice_id;
$$;

comment on function public.whatsapp_connector_get_invoice_document_data(uuid) is 'Service-role-only canonical data source for WhatsApp invoice PDF generation. Reuses get_invoice_payment_summary() (the SAME function verify_invoice_public()/reports/billing already use) for all financial figures -- never recomputes payment/outstanding/status independently, per directive rule 9. Also carries booking start/end time, payment method, and the active official government receipt (serial/book/series/date) when one is linked to this invoice. Returns internal detail (not the public-safe subset), so this is NOT granted to anon/authenticated.';

revoke execute on function public.whatsapp_connector_get_invoice_document_data(uuid) from public, anon, authenticated;
