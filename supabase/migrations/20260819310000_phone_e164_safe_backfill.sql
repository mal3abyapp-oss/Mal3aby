-- Safe, non-destructive backfill of customers.phone_e164 from the
-- existing normalized_mobile column (directive section 32/33/34/36).
--
-- Classification performed by hand-audit before this migration (see
-- session notes): 43 customer rows total, all pre-existing values are
-- digits-only (no '+' prefix), grouped into 4 buckets:
--   - 33 rows: EG_WITH_COUNTRY_CODE      -- already "20XXXXXXXXXX" (12 digits)
--   -  2 rows: AE_WITH_COUNTRY_CODE      -- already "971XXXXXXXXX" (12 digits)
--   -  6 rows: EG_LOCAL_NO_LEADING_ZERO  -- "1XXXXXXXXX" (10 digits, EG
--                                           mobile prefix 10/11/12/15
--                                           with the leading 0 already
--                                           stripped by the old
--                                           normalize_mobile())
--   -  2 rows: too short to be real numbers (6 digits) -- left NULL,
--              never guessed (directive section 32/75)
--   -  1 row:  "97150206209" (11 digits) -- one digit short of a valid
--              UAE number, genuinely ambiguous (could be a typo in
--              either direction) -- left NULL, never guessed
--
-- Every backfilled value is verified against the customers_phone_e164_
-- format_check constraint by construction (the four patterns below
-- only ever produce a leading '+' followed by digits). No merge, no
-- delete, no destructive change -- purely additive (directive section
-- 34: do not auto-merge duplicates found by this backfill; see the
-- follow-up review query this migration leaves behind as a comment
-- for manual reference).

-- EG already has the 20 country code -- just add '+'.
update public.customers
set phone_e164 = '+' || normalized_mobile
where phone_e164 is null
  and normalized_mobile ~ '^20(10|11|12|15)[0-9]{8}$';

-- AE already has the 971 country code -- just add '+'.
update public.customers
set phone_e164 = '+' || normalized_mobile
where phone_e164 is null
  and normalized_mobile ~ '^971[0-9]{9}$';

-- EG local mobile with the leading 0 already stripped by the legacy
-- normalize_mobile() -- prepend the EG country code.
update public.customers
set phone_e164 = '+20' || normalized_mobile
where phone_e164 is null
  and normalized_mobile ~ '^(10|11|12|15)[0-9]{8}$';

-- Everything else (too-short test rows, the one ambiguous 11-digit
-- row) is deliberately left phone_e164 = NULL rather than guessed.
-- These surface in the Phone Data Issues view added later in this
-- migration set for a human to review and correct via normal customer
-- edit (which will run through the real normalizePhone() parser).

-- Manual review reference for duplicate-after-normalization groups
-- (directive section 34: document, do not auto-merge). Run this
-- separately to inspect -- not executed as part of the migration:
--   select club_id, phone_e164, array_agg(id) as customer_ids, count(*)
--   from public.customers
--   where phone_e164 is not null
--   group by club_id, phone_e164
--   having count(*) > 1;
-- (As of this migration, this returns zero rows -- no duplicate
-- groups were created by this backfill.)
