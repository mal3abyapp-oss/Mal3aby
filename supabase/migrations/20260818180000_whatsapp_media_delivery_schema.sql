-- MAL3ABY WHATSAPP QR IMAGE + INVOICE DOCUMENT DELIVERY
--
-- Adds explicit media metadata to notification_queue so the connector
-- knows WHETHER and WHAT KIND of media attachment a queued
-- notification needs, without inferring it implicitly from
-- template_key (fragile -- a future template rename/addition could
-- silently change media behavior) and WITHOUT storing the actual
-- media bytes in the database (directive rule 15: "لا تخزن PNG/PDF
-- base64 داخل notification_queue" -- media is generated transiently
-- at send-time from canonical data already in Postgres, then
-- discarded; only these two small metadata columns persist).
--
-- media_type: what kind of attachment, if any. Nullable -- most
-- notification types (booking-cancelled, generic reminders) carry no
-- media at all, and NULL is the correct default for every existing
-- row and every future non-media notification.
--
-- media_intent: WHAT the connector should generate the media FROM.
-- Deliberately a small closed enum, not a free-text field, so a typo
-- can't silently produce "no media sent, no error either" -- an
-- unrecognized media_intent is a real error condition the connector
-- surfaces via reportSendResult, not swallowed.
alter table public.notification_queue
  add column if not exists media_type text
    check (media_type is null or media_type in ('image', 'document')),
  add column if not exists media_intent text
    check (media_intent is null or media_intent in ('booking_qr', 'invoice_pdf'));

comment on column public.notification_queue.media_type is 'WhatsApp media attachment kind for this notification, if any. NULL = text-only. Never stores the media bytes themselves -- see media_intent.';
comment on column public.notification_queue.media_intent is 'What canonical data source the connector should generate the media attachment from at send-time (booking_qr -> booking_qr_token in variables; invoice_pdf -> invoice canonical data via whatsapp_connector_get_invoice_document_data). Media is generated transiently and discarded after send, never persisted.';

-- Enforce the pairing at the database level -- media_intent without
-- media_type (or vice versa) is a data-integrity bug waiting to
-- happen, not a valid state.
alter table public.notification_queue
  add constraint notification_queue_media_pairing_check
  check ((media_type is null) = (media_intent is null));

-- New canonical-data RPC for invoice PDF generation. Deliberately
-- reuses get_invoice_payment_summary() (the SAME function
-- verify_invoice_public(), reports, and billing already use) rather
-- than recomputing payment/outstanding/status with independent logic
-- -- directive rule 9's explicit requirement: "ممنوع إعادة حساب
-- Finance داخل PDF generator بمنطق مستقل". Service-role only (never
-- granted to anon/authenticated) since it returns full internal
-- invoice detail (payment references, branch), unlike the
-- public-safe subset verify_invoice_public() exposes.
create or replace function public.whatsapp_connector_get_invoice_document_data(p_invoice_id uuid)
returns table(
  invoice_id uuid,
  invoice_number text,
  club_id uuid,
  club_name text,
  customer_name text,
  booking_ref text,
  field_name text,
  issued_at timestamptz,
  total numeric,
  paid numeric,
  refunded numeric,
  outstanding numeric,
  payment_status text,
  currency text
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
    i.issued_at,
    s.total,
    s.paid,
    s.refunded,
    s.outstanding,
    s.payment_status,
    coalesce(c.currency, 'EGP') as currency
  from public.invoices i
  join public.clubs c on c.id = i.club_id
  left join public.customers cust on cust.id = i.customer_id
  left join public.bookings b on b.invoice_id = i.id
  left join public.fields f on f.id = b.field_id
  cross join lateral public.get_invoice_payment_summary(array[i.id]::uuid[]) s
  where i.id = p_invoice_id;
$$;

comment on function public.whatsapp_connector_get_invoice_document_data(uuid) is 'Service-role-only canonical data source for WhatsApp invoice PDF generation. Reuses get_invoice_payment_summary() (the SAME function verify_invoice_public()/reports/billing already use) for all financial figures -- never recomputes payment/outstanding/status independently, per directive rule 9. Returns internal detail (not the public-safe subset), so this is NOT granted to anon/authenticated.';

revoke execute on function public.whatsapp_connector_get_invoice_document_data(uuid) from public, anon, authenticated;
