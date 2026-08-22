-- WHATSAPP BUSINESS MESSAGING FINAL HARDENING (2026-08-22), Sections
-- 40/42/45 (government receipt must appear on the customer-facing web
-- invoice page, matching WhatsApp/PDF/DB): confirmed via direct source
-- read that verify_invoice_public() (the RPC backing VerifyInvoicePage.
-- tsx, the actual page invoiceUrl() links to from WhatsApp) returns
-- ZERO official_collection_receipts data -- a genuine, confirmed
-- cross-surface inconsistency. WhatsApp templates (booking-confirmed-
-- paid/payment-received) and the PDF invoice (InvoicePdf.ts) both
-- already render this data correctly; only this one surface was
-- missing it.
--
-- Section 43 (multiple cash payments against one invoice can each
-- carry their own official receipt -- history must not be lost):
-- returns ALL active receipts for the invoice as a jsonb array, not
-- a single flattened receipt, ordered oldest-first to match a natural
-- payment timeline. Reversed/corrected receipts (status <> 'active')
-- are deliberately excluded -- a reversed receipt is no longer a valid
-- proof of collection and showing it would misrepresent the invoice's
-- real state to whoever is verifying it (the same "only what happened,
-- not what got corrected out" principle used elsewhere in this
-- directive for financial data).
--
-- Additive change only: the four existing scalar output columns are
-- completely unchanged in name, type, and position; one new jsonb
-- column is appended at the end. VerifyInvoicePage.tsx is updated in
-- the same pass to render it.
--
-- Postgres requires DROP before CREATE OR REPLACE when a function's
-- return row shape changes (42P13) -- explicit DROP + CREATE here,
-- with grants re-applied immediately after in the same migration
-- (confirmed via information_schema.routine_privileges before this
-- change: authenticated, anon, service_role, postgres all had
-- EXECUTE -- anon is the load-bearing one, since this is the actual
-- public/no-login verification RPC VerifyInvoicePage.tsx calls).
drop function if exists public.verify_invoice_public(text);

create function public.verify_invoice_public(p_token text)
returns table(
  result text,
  invoice_number text,
  issued_at timestamp with time zone,
  total numeric,
  paid numeric,
  outstanding numeric,
  payment_status text,
  customer_name text,
  booking_ref text,
  field_name text,
  official_receipts jsonb
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_token_hash text;
  v_vt record;
  v_inv record;
  v_summary record;
  v_customer_name text;
  v_booking_ref text;
  v_field_name text;
  v_official_receipts jsonb;
begin
  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_vt from public.invoice_verification_tokens where token_hash = v_token_hash;

  if v_vt.id is null or v_vt.status <> 'active' then
    return query select 'invalid'::text, null::text, null::timestamptz, null::numeric, null::numeric, null::numeric, null::text, null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  select * into v_inv from public.invoices where id = v_vt.invoice_id;
  if v_inv.id is null then
    return query select 'invalid'::text, null::text, null::timestamptz, null::numeric, null::numeric, null::numeric, null::text, null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  select * into v_summary from public.get_invoice_payment_summary(array[v_inv.id]::uuid[]);

  select c.full_name into v_customer_name from public.customers c where c.id = v_inv.customer_id;

  select 'MB-' || upper(substring(b.id::text, 1, 8)), f.name
    into v_booking_ref, v_field_name
    from public.bookings b
    join public.fields f on f.id = b.field_id
    where b.invoice_id = v_inv.id
    limit 1;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'receipt_serial', r.receipt_serial,
      'receipt_book', r.receipt_book,
      'receipt_series', r.receipt_series,
      'receipt_date', r.receipt_date,
      'receipt_amount', r.receipt_amount
    )
    order by r.receipt_date asc, r.created_at asc
  ), '[]'::jsonb)
  into v_official_receipts
  from public.official_collection_receipts r
  where r.invoice_id = v_inv.id and r.status = 'active';

  return query
    select 'success'::text, v_inv.invoice_number, v_inv.issued_at, v_inv.total,
           coalesce(v_summary.paid, 0), coalesce(v_summary.outstanding, v_inv.total),
           coalesce(v_summary.payment_status, 'unpaid'),
           v_customer_name, v_booking_ref, v_field_name,
           v_official_receipts;
end;
$function$;

grant execute on function public.verify_invoice_public(text) to authenticated;
grant execute on function public.verify_invoice_public(text) to anon;
grant execute on function public.verify_invoice_public(text) to service_role;
