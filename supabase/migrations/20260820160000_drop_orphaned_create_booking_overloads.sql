-- CRITICAL SECURITY FIX found during final regression's advisor
-- re-check: stale, ORPHANED overloads of create_booking() /
-- _create_booking_internal() were left behind by this session's Phase
-- B redesign (the p_official_receipt_id -> raw-receipt-fields
-- migration, 20260820070000) and never dropped -- exactly the kind of
-- drift this directive's "one shared implementation, no per-surface
-- duplication" principle exists to prevent.
--
-- Confirmed via direct privilege check: the stale 11-arg
-- _create_booking_internal(..., p_official_receipt_id uuid) overload
-- remains independently callable by BOTH anon and authenticated,
-- alongside the current, correct 16-arg version. Its payments insert
-- has NO cash_shift_id column and NO custody/shift check at all -- a
-- direct caller of this exact overload signature completely bypasses
-- tonight's Phase D cash-shift-gate fix (and predates the Phase C
-- past-booking-time guard and the Phase D custody check entirely).
-- This is a real, live security/financial-integrity gap: PostgREST
-- resolves overloads by argument name+type match, so a caller
-- supplying p_official_receipt_id instead of the current
-- p_receipt_serial/... shape would silently route to this unprotected
-- version instead of erroring.
--
-- Confirmed exact live signatures via pg_proc before writing this
-- migration (not guessed) -- see the SELECT used to derive these DROP
-- statements. Only the CURRENT signatures (9-arg create_booking with
-- no receipt params for the free-callable public.create_booking(uuid,
-- uuid, timestamptz, timestamptz, numeric, text, boolean, text,
-- numeric) -- wait, that is also stale, see below) are kept.
--
-- create_booking has 3 overloads:
--   (uuid,uuid,timestamptz,timestamptz,numeric,text,boolean,text,numeric)                                        -- STALE (predates receipts entirely)
--   (uuid,uuid,timestamptz,timestamptz,numeric,text,boolean,text,numeric,uuid)                                    -- STALE (old p_official_receipt_id design)
--   (uuid,uuid,timestamptz,timestamptz,numeric,text,boolean,text,numeric,text,date,text,text,text,text)           -- CURRENT (raw receipt fields)
-- _create_booking_internal has 3 overloads:
--   (...,p_booking_series_id uuid)                                                                                -- STALE (predates receipts entirely)
--   (...,p_booking_series_id uuid, p_official_receipt_id uuid)                                                    -- STALE (old design, NO shift gate, NO cash_shift_id)
--   (...,p_booking_series_id uuid, p_receipt_serial text, p_receipt_date date, p_receipt_book text,
--        p_receipt_series text, p_receipt_image_path text, p_receipt_notes text)                                  -- CURRENT (has Phase C/D gates)
--
-- Only the CURRENT 15-arg _create_booking_internal / matching
-- create_booking wrapper should remain reachable. Both older
-- overloads of each are dropped.
drop function if exists public.create_booking(
  uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric
);
drop function if exists public.create_booking(
  uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid
);
drop function if exists public._create_booking_internal(
  uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid
);
drop function if exists public._create_booking_internal(
  uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid, uuid
);
