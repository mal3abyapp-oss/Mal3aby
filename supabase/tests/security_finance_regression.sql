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
