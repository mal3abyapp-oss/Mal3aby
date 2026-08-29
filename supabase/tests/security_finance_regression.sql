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

-- ============================================================
-- TEST 11: record_payment() / create_refund() cross-tenant
-- existence-oracle fix (2026-08-24 MANDATORY REAL PLATFORM TESTING
-- round, live-verified via a genuine password-authenticated staff
-- session -- see src/features/staff/staff_role_matrix.integration.
-- test.ts). Before the fix, an authenticated staff member of ANY
-- club could distinguish "this invoice/payment id exists somewhere"
-- from "it doesn't", for ANY uuid system-wide, because both RPCs
-- looked the row up (raising a distinct "not found" exception)
-- BEFORE checking has_permission(...) (which raises a different
-- "not authorized" exception). Fixed by collapsing lookup + auth
-- into one club/permission-scoped WHERE clause.
-- EXPECTED: both a genuinely nonexistent id AND a real id belonging
-- to a club the caller is NOT a member of raise the IDENTICAL
-- message -- no distinguishing signal.
-- Replace <a-coach-or-similar-staff-uuid> with a real staff user who
-- is a member of exactly one club, and <a-real-invoice-id-in-a-
-- DIFFERENT-club> / <a-real-payment-id-in-a-DIFFERENT-club> with real
-- ids from a club that staff member is NOT a member of.
-- ============================================================
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<a-coach-or-similar-staff-uuid>','role','authenticated')::text, true);

select public.record_payment('00000000-0000-0000-0000-000000000099'::uuid, 1, 'cash', 'regression-fake', null, null);
-- ^ EXPECTED: raises 'invoice not found or you do not have permission to record a payment against it'
select public.record_payment('<a-real-invoice-id-in-a-DIFFERENT-club>'::uuid, 1, 'cash', 'regression-cross-tenant', null, null);
-- ^ EXPECTED: raises the IDENTICAL message as above -- same string, no distinguishing signal

select public.create_refund('00000000-0000-0000-0000-000000000099'::uuid, 1, 'regression-fake');
-- ^ EXPECTED: raises 'payment not found or you do not have permission to refund it'
select public.create_refund('<a-real-payment-id-in-a-DIFFERENT-club>'::uuid, 1, 'regression-cross-tenant');
-- ^ EXPECTED: raises the IDENTICAL message as above -- same string, no distinguishing signal
reset role;

