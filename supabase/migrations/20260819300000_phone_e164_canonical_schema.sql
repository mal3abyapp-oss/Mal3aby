-- P0 Phone Identity & WhatsApp Delivery Integrity directive.
--
-- Adds the canonical E.164 phone model across the columns that
-- actually feed WhatsApp delivery and customer identity:
--   clubs.country            -- ISO 3166-1 alpha-2, DEFAULT country for
--                                interpreting a local number entered at
--                                this club, never a forced/hard country
--                                (directive section 3).
--   customers.phone_e164     -- canonical send/identity target.
--   clubs.primary_phone_e164 / whatsapp_number_e164 /
--     payment_receipt_whatsapp_number_e164
--   branches.phone_e164
--   platform_settings.platform_phone_e164
--
-- Existing display/raw columns (mobile_display, normalized_mobile,
-- primary_phone, whatsapp_number, etc.) are kept unchanged -- this is
-- an additive migration (directive section 65: forward-safe,
-- non-destructive). phone_e164 becomes the canonical value; the old
-- columns remain for display/audit/back-compat until every write path
-- is migrated (this same pass) and a safe backfill (next migration)
-- populates historical rows where unambiguous.
--
-- Format enforcement: Postgres cannot run libphonenumber-js, so the
-- database only enforces a LIGHTWEIGHT format check here (starts with
-- '+', digits only after that, sane length) -- not full parsing logic
-- (directive section 47). The actual normalization/validation
-- authority is src/lib/domain/phone.ts on the frontend, called before
-- any write. This CHECK is the backstop that makes it impossible for
-- any write path (direct PostgREST included) to store a non-E.164-shaped
-- value in phone_e164, even if a caller bypasses the frontend module.

alter table public.clubs
  add column if not exists country text;

comment on column public.clubs.country is
  'ISO 3166-1 alpha-2 (e.g. EG, AE). DEFAULT country for interpreting a locally-formatted phone number entered at this club -- never forces every customer/contact to this country (directive section 3). NULL means unset; local numbers cannot be safely parsed until an admin sets this in Settings.';

alter table public.clubs
  add constraint clubs_country_format_check
  check (country is null or country ~ '^[A-Z]{2}$');

alter table public.customers
  add column if not exists phone_e164 text;

alter table public.customers
  add constraint customers_phone_e164_format_check
  check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$');

comment on column public.customers.phone_e164 is
  'Canonical E.164 phone number (e.g. +201116505553). This is the ONLY value WhatsApp delivery and cross-format duplicate detection may use. mobile_display/normalized_mobile remain for legacy display/search compatibility -- see src/lib/domain/phone.ts for the normalization authority.';

alter table public.clubs
  add column if not exists primary_phone_e164 text,
  add column if not exists whatsapp_number_e164 text,
  add column if not exists payment_receipt_whatsapp_number_e164 text;

alter table public.clubs
  add constraint clubs_primary_phone_e164_format_check
    check (primary_phone_e164 is null or primary_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  add constraint clubs_whatsapp_number_e164_format_check
    check (whatsapp_number_e164 is null or whatsapp_number_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  add constraint clubs_payment_receipt_whatsapp_e164_format_check
    check (payment_receipt_whatsapp_number_e164 is null or payment_receipt_whatsapp_number_e164 ~ '^\+[1-9][0-9]{6,14}$');

alter table public.branches
  add column if not exists phone_e164 text;

alter table public.branches
  add constraint branches_phone_e164_format_check
  check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$');

alter table public.platform_settings
  add column if not exists platform_phone_e164 text;

alter table public.platform_settings
  add constraint platform_settings_phone_e164_format_check
  check (platform_phone_e164 is null or platform_phone_e164 ~ '^\+[1-9][0-9]{6,14}$');

-- Lookup/dedupe index -- directive section 29/48: tenant + phone_e164,
-- never global. Non-unique for now (directive section 49: analyze
-- duplicates before ever adding a unique constraint; a family/shared
-- number is a legitimate pre-existing case per ADR-012).
create index if not exists idx_customers_club_phone_e164
  on public.customers (club_id, phone_e164)
  where phone_e164 is not null;
