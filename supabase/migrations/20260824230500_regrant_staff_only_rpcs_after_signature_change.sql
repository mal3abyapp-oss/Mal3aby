-- SECURITY HARDENING (2026-08-24): re-close the grant-layer backstop
-- on staff-only RPCs whose signature changed via `create or replace
-- function` since their grants were last explicitly set.
--
-- MECHANISM (documented and already fixed once for the same function
-- in migration 20260823010000_qr_diagnostic_codes.sql, lines ~146-171
-- and ~283-295 of that file): Postgres re-derives a function's grant
-- set from scratch whenever its call signature changes -- a fresh
-- CREATE (via DROP+CREATE, or via CREATE OR REPLACE that changes the
-- RETURNS TABLE column list) grants EXECUTE to PUBLIC (and, observed
-- live in this project, directly to anon) by default, silently
-- discarding any earlier explicit REVOKE. An in-place CREATE OR
-- REPLACE that does NOT change the signature preserves the existing
-- grants untouched.
--
-- REGRESSION: migration 20260823170000_checkin_financial_eligibility_
-- hotfix.sql changed public.qr_validate(text)'s RETURNS TABLE from 9
-- columns to 10 (added `amount_due numeric`) via `create or replace
-- function` -- a genuine signature change -- and did not re-apply the
-- REVOKE ... FROM anon that 20260823010000 had put in place for this
-- exact function. Verified live via Supabase MCP execute_sql against
-- project gxkrtlvpjwxhcqdisyob: qr_validate currently shows
-- has_function_privilege('anon', oid, 'EXECUTE') = true and a proacl
-- containing both a bare `=X/postgres` PUBLIC entry and an explicit
-- `anon=X/postgres` entry -- while qr_confirm_checkin (unchanged
-- signature in that same migration) correctly still shows no anon/
-- PUBLIC grant at all.
--
-- Live audit also found the same bare-PUBLIC/anon grant state on two
-- further functions that were never covered by an explicit REVOKE in
-- any prior migration: public.create_booking(...) and public.
-- get_official_receipts_report(...). Neither has had a documented
-- grant-hardening pass; both currently show anon EXECUTE = true.
--
-- IMPORTANT: this is a defense-in-depth fix, not a live-exploit fix.
-- All three functions already fail closed today via an internal
-- check that runs before any data access or mutation:
--   - qr_validate / qr_confirm_checkin: `if auth.uid() is null then
--     raise exception 'authentication required';` (verified live: an
--     anon-role call reaches the function body but is rejected with
--     P0001 'authentication required').
--   - create_booking -> _create_booking_internal: same `auth.uid() is
--     null` raise, plus a `v_club_id in (select public.user_club_ids())
--     and public.has_permission('booking.create', v_club_id)` check
--     (both evaluate false/empty for an unauthenticated caller).
--   - get_official_receipts_report: `if not (p_club_id in (select
--     public.user_club_ids()) and public.has_permission('payment.view',
--     p_club_id)) then raise exception 'not authorized';` (user_club_ids()
--     is empty for anon, so this always raises).
-- Removing the anon/PUBLIC grant closes the gap between "protected
-- only by an internal check" and "protected by both the grant layer
-- and an internal check", matching the standard already established
-- for every other staff-only RPC in this codebase (see
-- 20260822100000_fix_invoice_document_data_grant_leak.sql and
-- 20260823010000_qr_diagnostic_codes.sql for the same pattern).
--
-- Signatures below are copied verbatim from pg_proc via a live
-- regprocedure query against gxkrtlvpjwxhcqdisyob immediately before
-- writing this migration, to guarantee an exact match (a mismatched
-- signature would silently create a new REVOKE/GRANT target with no
-- effect on the real overload, per the orphaned-overload bug class
-- already seen 5 times in this codebase).

revoke all on function public.qr_validate(text) from public;
revoke all on function public.qr_validate(text) from anon;
grant execute on function public.qr_validate(text) to authenticated;
grant execute on function public.qr_validate(text) to service_role;

revoke all on function public.create_booking(
  uuid, uuid, timestamp with time zone, timestamp with time zone,
  numeric, text, boolean, text, numeric, text, date, text, text, text, text
) from public;
revoke all on function public.create_booking(
  uuid, uuid, timestamp with time zone, timestamp with time zone,
  numeric, text, boolean, text, numeric, text, date, text, text, text, text
) from anon;
grant execute on function public.create_booking(
  uuid, uuid, timestamp with time zone, timestamp with time zone,
  numeric, text, boolean, text, numeric, text, date, text, text, text, text
) to authenticated;
grant execute on function public.create_booking(
  uuid, uuid, timestamp with time zone, timestamp with time zone,
  numeric, text, boolean, text, numeric, text, date, text, text, text, text
) to service_role;

revoke all on function public.get_official_receipts_report(
  uuid, date, date, text, text, text, uuid, uuid, uuid, text, text
) from public;
revoke all on function public.get_official_receipts_report(
  uuid, date, date, text, text, text, uuid, uuid, uuid, text, text
) from anon;
grant execute on function public.get_official_receipts_report(
  uuid, date, date, text, text, text, uuid, uuid, uuid, text, text
) to authenticated;
grant execute on function public.get_official_receipts_report(
  uuid, date, date, text, text, text, uuid, uuid, uuid, text, text
) to service_role;