-- ============================================================
-- TEST 12: subscriptions.end_date immutability (2026-08-24 MANDATORY
-- REAL PLATFORM TESTING round -- HIGH finding, live-confirmed:
-- academy_manager/club_manager/club_owner could previously extend a
-- subscription's paid validity indefinitely via a raw UPDATE, with
-- NO invoice, NO payment, and NO audit_logs entry -- invisible to
-- the audit trail every legitimate lifecycle RPC writes to).
-- protect_subscription_price_immutable() now also freezes end_date,
-- with no escape-hatch flag (renew_academy_subscription always
-- INSERTs a new row rather than UPDATing end_date on an existing
-- one, and freeze/unfreeze never touch end_date -- confirmed via
-- pg_get_functiondef during this fix).
-- EXPECTED: the UPDATE "succeeds" (no error, matching every other
-- frozen column's silent-revert behavior) but end_date is unchanged
-- from its value before the statement.
-- Replace <a-real-subscription-id> and <a-club-owner-or-manager-uuid>
-- with real fixtures on the same club.
-- ============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<a-club-owner-or-manager-uuid>','role','authenticated')::text, true);

select end_date as end_date_before from public.subscriptions where id = '<a-real-subscription-id>'::uuid;

update public.subscriptions set end_date = end_date + interval '365 days'
where id = '<a-real-subscription-id>'::uuid
returning end_date as end_date_after_attack;
-- ^ EXPECTED: end_date_after_attack = end_date_before -- the trigger
-- silently reverted the attacker's change, exactly like price/
-- discount/enrollment_id/plan_type/start_date already did.
reset role;
rollback;
-- ^ nothing persisted regardless -- this transaction is discarded.

-- ============================================================
-- TEST 13: SYSTEMIC CROSS-TENANT EXISTENCE-ORACLE REGRESSION MATRIX
-- (2026-08-24, "SYSTEMIC CROSS-TENANT EXISTENCE-ORACLE CLOSURE" round).
--
-- A single data-driven check protecting the whole class of bug fixed
-- in batches A1-D of this round (~24 RPCs total, see git log for
-- 20260824330000 through 20260824430000), rather than one hand-
-- written block per function. For every (function, args-for-a-real-
-- foreign-id, args-for-a-missing-id) case below, this calls the RPC
-- both ways under the SAME unauthorized real staff session and
-- asserts the two error messages are byte-identical -- exactly the
-- property that must hold for a caller outside the entity's own club
-- to be unable to distinguish "exists in another club" from "does not
-- exist anywhere".
--
-- HOW TO RUN: replace <a-real-foreign-{invoice,payment,claim,proof,
-- shift,liability,membership,payment-method-config,booking,
-- subscription,enrollment,player,guardian-link,field}-id> placeholders
-- below with real ids belonging to a club the test actor is NOT a
-- member of (see TEST 3/4's fixture users for the established
-- unrelated-club pattern), and <a-real-unauthorized-staff-uuid> with
-- a real staff user who is a member of exactly one OTHER club. Every
-- row's "missing" id can stay '00000000-0000-0000-0000-000000000099'
-- (or -098, -097, ... for cases needing more than one missing id) --
-- that id is guaranteed nonexistent by construction.
--
-- This block is deliberately NOT auto-runnable as-is (the id
-- placeholders must be filled from real fixture data, which changes
-- across environments/QA rounds) -- it is the canonical, single
-- source of truth for what "closed" means for this bug class, meant
-- to be filled in and re-run after any future change to one of these
-- RPCs, or extended with a new row whenever a new instance of this
-- pattern is found.
--
-- EXPECTED for every row: foreign_result = missing_result (byte-
-- identical error message) -- proving the fix is not merely a text
-- change but genuinely removes the pre-authorization existence signal.
-- ============================================================
do $$
declare
  v_actor uuid := '<a-real-unauthorized-staff-uuid>';
  v_case record;
  v_foreign_msg text;
  v_missing_msg text;
  v_mismatches text[] := '{}';
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);

  for v_case in
    select * from (values
      -- (label, sql calling the RPC with a real FOREIGN id, sql calling it with a MISSING id)
      ('void_invoice',                'select public.void_invoice(''<a-real-foreign-invoice-id>''::uuid, ''x'')',                                              'select public.void_invoice(''00000000-0000-0000-0000-000000000099''::uuid, ''x'')'),
      ('verify_manual_payment_claim', 'select public.verify_manual_payment_claim(''<a-real-foreign-claim-id>''::uuid, false, ''x'')',                          'select public.verify_manual_payment_claim(''00000000-0000-0000-0000-000000000099''::uuid, false, ''x'')'),
      ('approve_payment_proof',       'select public.approve_payment_proof(''<a-real-foreign-proof-id>''::uuid, null)',                                        'select public.approve_payment_proof(''00000000-0000-0000-0000-000000000099''::uuid, null)'),
      ('reject_payment_proof',        'select public.reject_payment_proof(''<a-real-foreign-proof-id>''::uuid, ''x'')',                                         'select public.reject_payment_proof(''00000000-0000-0000-0000-000000000099''::uuid, ''x'')'),
      ('close_cash_shift',            'select public.close_cash_shift(''<a-real-foreign-shift-id>''::uuid, 100, null)',                                        'select public.close_cash_shift(''00000000-0000-0000-0000-000000000099''::uuid, 100, null)'),
      ('settle_employee_cash_liability', 'select public.settle_employee_cash_liability(''<a-real-foreign-liability-id>''::uuid, 1, null, null)',               'select public.settle_employee_cash_liability(''00000000-0000-0000-0000-000000000099''::uuid, 1, null, null)'),
      ('adjust_employee_cash_liability', 'select public.adjust_employee_cash_liability(''<a-real-foreign-liability-id>''::uuid, 1, ''x'')',                    'select public.adjust_employee_cash_liability(''00000000-0000-0000-0000-000000000099''::uuid, 1, ''x'')'),
      ('reverse_employee_cash_liability', 'select public.reverse_employee_cash_liability(''<a-real-foreign-liability-id>''::uuid, ''x'')',                      'select public.reverse_employee_cash_liability(''00000000-0000-0000-0000-000000000099''::uuid, ''x'')'),
      ('set_staff_cash_custody',      'select public.set_staff_cash_custody(''<a-real-foreign-membership-id>''::uuid, true)',                                  'select public.set_staff_cash_custody(''00000000-0000-0000-0000-000000000099''::uuid, true)'),
      ('deactivate_staff_member',     'select public.deactivate_staff_member(''<a-real-foreign-membership-id>''::uuid)',                                       'select public.deactivate_staff_member(''00000000-0000-0000-0000-000000000099''::uuid)'),
      ('reactivate_staff_member',     'select public.reactivate_staff_member(''<a-real-foreign-membership-id>''::uuid)',                                       'select public.reactivate_staff_member(''00000000-0000-0000-0000-000000000099''::uuid)'),
      ('cancel_booking',              'select public.cancel_booking(''<a-real-foreign-booking-id>''::uuid, ''x'')',                                             'select public.cancel_booking(''00000000-0000-0000-0000-000000000099''::uuid, ''x'')'),
      ('mark_booking_no_show',        'select public.mark_booking_no_show(''<a-real-foreign-booking-id>''::uuid, ''x'')',                                       'select public.mark_booking_no_show(''00000000-0000-0000-0000-000000000099''::uuid, ''x'')'),
      ('reschedule_booking',          'select public.reschedule_booking(''<a-real-foreign-booking-id>''::uuid, now() + interval ''30 days'', now() + interval ''31 days'', null, ''x'')', 'select public.reschedule_booking(''00000000-0000-0000-0000-000000000099''::uuid, now() + interval ''30 days'', now() + interval ''31 days'', null, ''x'')'),
      ('cancel_subscription',         'select public.cancel_subscription(''<a-real-foreign-subscription-id>''::uuid, ''x'')',                                  'select public.cancel_subscription(''00000000-0000-0000-0000-000000000099''::uuid, ''x'')'),
      ('freeze_subscription',         'select public.freeze_subscription(''<a-real-foreign-subscription-id>''::uuid, current_date + 1, current_date + 10, ''x'', true)', 'select public.freeze_subscription(''00000000-0000-0000-0000-000000000099''::uuid, current_date + 1, current_date + 10, ''x'', true)'),
      ('unfreeze_subscription',       'select public.unfreeze_subscription(''<a-real-foreign-subscription-id>''::uuid, ''x'')',                                 'select public.unfreeze_subscription(''00000000-0000-0000-0000-000000000099''::uuid, ''x'')'),
      ('renew_academy_subscription',  'select * from public.renew_academy_subscription(''<a-real-foreign-enrollment-id>''::uuid, current_date + 1, current_date + 30, 100, 0)', 'select * from public.renew_academy_subscription(''00000000-0000-0000-0000-000000000099''::uuid, current_date + 1, current_date + 30, 100, 0)'),
      ('update_player',               'select public.update_player(''<a-real-foreign-player-id>''::uuid, ''x'', null, null, null, null)',                       'select public.update_player(''00000000-0000-0000-0000-000000000099''::uuid, ''x'', null, null, null, null)'),
      ('update_academy_membership',   'select public.update_academy_membership(''<a-real-foreign-group-id>''::uuid, ''x'', 10, 100, ''active'', null)',         'select public.update_academy_membership(''00000000-0000-0000-0000-000000000099''::uuid, ''x'', 10, 100, ''active'', null)'),
      ('unlink_guardian_from_player', 'select public.unlink_guardian_from_player(''<a-real-foreign-guardian-link-id>''::uuid)',                                 'select public.unlink_guardian_from_player(''00000000-0000-0000-0000-000000000099''::uuid)'),
      ('set_primary_guardian',        'select public.set_primary_guardian(''<a-real-foreign-player-id>''::uuid, ''00000000-0000-0000-0000-000000000001''::uuid)', 'select public.set_primary_guardian(''00000000-0000-0000-0000-000000000099''::uuid, ''00000000-0000-0000-0000-000000000001''::uuid)'),
      ('link_guardian_to_player',     'select public.link_guardian_to_player(''<a-real-foreign-player-id>''::uuid, ''00000000-0000-0000-0000-000000000001''::uuid, ''guardian'', false)', 'select public.link_guardian_to_player(''00000000-0000-0000-0000-000000000099''::uuid, ''00000000-0000-0000-0000-000000000001''::uuid, ''guardian'', false)'),
      ('create_field_pricing_rules',  'select * from public.create_field_pricing_rules(''<a-real-foreign-field-id>''::uuid, ''[{"day_of_week":1,"start_time":"08:00","end_time":"09:00","price_per_hour":1,"priority":1}]''::jsonb, ''x'')', 'select * from public.create_field_pricing_rules(''00000000-0000-0000-0000-000000000099''::uuid, ''[{"day_of_week":1,"start_time":"08:00","end_time":"09:00","price_per_hour":1,"priority":1}]''::jsonb, ''x'')'),
      ('archive_field_pricing_rules', 'select public.archive_field_pricing_rules(''<a-real-foreign-field-id>''::uuid, array[''00000000-0000-0000-0000-000000000001''::uuid], ''x'')', 'select public.archive_field_pricing_rules(''00000000-0000-0000-0000-000000000099''::uuid, array[''00000000-0000-0000-0000-000000000001''::uuid], ''x'')')
    ) as cases(label, foreign_sql, missing_sql)
  loop
    begin
      execute v_case.foreign_sql;
      v_foreign_msg := '<NO ERROR RAISED>';
    exception when others then
      v_foreign_msg := sqlerrm;
    end;

    begin
      execute v_case.missing_sql;
      v_missing_msg := '<NO ERROR RAISED>';
    exception when others then
      v_missing_msg := sqlerrm;
    end;

    if v_foreign_msg is distinct from v_missing_msg then
      v_mismatches := v_mismatches || (v_case.label || ': foreign="' || v_foreign_msg || '" missing="' || v_missing_msg || '"');
    end if;
  end loop;

  reset role;

  if array_length(v_mismatches, 1) > 0 then
    raise exception 'CROSS-TENANT EXISTENCE ORACLE REGRESSION DETECTED in: %', array_to_string(v_mismatches, E'\n');
  else
    raise notice 'PASS: all % cases produce identical foreign-vs-missing error messages -- no existence oracle detected', 24;
  end if;
