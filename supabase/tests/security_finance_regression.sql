-- MAL3ABY FINAL REMEDIATION -- Security & Finance regression suite.
--
-- This is a real, re-runnable SQL regression test for the P0 fixes
-- made in this remediation pass. It follows this project's own
-- established live-verification pattern (set_config('request.jwt.claims',
-- ...) to impersonate a real authenticated user, exactly as used
-- throughout this session's manual verification) rather than a mocked
-- unit test, because these are RLS/trigger-level protections that can
-- ONLY be genuinely proven under a real RLS-authenticated session --
-- a vitest/jsdom unit test has no way to exercise Postgres RLS at all.
--
-- CRITICAL METHODOLOGY NOTE (found and fixed during this remediation
-- pass -- keep this comment, it documents a real mistake that
-- silently produced false-PASS results during manual verification
-- before it was caught): connecting as the `postgres` superuser
-- (which is ALSO the owner of every table in this schema, confirmed
-- via pg_tables.tableowner) means RLS is bypassed entirely for that
-- connection's own queries, REGARDLESS of any set_config('role', ...)
-- call -- set_config() only sets a session GUC value, it does NOT
-- change the actual Postgres role used for privilege checks.
-- `set_config('role', 'authenticated', true)` alone is a NO-OP for
-- RLS purposes. The correct technique, matching what PostgREST
-- actually does per real request, is a real `SET ROLE authenticated;`
-- role switch, THEN `select set_config('request.jwt.claims', ...)` so
-- auth.uid()-dependent functions read the right subject, then `RESET
-- ROLE;` afterward. Because SET ROLE cannot be issued from inside a
-- plpgsql DO block reliably (role changes there don't consistently
-- propagate the way top-level SET ROLE does across statement
-- boundaries), every block below is a sequence of plain top-level
-- statements, not one big DO $$ ... $$ block -- this is deliberate,
-- not an oversight.
--
-- HOW TO RUN: execute each numbered block below IN ORDER, as separate
-- statements/round-trips (via the Supabase SQL Editor, `supabase db
-- execute`, or the Supabase MCP execute_sql tool), against a project
-- with this migration set applied. Update the UUIDs in each block to
-- match real fixture users/clubs in the target environment -- query
-- club_memberships first to find a real multi-club user and a real
-- pair of unrelated user/club, as shown in the "find fixtures" block.
-- A clean run where every assertion query returns the expected value
-- = PASS. This file intentionally does NOT wrap assertions in RAISE
-- EXCEPTION (which would require the flawed DO-block pattern above)
-- -- instead each block's final SELECT is the assertion itself;
-- compare its output to the "EXPECTED" comment above it.

-- ============================================================
-- FIXTURES: find real users/clubs to test against in this
-- environment. Copy the returned UUIDs into the blocks below.
-- ============================================================
select cm.user_id, cm.club_id, r.name as role_name
from club_memberships cm join roles r on r.id = cm.role_id
where cm.user_id in (select user_id from club_memberships group by user_id having count(*) > 1)
order by cm.user_id;
-- ^ multi-club users, for TEST 1 (self-escalation) and TEST 2 (cross-tenant reassignment)

select cm1.user_id as unrelated_user, cm2.club_id as unrelated_club
from club_memberships cm1
cross join club_memberships cm2
where cm1.club_id != cm2.club_id
  and not exists (select 1 from club_memberships cm3 where cm3.user_id = cm1.user_id and cm3.club_id = cm2.club_id)
limit 1;
-- ^ a genuinely unrelated user/club pair, for TEST 3 (info-leak) and TEST 4 (SELECT isolation)

-- ============================================================
-- TEST 1: club_memberships privilege escalation (C1)
-- EXPECTED: role_id unchanged after the UPDATE (the trigger reverts it)
-- ============================================================
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<multi-club-user-id>','role','authenticated')::text, true);
update club_memberships set role_id = (select id from roles where name = 'Club Owner')
where user_id = '<multi-club-user-id>' and role_id != (select id from roles where name = 'Club Owner')
returning id, role_id;
-- run this SELECT and compare role_id to what it was before the UPDATE above -- must be unchanged:
select id, role_id from club_memberships where user_id = '<multi-club-user-id>';
reset role;

-- ============================================================
-- TEST 2: cross-tenant club_id reassignment (C2)
-- EXPECTED: club_id unchanged after the UPDATE
-- ============================================================
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<multi-club-user-id>','role','authenticated')::text, true);
-- pick a real booking belonging to one of this user's own clubs, and a DIFFERENT club_id this same user also belongs to:
update bookings set club_id = '<the-other-club-id-same-user-belongs-to>'
where id = '<a-real-booking-id-in-the-first-club>'
returning id, club_id;
select id, club_id from bookings where id = '<a-real-booking-id-in-the-first-club>';
reset role;

-- ============================================================
-- TEST 3: get_club_platform_access() caller scoping (info-leak fix)
-- EXPECTED: 'blocked' for the unrelated user/club pair
-- ============================================================
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<unrelated-user-id>','role','authenticated')::text, true);
select public.get_club_platform_access('<unrelated-club-id>') as result;  -- must be 'blocked'
reset role;

-- ============================================================
-- TEST 4: SELECT tenant isolation across core financial tables
-- EXPECTED: 0 rows for the unrelated club on every table
-- ============================================================
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<unrelated-user-id>','role','authenticated')::text, true);
select count(*) as customers_visible from customers where club_id = '<unrelated-club-id>';   -- must be 0
select count(*) as payments_visible from payments where club_id = '<unrelated-club-id>';     -- must be 0
select count(*) as invoices_visible from invoices where club_id = '<unrelated-club-id>';     -- must be 0
select count(*) as bookings_visible from bookings where club_id = '<unrelated-club-id>';     -- must be 0
reset role;

-- ============================================================
-- TEST 5: payment idempotency (C3) -- point at any real 'issued'
-- invoice with outstanding > 0 and a real staff user with
-- payment.create on that invoice's club.
-- EXPECTED: first_call and retry_call return the SAME payment id;
-- exactly 1 row exists with that idempotency_key afterward.
-- ============================================================
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<staff-user-id>','role','authenticated')::text, true);
select public.record_payment('<invoice-id>'::uuid, 10.00, 'cash', 'regression test', 'REPLACE-WITH-A-FRESH-UUID'::uuid) as first_call;
select public.record_payment('<invoice-id>'::uuid, 10.00, 'cash', 'regression test retry', 'REPLACE-WITH-THE-SAME-UUID-AS-ABOVE'::uuid) as retry_call;
reset role;
select count(*) from public.payments where idempotency_key = 'REPLACE-WITH-THE-SAME-UUID-AS-ABOVE'; -- must be 1

-- ============================================================
-- TEST 5b: claim_manual_payment() duplicate-pending-claim guard
-- (fix for the unlimited-duplicate-submission gap -- directive
-- sections 9/10/11/35). Point at any real 'issued' invoice owned by
-- the impersonated customer user with NO existing pending claim
-- against it (check first with the SELECT commented below).
-- EXPECTED: first_claim returns a new claim id; second_claim RAISES
-- 'a payment claim for this invoice is already pending review...'
-- instead of silently inserting a second row; exactly 1 row exists
-- for this invoice_id afterward, and it is 'pending'.
-- ============================================================
-- select id, status from manual_payment_claims where invoice_id = '<invoice-id>'; -- must be 0 rows before running this block
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<customer-user-id>','role','authenticated')::text, true);
select public.claim_manual_payment('<invoice-id>'::uuid, null, 50.00, 'regression-test-1', 'first claim') as first_claim; -- succeeds
select public.claim_manual_payment('<invoice-id>'::uuid, null, 50.00, 'regression-test-2', 'duplicate claim') as second_claim; -- EXPECTED: raises exception, does not return
reset role;
select count(*) as claim_rows_for_invoice, array_agg(status) as statuses from public.manual_payment_claims where invoice_id = '<invoice-id>'; -- must be count=1, statuses={pending}
-- cleanup: delete public.manual_payment_claims where invoice_id = '<invoice-id>' and reference = 'regression-test-1';

-- ============================================================
-- TEST 6: double booking exclusion constraint presence (structural,
-- no live data needed)
-- EXPECTED: true
-- ============================================================
select exists (
  select 1 from pg_constraint
  where conrelid = 'public.bookings'::regclass and contype = 'x'
    and conname = 'no_overlapping_field_bookings'
) as double_booking_protection_present;

-- ============================================================
-- TEST 7: FORCE RLS coverage (structural, no live data needed)
-- EXPECTED: 0 unforced tables
-- ============================================================
select count(*) as tables_with_rls_enabled_but_not_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and c.relrowsecurity = true and c.relforcerowsecurity = false;

-- ============================================================
-- TEST 7b: FORCE RLS coverage regression guard -- names the 8 tables
-- that were found missing FORCE (defense-in-depth gap, low severity,
-- fixed in 20260824230000_force_rls_remaining_tables.sql) so a future
-- migration that adds a new table with RLS enabled but forgets FORCE
-- shows up here with the actual offending table name, not just a
-- count from TEST 7.
-- EXPECTED: 0 rows
-- ============================================================
select c.relname as unforced_table
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and c.relrowsecurity = true and c.relforcerowsecurity = false
  and c.relname in (
    'employee_cash_liabilities', 'employee_cash_liability_ledger',
    'employee_cash_liability_settlement_keys',
    'government_collection_policies', 'official_collection_receipts',
    'whatsapp_delivery_traces', 'whatsapp_incidents',
    'whatsapp_root_cause_codes'
  );

-- ============================================================
-- TEST 8: club_memberships/bookings/customers/etc identity-column
-- protection triggers are actually installed (structural check --
-- catches a future migration accidentally dropping one of these)
-- EXPECTED: 10 rows (one per protected table)
-- ============================================================
select event_object_table, trigger_name
from information_schema.triggers
where trigger_name in (
  'trg_protect_club_membership_identity_columns',
  'trg_protect_tenant_id_bookings', 'trg_protect_tenant_id_customers',
  'trg_protect_tenant_id_payments', 'trg_protect_tenant_id_invoices',
  'trg_protect_tenant_id_players', 'trg_protect_tenant_id_subscriptions',
  'trg_protect_tenant_id_enrollments', 'trg_protect_tenant_id_fields',
  'trg_protect_tenant_id_branches'
)
order by event_object_table;

-- ============================================================
-- TEST 9: request_commercial_upgrade() requires club.update permission,
-- not just tenant membership (fixed in
-- 20260824230000_request_commercial_upgrade_require_club_update.sql).
-- Point at a real Coach-role (or any role without club.update) user and
-- the club they belong to -- find one with:
--   select cm.user_id, cm.club_id from club_memberships cm
--   join roles r on r.id = cm.role_id
--   where r.key = 'coach' and cm.status = 'active' limit 1;
-- EXPECTED: raises "not authorized" (query errors out) for the
-- low-privilege user; 0 rows exist afterward with the QA note below.
-- Run inside a transaction and ROLLBACK so no residue is left even if
-- the bug has regressed and the insert unexpectedly succeeds.
-- ============================================================
begin;
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<coach-or-other-non-manager-user-id>','role','authenticated')::text, true);
select public.request_commercial_upgrade('<that-users-club-id>', 'branch_limit', 'QA SECURITY TEST - regression check, must fail');
-- ^ must raise "not authorized" and abort the transaction (no row returned)
reset role;
rollback;
-- if the statement above did NOT error, run this as a sanity check (should be 0):
-- select count(*) from public.commercial_upgrade_requests where note = 'QA SECURITY TEST - regression check, must fail';

-- ============================================================
-- TEST 10: claim_portal_invite_service() must not accept an
-- arbitrary caller-supplied p_user_id unrelated to the invite's own
-- verification flow (fixed in
-- 20260824250000_claim_portal_invite_service_bind_caller_identity.sql).
--
-- Live-reproduced twice against gxkrtlvpjwxhcqdisyob before the fix:
-- minting a real invite via _mint_portal_invite_internal, verifying
-- phone+secret correctly, then calling claim_portal_invite_service()
-- with an UNRELATED pre-existing user id (a real platform_owner
-- fixture that never touched phone/secret verification) succeeded and
-- silently linked that unrelated account to the customer record. This
-- test proves the fix: an old/pre-existing auth.users id (anything
-- created more than 5 minutes ago) is now rejected before the
-- customer link is ever written.
--
-- Run this as service_role (this RPC is service_role-only by design --
-- no set role/set_config needed, this connection already IS the
-- privileged caller the function expects). All QA rows are cleaned up
-- inside the same transaction via ROLLBACK, so nothing persists even
-- on an unexpected pass-through.
--
-- Fill in real fixture values before running:
--   <qa-club-id>          -- any real club id
--   <qa-customer-id>      -- a freshly-inserted QA-marked customer in
--                             that club (name containing 'QA SECURITY
--                             TEST'), with a unique phone_e164 you
--                             control for this test
--   <qa-customer-phone-e164> -- that QA customer's own phone_e164
--   <raw-token>, <raw-secret> -- captured from the _mint_portal_invite_internal
--                             result in step 10a below
--   <unrelated-existing-user-id> -- any real, pre-existing auth user id
--                             NOT otherwise linked to <qa-customer-id>
--                             (e.g. the platform_owner fixture used in
--                             the original live reproduction; also used
--                             below only as the mint's p_created_by
--                             actor, which is unrelated to this test)
--
-- EXPECTED: the final claim_portal_invite_service() call raises
-- 'this account cannot be linked to this invite' and customers.user_id
-- for <qa-customer-id> remains NULL afterward (proven by the SELECT
-- right before ROLLBACK).
-- ============================================================
begin;
-- 10a. Mint a fresh invite for the QA customer and verify BOTH factors
-- correctly, exactly as a genuine customer would (this part is
-- supposed to succeed -- it is not what this test is proving).
-- _mint_portal_invite_internal(p_club_id, p_customer_id,
-- p_triggering_booking_id, p_expires_at, p_created_by) returns
-- table(raw_token, raw_secret) -- capture both as <raw-token> and
-- <raw-secret> for the calls below (only their hashes are persisted):
select * from public._mint_portal_invite_internal(
  '<qa-club-id>'::uuid, '<qa-customer-id>'::uuid, null,
  now() + interval '1 day', '<unrelated-existing-user-id>'::uuid
);
-- Verify phone with the QA customer's real phone_e164:
select public.verify_portal_invite_phone('<raw-token>', '<qa-customer-phone-e164>');
-- Verify the independent secret captured from the mint call above:
select public.verify_portal_invite_secret('<raw-token>', '<raw-secret>');

-- 10b. THE ACTUAL TEST: claim with an unrelated, pre-existing user id
-- that never touched phone/secret verification for this invite.
select public.claim_portal_invite_service('<raw-token>', '<unrelated-existing-user-id>'::uuid);
-- ^ MUST raise 'this account cannot be linked to this invite' and abort

-- Sanity check (only reached if the statement above did NOT error --
-- i.e. the bug has regressed):
select user_id from public.customers where id = '<qa-customer-id>'::uuid;
-- ^ must be NULL
rollback;

-- ============================================================
-- TEST 11: grant-layer backstop on staff-only RPCs whose signature
-- changed via CREATE OR REPLACE (structural check -- catches a
-- future signature-changing migration that silently re-widens EXECUTE
-- to anon/PUBLIC, the exact regression fixed in
-- 20260824230500_regrant_staff_only_rpcs_after_signature_change.sql
-- for qr_validate, create_booking, and get_official_receipts_report;
-- this same bug had already occurred once before and been fixed for
-- qr_validate/qr_confirm_checkin in
-- 20260823010000_qr_diagnostic_codes.sql). No live data needed.
-- EXPECTED: 0 rows (no function below should show anon or bare-PUBLIC
-- EXECUTE)
-- ============================================================
select p.oid::regprocedure as signature
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('qr_validate', 'qr_confirm_checkin', 'create_booking', 'get_official_receipts_report')
  and (
    has_function_privilege('anon', p.oid, 'EXECUTE')
    or exists (
      select 1 from unnest(p.proacl) a
      where a::text like '=%/%'  -- bare PUBLIC entry has no role name before the '='
    )
  );

-- Live-role reproduction of the same check for qr_validate specifically
-- (the function that actually regressed) -- confirms the grant layer
-- itself now blocks anon, not just the function's internal auth check:
-- EXPECTED: raises 42501 "permission denied for function qr_validate"
-- (grant-layer rejection), NOT P0001 "authentication required"
-- (which would mean the grant layer still let anon through and only
-- the internal check caught it).
begin;
set role anon;
select public.qr_validate('QA SECURITY TEST - regression check, must fail at grant layer');
reset role;
rollback;

-- ============================================================
-- TEST PAYMENTS-INSERT-REVOKE: direct client INSERT into public.payments is blocked
-- (fixed in 20260824240000_revoke_direct_payments_insert_grant.sql --
-- confirmed-exploitable finding: payments_insert_with_permission RLS
-- only checked club/permission/branch, not amount, invoice linkage,
-- cash-shift custody, or receipts, and record_payment()'s own guards
-- for all of that live purely in PL/pgSQL with no DB-level backstop).
-- Point at a real Receptionist (or any staff user holding
-- payment.create) and a real 'issued' invoice with outstanding balance
-- in that same club/branch.
-- EXPECTED: the INSERT raises a permission-denied error (query errors
-- out, no row returned) -- table-level REVOKE now blocks it before RLS
-- is even evaluated. 0 rows exist afterward with the QA reference below.
-- Run inside a transaction and ROLLBACK so no residue is left even if
-- the bug has regressed and the insert unexpectedly succeeds.
-- ============================================================
begin;
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<staff-user-id>','role','authenticated')::text, true);
insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by)
values ('<that-users-club-id>', '<a-branch-id-in-that-club>', '<a-real-customer-id-in-that-club>', 'cash', 99999.00, 'QA SECURITY TEST - direct insert bypass, must fail', '<staff-user-id>');
-- ^ must raise "permission denied for table payments" and abort the transaction (no row returned)
reset role;
rollback;
-- if the statement above did NOT error, run this as a sanity check (should be 0):
-- select count(*) from public.payments where reference = 'QA SECURITY TEST - direct insert bypass, must fail';

-- ============================================================
-- TEST PAYMENTS-INSERT-REVOKE-b: negative control -- record_payment() (the SECURITY DEFINER
-- RPC, the only legitimate write path) still works for the same staff
-- user after the REVOKE above, proving the fix removed only the direct
-- client INSERT path and did not break the real payment-recording flow.
-- Point at a real 'issued' invoice with outstanding balance >= 10.00 in
-- a club/branch the staff user has payment.create + branch access to.
-- EXPECTED: returns a payment id (no error).
-- ============================================================
begin;
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<staff-user-id>','role','authenticated')::text, true);
select public.record_payment('<an-issued-invoice-id-with-outstanding-balance>'::uuid, 10.00, 'cash', 'QA SECURITY TEST - negative control, record_payment still works', gen_random_uuid()) as still_works;
-- ^ must return a uuid, not error
reset role;
rollback;

-- ============================================================
-- TEST 13: get_public_payment_methods_for_booking / get_public_booking_
-- receipt_contact no longer serve a club's live payment/contact
-- details for a booking that is no longer awaiting payment (fixed in
-- 20260824230000_scope_public_payment_rpcs_to_active_booking.sql --
-- confirmed-exploitable finding: these anon-callable RPCs trusted a
-- bare booking_id with no independent secret factor, unlike every
-- sibling RPC on this surface which requires a real token. Verified
-- live pre-fix: `set role anon; select * from
-- get_public_payment_methods_for_booking('<real booking_id>')`
-- returned the club's live Instapay wallet phone + beneficiary name).
--
-- Point at any real, existing 'pending_payment' booking_id (no new QA
-- data needed to prove the fix -- this only ever reads, then flips
-- status and rolls back, so the real booking is left untouched).
-- Find one first if needed:
-- select id from public.bookings where status = 'pending_payment' limit 1;
-- EXPECTED: sub-test A (still pending_payment) returns > 0 methods
-- (assuming that club has an active/visible payment method) --
-- proving the fix did not break the legitimate in-progress-payment
-- case. Sub-test B (same booking, forced to 'cancelled' inside the
-- same rolled-back transaction) returns 0 rows from both RPCs -- the
-- actual regression guard for this fix.
-- ============================================================
begin;
select id, status from public.bookings where id = '<a-real-pending-payment-booking-id>'::uuid;
-- ^ sanity check: confirm status = 'pending_payment' before proceeding

-- Sub-test A: while genuinely pending_payment (the normal
-- guest-completing-checkout state), both RPCs must still work for
-- anon -- this is the legitimate, unchanged use case.
set role anon;
select count(*) as methods_visible_while_pending
from public.get_public_payment_methods_for_booking('<a-real-pending-payment-booking-id>'::uuid);
-- ^ EXPECTED: > 0 (assuming the target club has an active/visible payment method configured)
reset role;

-- Sub-test B: force this booking out of pending_payment (simulating a
-- confirmed/completed/cancelled booking) and re-check anon access.
-- Still inside the same transaction -- rolled back below, so the real
-- booking's status is never actually changed.
update public.bookings set status = 'cancelled' where id = '<a-real-pending-payment-booking-id>'::uuid;

set role anon;
select count(*) as methods_visible_after_cancelled
from public.get_public_payment_methods_for_booking('<a-real-pending-payment-booking-id>'::uuid);
-- ^ EXPECTED: 0 -- this is the actual regression guard for the fix

select count(*) as contact_visible_after_cancelled
from public.get_public_booking_receipt_contact('<a-real-pending-payment-booking-id>'::uuid);
-- ^ EXPECTED: 0 -- this is the actual regression guard for the fix
reset role;

rollback;
-- ^ the status update above is discarded -- the real booking is left exactly as it was.
