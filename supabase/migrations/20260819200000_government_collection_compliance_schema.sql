-- Government / Ministry Collection Compliance -- Schema (directive
-- sections 2-13, 22-24, 29-32, 36-38, 65-67).
--
-- ARCHITECTURE DECISION (directive section 2): three distinct entities.
--   BOOKING   = the service/slot (existing `bookings` table, unchanged).
--   PAYMENT   = the money-movement inside Mal3aby (existing `payments`
--               table, unchanged schema -- extended below only with a
--               back-reference from the new receipt table, never the
--               reverse, so `payments` never needs to know whether a
--               receipt exists).
--   OFFICIAL COLLECTION RECEIPT = the government paper-trail reference
--               (`official_collection_receipts`, new table below).
--
-- This is NOT a `receipt_number` column bolted onto `bookings` or
-- `payments` -- confirmed deliberately per directive section 2 and the
-- Final Safety Rule.
--
-- SOURCE-OF-TRUTH AUDIT (confirmed live via pg_get_functiondef before
-- writing this migration): `record_payment()` is the single place a
-- club-level payment is created and a booking is auto-confirmed --
-- atomically, in one transaction. `approve_payment_proof()` and
-- `verify_manual_payment_claim()` both delegate to `record_payment()`
-- rather than duplicating its logic. This migration's enforcement (in
-- the next migration file) modifies `record_payment()` itself so all
-- three entry points are covered by one hard block -- no parallel
-- payment-confirmation path is introduced.

begin;

-- ============================================================
-- Government Collection Policy -- hierarchical (club/branch/field)
-- ============================================================
-- Directive section 6: club -> branch -> field, branch/field inherit
-- by default, override requires an explicit row + reason. Modeled as
-- ONE ROW PER SCOPE rather than three separate tables, since the
-- shape is identical at every level and a single COALESCE-based
-- resolution function (next migration) is simpler and less
-- error-prone than three near-duplicate tables.
create table public.government_collection_policies (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  field_id uuid references public.fields(id) on delete cascade,

  -- Exactly one scope level per row: club-only (branch/field null),
  -- branch-level (field null), or field-level (both set, since a
  -- field always belongs to a branch).
  constraint gcp_scope_shape check (
    (branch_id is null and field_id is null)
    or (branch_id is not null and field_id is null)
    or (branch_id is not null and field_id is not null)
  ),

  enabled boolean not null default false,
  -- Directive section 5: classification only, does not itself drive
  -- legal enforcement -- only `official_receipt_required` does.
  authority_type text check (authority_type in (
    'MINISTRY_YOUTH_AND_SPORTS', 'YOUTH_CENTER', 'GOVERNMENT_CLUB',
    'GOVERNMENT_FACILITY', 'OTHER'
  )),

  official_receipt_required boolean not null default false,
  -- Directive section 9: no hardcoded "cash only" -- an explicit list,
  -- defaulting to cash-required, everything else opt-in.
  required_payment_methods text[] not null default array['cash'],

  receipt_book_enabled boolean not null default false,
  receipt_series_enabled boolean not null default false,
  receipt_date_required boolean not null default true,
  receipt_image_required boolean not null default false,

  -- Directive section 37: when this policy became effective, for
  -- non-retroactive enforcement (section 36/38).
  effective_from timestamptz not null default now(),

  -- Directive section 6/60: an override row (branch/field level that
  -- differs from what it would otherwise inherit) requires a reason
  -- and is itself audit-logged (enforced in the RPC layer, not here --
  -- this column just carries the reason).
  is_override boolean not null default false,
  override_reason text,

  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- At most one policy row per exact scope (club-only, or a specific
  -- branch, or a specific field).
  constraint gcp_unique_club_scope unique nulls not distinct (club_id, branch_id, field_id)
);

comment on table public.government_collection_policies is
  'Hierarchical (club -> branch -> field) government/ministry official-receipt compliance policy. One row per scope; branch/field rows are overrides, resolved via get_effective_government_policy(). See directive: MAL3ABY GOVERNMENT COLLECTION COMPLIANCE, sections 3-8.';

create index gcp_club_id_idx on public.government_collection_policies(club_id);
create index gcp_branch_id_idx on public.government_collection_policies(branch_id) where branch_id is not null;
create index gcp_field_id_idx on public.government_collection_policies(field_id) where field_id is not null;