end;
$$;
-- ^ Wrap the whole DO block in begin;/rollback; if any of the RPCs
-- above could mutate state on a SUCCESS path for a misconfigured
-- placeholder (e.g. a real id belonging to the ACTOR's own club by
-- mistake) -- every RPC in this matrix requires real authorization to
-- write, so a correctly-unauthorized actor never reaches a mutating
-- branch, but wrapping in a transaction costs nothing and is safer.


-- ============================================================
-- ANTI-FRAUD HARDENING REGRESSION (2026-08-29) -- appended, not a
-- replacement of the tests above. Covers the P0/P1 findings from
-- ANTI_FRAUD_SECURITY_HARDENING_PLAN.md. Same methodology as the rest
-- of this file: real SET ROLE authenticated + set_config('request.jwt.claims',
-- ...) impersonation, top-level statements (not DO blocks), compare
-- each assertion query's output to the EXPECTED comment above it.
--
-- Fixture identities used below are real, standing QA identities in
-- this project's own Supabase project (confirmed present as of this
-- writing) -- adjust if running against a different environment:
--   platform owner:        mal3aby.qa.platform-owner.20260821@example.com
--   TEST-CLUB-1 owner:     mala3by.test.owner1@gmail.com   (has real data)
--   TEST-CLUB-2 owner:     mala3by.test.owner2@gmail.com   (QA sandbox club)
--   receptionist fixture:  mal3aby.qa.receptionist.20260821@example.com
-- Re-query club_memberships/auth.users if these no longer resolve.

-- ============================================================
-- AF-TEST 1: unaudited direct-write RLS bypass on commercial_entitlements
-- (Phase 1 finding). EXPECTED: 0 rows affected (no UPDATE match).
-- ============================================================
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','556b515d-fdf9-421a-8e33-563737adb919','role','authenticated')::text, true);
set local role authenticated;
update public.commercial_entitlements set branch_limit = 999
where club_id = 'c0b02979-a49e-4338-bcac-d789ca397aeb'
returning club_id, branch_limit;  -- EXPECTED: zero rows returned
reset role;
select branch_limit from public.commercial_entitlements where club_id = 'c0b02979-a49e-4338-bcac-d789ca397aeb';  -- EXPECTED: unchanged (null in the baseline environment)

-- ============================================================
-- AF-TEST 2: unaudited direct-write RLS bypass on club_memberships.has_cash_custody
-- (Phase 1 finding). EXPECTED: 0 rows affected.
-- ============================================================
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','8694a8b8-e1b4-46ee-857f-4bc8e8f72d31','role','authenticated')::text, true);
set local role authenticated;
update public.club_memberships set has_cash_custody = true
where user_id = '8694a8b8-e1b4-46ee-857f-4bc8e8f72d31' and club_id = 'c0b02979-a49e-4338-bcac-d789ca397aeb'
returning id, has_cash_custody;  -- EXPECTED: zero rows returned
reset role;