-- ============================================================
-- Official Collection Receipt -- independent entity (directive 10-13)
-- ============================================================
create table public.official_collection_receipts (
  id uuid primary key default gen_random_uuid(),

  club_id uuid not null references public.clubs(id) on delete restrict,
  branch_id uuid references public.branches(id) on delete restrict,
  field_id uuid references public.fields(id) on delete restrict,

  -- One official receipt per payment. A payment either has exactly one
  -- active receipt or none -- this is NOT a receipt-per-invoice or
  -- receipt-per-booking relationship (directive section 10: payment_id
  -- is the anchor, booking_id/invoice_id are denormalized for query
  -- convenience and reporting, never the join key for uniqueness).
  payment_id uuid not null references public.payments(id) on delete restrict,
  booking_id uuid references public.bookings(id) on delete restrict,
  invoice_id uuid references public.invoices(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete restrict,

  authority_type text,

  -- Directive section 11: TEXT, never INTEGER -- serials may carry
  -- leading zeros, prefixes, letters, slashes ("000124", "A-1524",
  -- "12/458"). display value is preserved exactly as entered.
  receipt_book text,
  receipt_series text,
  receipt_serial text not null,
  -- Directive section 12: normalization for duplicate detection only,
  -- never mutates the display value. Whitespace-trimmed, case-folded
  -- (letters), nothing else -- no separator rewriting, since the
  -- directive explicitly warns against silently changing a receipt
  -- number's official meaning.
  normalized_receipt_serial text generated always as (
    lower(regexp_replace(trim(receipt_serial), '\s+', '', 'g'))
  ) stored,

  receipt_date date not null,
  receipt_amount numeric(12,2) not null check (receipt_amount > 0),
  payment_method text not null,

  status text not null default 'active' check (status in ('active', 'reversed')),

  entered_by uuid not null,
  entered_at timestamptz not null default now(),

  reversed_by uuid,
  reversed_at timestamptz,
  reversal_reason text,

  -- Directive section 30: correction is create-a-new-record-and-link,
  -- never an in-place edit of a confirmed receipt.
  corrected_from_receipt_id uuid references public.official_collection_receipts(id),

  -- Directive section 23/24: optional by default, private storage,
  -- path only (never a public URL) -- bucket/RLS added in the storage
  -- migration.
  receipt_image_path text,

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ocr_reversal_shape check (
    (status = 'active' and reversed_by is null and reversed_at is null and reversal_reason is null)
    or (status = 'reversed' and reversed_by is not null and reversed_at is not null and reversal_reason is not null)
  )
);

comment on table public.official_collection_receipts is
  'Official government/ministry cash-collection receipt reference -- distinct from payments (the money movement) and payment_proofs/manual_payment_claims (customer-submitted evidence). Never edited in place after creation; corrections create a new linked row, reversals set status=reversed and keep full history. See directive: MAL3ABY GOVERNMENT COLLECTION COMPLIANCE, sections 10-13, 29-32, 50-52.';

-- Directive section 13: DATABASE-ENFORCED duplicate protection, scoped
-- to (club, book, series, normalized serial) -- NOT globally unique on
-- the serial alone, since the same serial can legitimately exist in a
-- different book/series or a different club's own receipt book.
-- Partial index on status='active' so a reversed receipt's serial slot
-- can be corrected forward (a new active receipt with the same serial
-- is only blocked while the original is still active).
create unique index ocr_unique_active_serial_idx
  on public.official_collection_receipts (
    club_id,
    coalesce(receipt_book, ''),
    coalesce(receipt_series, ''),
    normalized_receipt_serial
  )
  where status = 'active';

-- One active receipt per payment (a payment cannot be double-receipted).
create unique index ocr_unique_active_payment_idx
  on public.official_collection_receipts (payment_id)
  where status = 'active';

create index ocr_club_date_idx on public.official_collection_receipts(club_id, receipt_date);
create index ocr_booking_idx on public.official_collection_receipts(booking_id) where booking_id is not null;
create index ocr_invoice_idx on public.official_collection_receipts(invoice_id) where invoice_id is not null;
create index ocr_serial_search_idx on public.official_collection_receipts(club_id, normalized_receipt_serial);

commit;