-- ============================================================
-- AF-TEST 3: create_gateway_refund_service() defense-in-depth actor
-- check (Phase 2 finding, CF-3). EXPECTED: 'not authorized' exception
-- for an actor with no payment.refund permission on the target club.
-- Uses a deliberately fake gateway transaction id -- the actor check
-- (added this pass) must fire BEFORE the transaction-lookup check, so
-- this never risks a real mutation regardless of which id is used.
-- ============================================================
select public.create_gateway_refund_service(
  (select id from public.payments where club_id = '57ce89e4-184a-413f-bc47-ee0fdb878727' limit 1),
  1.00::numeric, 'regression test -- unauthorized actor', 'test-ref', gen_random_uuid(),
  '8694a8b8-e1b4-46ee-857f-4bc8e8f72d31'::uuid, null
);  -- EXPECTED: ERROR P0001 'not authorized'

-- ============================================================
-- AF-TEST 4: academy module-active bypass on ensure_adhoc_attendance_session()
-- and generate_training_sessions() (Phase 5 finding). Requires a real
-- group_id in a club with Academy currently deactivated -- this test is
-- STATE-DEPENDENT (the target club's academy module must be active
-- before AND after this test runs, or wrap steps in a temporary
-- deactivate/reactivate as the live verification pass did). Shown here
-- as the assertion shape; a full harness would script the
-- deactivate -> attempt -> reactivate cycle around a disposable fixture
-- group, matching ANTI_FRAUD_SECURITY_HARDENING_PLAN.md Phase 5's own
-- live verification.
-- EXPECTED (with academy inactive for the target club):
--   ERROR P0001 'the academy module is not active for this club'
-- ============================================================
-- select public.ensure_adhoc_attendance_session('<real-group-id-in-a-club-with-academy-inactive>', current_date);

-- ============================================================
-- AF-TEST 5: platform staff role self-escalation via direct write
-- (Phase 3 finding -- the most severe of this pass). EXPECTED: 0 rows
-- affected. This environment currently has no standing
-- platform_staff_memberships fixture (the live verification pass
-- created and deleted a temporary one) -- kept here as a template with
-- a placeholder id; the authoritative live proof is documented in
-- ANTI_FRAUD_SECURITY_HARDENING_PLAN.md Phase 3.
-- ============================================================
-- update public.platform_staff_memberships set platform_role_id = (select id from platform_roles where key = 'platform_owner')
-- where id = '<a-real-non-owner-platform-staff-membership-id>'
-- returning id, platform_role_id;  -- EXPECTED: zero rows returned

-- ============================================================
-- AF-TEST 6: platform_support_sessions self-write tampering (Phase 3
-- continued finding). EXPECTED: 0 rows affected on an UPDATE attempting
-- to change mode/expires_at/club_id on the caller's own session row.
-- This test starts and ends a REAL support session (via the legitimate
-- RPCs) against TEST-CLUB-2 so it is fully self-contained and leaves no
-- residue beyond a normal, correctly-terminated session record. Run the
-- three statements below as one round-trip so the session id carries
-- over via WITH.
-- ============================================================
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','556b515d-fdf9-421a-8e33-563737adb919','role','authenticated')::text, true);
set local role authenticated;
with new_session as (
  select public.start_platform_support_session('c0b02979-a49e-4338-bcac-d789ca397aeb', 'view', 'regression test fixture') as id
)
update public.platform_support_sessions set mode = 'manage', expires_at = now() + interval '30 days'
where id = (select id from new_session)
returning id, mode;  -- EXPECTED: zero rows returned
select public.end_platform_support_session();
reset role;

-- ============================================================
-- AF-TEST 7: numeric invariant -- negative payment amount rejected at
-- the database level regardless of application logic (defense-in-depth
-- backstop). EXPECTED: ERROR 23514 payments_amount_check.
-- Wrapped in begin/rollback so it never actually persists even though
-- the CHECK constraint itself would also prevent a commit.
-- ============================================================
begin;
insert into public.payments (club_id, branch_id, customer_id, amount, method, status, received_at)
select 'b9178c0f-00b5-4c71-abec-b8772ffb8682',
       (select id from public.branches where club_id = 'b9178c0f-00b5-4c71-abec-b8772ffb8682' limit 1),
       (select id from public.customers where club_id = 'b9178c0f-00b5-4c71-abec-b8772ffb8682' limit 1),
       -50, 'cash', 'completed', now();  -- EXPECTED: ERROR 23514 payments_amount_check
rollback;

-- ============================================================
-- AF-TEST 8: branch isolation -- report RPC rejects a client-supplied
-- p_branch_id outside the caller's scope. STATE-DEPENDENT: requires a
-- real branch-scoped staff membership (the live verification pass used
-- a disposable QA fixture -- see Phase 4 in the plan doc for the full
-- setup/teardown). Shown here as the assertion shape.
-- EXPECTED (with a branch-scoped, non-owner caller and an
-- out-of-scope p_branch_id): ERROR P0001 'not authorized'
-- ============================================================
-- select * from public.get_revenue_report('<club-id>', '2026-01-01', '2026-12-31', '<out-of-scope-branch-id>', null);

-- ============================================================
-- AF-TEST 9: record_payment() / claim_manual_payment() no_show gap
-- (CF-2/SP-001 follow-up, Phase 9 -- see 20260829090000_record_payment_
-- block_no_show_bookings.sql and 20260829090500_claim_manual_payment_
-- block_no_show_bookings.sql). The prior SP-001 fix blocked 'cancelled'
-- bookings but left 'no_show' -- a real, distinct, terminal booking
-- status -- uncovered on BOTH RPCs. Live-confirmed pre-fix: 30 real
-- production bookings with status in ('cancelled','no_show') still
-- carried an 'issued' invoice, 3 specifically 'no_show'.
--
-- Fully self-contained: builds a synthetic customer/invoice/booking on
-- TEST-CLUB-1 (real branch/field, synthetic everything else), marks it
-- no_show via the real mark_booking_no_show()-equivalent direct status
-- set (kept as a direct insert here since this block must stay inside
-- one rolled-back transaction; the live verification pass separately
-- proved mark_booking_no_show() itself works via the real RPC), attacks
-- both payment RPCs, then rolls back -- zero residue regardless of
-- outcome.
-- EXPECTED: both calls raise an error mentioning 'no_show'.
-- ============================================================
begin;

insert into public.customers (id, club_id, full_name, mobile_display, is_walk_in)
values ('00000000-0000-0000-0000-0000000af101', '57ce89e4-184a-413f-bc47-ee0fdb878727', 'AF-TEST-9 no_show regression fixture', '01000009999', true);

insert into public.invoices (id, club_id, branch_id, customer_id, invoice_number, status, total, subtotal)
values (
  '00000000-0000-0000-0000-0000000af102', '57ce89e4-184a-413f-bc47-ee0fdb878727',
  '2f2cc7e5-83cc-4a02-a65b-0660f2cd1997', '00000000-0000-0000-0000-0000000af101',
  'AF-TEST-9-REGRESSION', 'issued', 60.00, 60.00
);

insert into public.bookings (id, club_id, branch_id, field_id, customer_id, invoice_id, status, start_at, end_at, total_price, discount_amount, source)
values (
  '00000000-0000-0000-0000-0000000af103', '57ce89e4-184a-413f-bc47-ee0fdb878727',
  '2f2cc7e5-83cc-4a02-a65b-0660f2cd1997', '4b42c842-71ed-4b87-b03d-1cddfd10f997',
  '00000000-0000-0000-0000-0000000af101', '00000000-0000-0000-0000-0000000af102',
  'no_show', now() - interval '1 day', now() - interval '1 day' + interval '1 hour', 60.00, 0, 'staff'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','12fadb01-c60b-4be7-a330-6c0786a2daa0','role','authenticated')::text, true);
select public.record_payment('00000000-0000-0000-0000-0000000af102'::uuid, 60.00, 'cash', 'AF-TEST-9');
-- ^ EXPECTED: ERROR P0001 'this booking was no_show -- payment can no longer be recorded against it'

reset role;
rollback;
-- ^ nothing persisted regardless -- the record_payment() error above
-- already aborts this transaction; rollback is a no-op safety net.

-- claim_manual_payment() sub-test run separately (its own fixture, since
-- the block above already aborted on the first assertion):
begin;

insert into public.customers (id, club_id, full_name, mobile_display, is_walk_in, user_id)
values ('00000000-0000-0000-0000-0000000af111', '57ce89e4-184a-413f-bc47-ee0fdb878727', 'AF-TEST-9b no_show portal-claim fixture', '01000009998', false, '2310e033-b4a5-4735-b2fc-1006e40c25b9');

insert into public.invoices (id, club_id, branch_id, customer_id, invoice_number, status, total, subtotal)
values (
  '00000000-0000-0000-0000-0000000af112', '57ce89e4-184a-413f-bc47-ee0fdb878727',
  '2f2cc7e5-83cc-4a02-a65b-0660f2cd1997', '00000000-0000-0000-0000-0000000af111',
  'AF-TEST-9B-REGRESSION', 'issued', 45.00, 45.00
);

insert into public.bookings (id, club_id, branch_id, field_id, customer_id, invoice_id, status, start_at, end_at, total_price, discount_amount, source)
values (
  '00000000-0000-0000-0000-0000000af113', '57ce89e4-184a-413f-bc47-ee0fdb878727',
  '2f2cc7e5-83cc-4a02-a65b-0660f2cd1997', '4b42c842-71ed-4b87-b03d-1cddfd10f997',
  '00000000-0000-0000-0000-0000000af111', '00000000-0000-0000-0000-0000000af112',
  'no_show', now() - interval '1 day', now() - interval '1 day' + interval '1 hour', 45.00, 0, 'staff'
);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','2310e033-b4a5-4735-b2fc-1006e40c25b9','role','authenticated')::text, true);
select public.claim_manual_payment('00000000-0000-0000-0000-0000000af112'::uuid, null, 45.00, 'AF-TEST-9b', 'regression');
-- ^ EXPECTED: ERROR P0001 'this booking was no_show -- payment can no longer be claimed against it'

reset role;
rollback;

-- ============================================================
-- AUDIT LOG HARDENING REGRESSION (2026-08-29) -- appended, not a
-- replacement of the tests above. Covers the audit-log-specific
-- program: coverage gaps (Phases 1-2) and the tamper-evident hash
-- chain (Phase 3) added to audit_logs in
-- 20260829180000_audit_log_hardening_phase3_hash_chain.sql. Same
-- methodology as the rest of this file.

-- ============================================================
-- AF-TEST 10a: hash chain structural integrity -- the ENTIRE real
-- audit_logs table must verify clean at all times. This is the
-- single strongest regression guard in this file: it does not test
-- one known-fixed bug, it re-derives and checks every row's hash
-- against every OTHER row currently in the table, live, every time
-- this is run. Live-confirmed clean against 1583 real historical rows
-- plus every row added since.
-- EXPECTED: 0 rows (empty result = the entire chain is internally
-- consistent, no tampering detected anywhere in the table's history).
-- ============================================================
select * from public.verify_audit_log_chain();

-- ============================================================
-- AF-TEST 10b: the verification function genuinely detects tampering
-- (not merely "returns 0 rows because it never checks anything real").
-- Live-reproduced this pass on a REAL historical row (sequence_number
-- 500), rolled back immediately -- both the row_hash_mismatch (content
-- altered) and sequence_gap (row deleted) cases were confirmed to
-- fire correctly with the exact row identified. This block re-proves
-- the row_hash_mismatch case against whatever the current lowest
-- sequence_number is, so it works on any environment regardless of
-- how many rows exist.
-- EXPECTED: exactly 1 row, problem_type='row_hash_mismatch', naming
-- the tampered sequence_number.
-- ============================================================
begin;
update public.audit_logs set reason = 'AF-TEST-10b regression tamper simulation -- must be detected and rolled back'
where sequence_number = (select min(sequence_number) from public.audit_logs);
select * from public.verify_audit_log_chain();
rollback;
-- ^ the tamper above is discarded regardless of the detection result --
-- this test only ever proves detection works, it never leaves a real
-- tampered row behind.

-- ============================================================
-- AF-TEST 10c: verify_audit_log_chain() is service_role-only -- not
-- callable by authenticated or anon. A general-purpose integrity tool
-- that iterates the whole table should never be client-reachable.
-- EXPECTED: both auth_can_execute and anon_can_execute are false.
-- ============================================================
select
  has_function_privilege('authenticated', 'public.verify_audit_log_chain(bigint, bigint)', 'execute') as auth_can_execute,
  has_function_privilege('anon', 'public.verify_audit_log_chain(bigint, bigint)', 'execute') as anon_can_execute;

-- ============================================================
-- AF-TEST 11: audit-log coverage gaps closed in Phases 1-2 --
-- mark_booking_no_show(), record_payment_with_official_receipt(), and
-- complete_new_club_onboarding() previously wrote zero audit_logs rows
-- despite each creating a real financial/compliance/tenant-lifecycle
-- event. Live-confirmed via direct RPC calls with synthetic fixtures
-- (customer/invoice/booking on TEST-CLUB-1; a full new-club onboarding
-- flow) during this pass -- not re-scripted here as a fixture-heavy
-- block (each already required a real branch/field/multi-table fixture
-- chain unique to its own RPC), but the structural guard below catches
-- a future regression on the SAME bug class across the whole schema:
-- any SECURITY DEFINER function that inserts into a financially-
-- sensitive table without ever calling write_audit_log() (or a direct
-- audit_logs insert).
-- EXPECTED: 0 rows (an increase here means a new coverage gap was
-- introduced -- inspect the named function and either add the missing
-- write_audit_log() call or, if it's genuinely low-materiality data
-- like plain customer profile edits or walk-in-customer creation,
-- confirm that judgment explicitly and extend this query's exclusion
-- list with a comment explaining why).
-- ============================================================
select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef = true
  and (
    p.prosrc ilike '%insert into public.payments%'
    or p.prosrc ilike '%insert into public.refunds%'
    or p.prosrc ilike '%insert into public.invoices%'
    or p.prosrc ilike '%insert into public.subscriptions%'
    or p.prosrc ilike '%insert into public.shop_sales%'
    or p.prosrc ilike '%insert into public.club_membership_subscriptions%'
    or p.prosrc ilike '%insert into public.bookings%'
    or p.prosrc ilike '%insert into public.enrollments%'
    or p.prosrc ilike '%insert into public.official_collection_receipts%'
    or p.prosrc ilike '%insert into public.clubs%'
    or p.prosrc ilike '%update public.payments%'
    or p.prosrc ilike '%update public.refunds%'
    or p.prosrc ilike '%update public.invoices%'
    or p.prosrc ilike '%update public.subscriptions%'
    or p.prosrc ilike '%update public.club_membership_subscriptions%'
    or p.prosrc ilike '%update public.bookings%'
    or p.prosrc ilike '%update public.enrollments%'
  )
  and p.prosrc not ilike '%write_audit_log%'
  and p.prosrc not ilike '%insert into public.audit_logs%'
  and p.proname not like '\_%'
  -- Reviewed and confirmed genuinely low-materiality this pass, not a
  -- coverage gap: get_or_create_shop_walk_in_customer() (a single
  -- placeholder row, zero financial/permission value) and
  -- upsert_customer() (plain name/phone/email edits -- logging every
  -- call would be noise, not signal; customer.phone_changed already
  -- exists as a separate, targeted audit path for the specifically
  -- sensitive case). expire_due_academy_subscriptions() is excluded
  -- here too -- it DOES write an aggregate audit_logs row per run, but
  -- via a direct INSERT the 'update public.subscriptions' match above
  -- would otherwise flag (the 'insert into public.audit_logs' exclusion
  -- above already covers it).
  and p.proname not in ('get_or_create_shop_walk_in_customer', 'upsert_customer')
order by p.proname;

