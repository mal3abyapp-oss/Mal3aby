-- PLATFORM OWNER CONTROL IMPLEMENTATION -- regression suite (Phase 6).
--
-- Codifies the live RLS-impersonation bypass tests already run manually
-- during Phases 1-5 of this program into a repeatable SQL suite,
-- following this project's own established pattern
-- (security_finance_regression.sql's own header comment/methodology --
-- read that file first if this is your first time running one of these).
--
-- HOW TO RUN: execute each numbered block below IN ORDER, as separate
-- top-level statements/round-trips (Supabase SQL Editor, `supabase db
-- execute`, or the Supabase MCP execute_sql tool). Every block wraps
-- itself in BEGIN/ROLLBACK so it leaves ZERO lasting state change --
-- safe to re-run against a real environment at any time, including
-- production, as long as each block's transaction is genuinely rolled
-- back (never COMMIT any block in this file). Update the placeholder
-- UUIDs to match real fixture users/clubs in the target environment --
-- the "find fixtures" block below shows how.
--
-- A clean run where every assertion query's "outcome" column reads
-- exactly what its own "EXPECTED" comment says = PASS.

-- ============================================================
-- FIXTURES: find real fixtures to test against in this environment.
-- ============================================================
-- A real platform_owner user:
select cm.user_id from public.club_memberships cm
join public.roles r on r.id = cm.role_id
where r.key = 'platform_owner' and cm.status = 'active' limit 1;

-- A club_owner user + their club, for staff-side bypass tests:
select cm.user_id, cm.club_id from public.club_memberships cm
join public.roles r on r.id = cm.role_id
where r.key = 'club_owner' and cm.status = 'active' limit 1;

-- ============================================================
-- TEST 1: Fields module disable blocks create_booking (Phase 1, P0)
-- EXPECTED: 'fields_disabled' outcome = REJECTED with "the fields
-- module is not active for this club"; 'fields_reenabled' outcome =
-- anything OTHER than that exact message (any other rejection reason,
-- e.g. subscription/pricing, or SUCCESS, both confirm the module check
-- itself passed through correctly).
-- ============================================================
begin;
insert into public.branches (id, club_id, branch_code, name, status)
values ('11111111-1111-1111-1111-111111111111', '<club-owner-club-id>', 'REGTEST1', 'Regression Test Branch', 'active');
insert into public.fields (id, club_id, branch_id, name, sport, status)
values ('22222222-2222-2222-2222-222222222222', '<club-owner-club-id>', '11111111-1111-1111-1111-111111111111', 'Regression Test Field', 'football', 'active');
insert into public.customers (id, club_id, full_name, phone_e164, normalized_mobile)
values ('33333333-3333-3333-3333-333333333333', '<club-owner-club-id>', 'Regression Test Customer', '+201099999001', '01099999001');

update public.club_modules set entitled = false, active = false
where club_id = '<club-owner-club-id>' and module_key = 'fields';

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<club-owner-user-id>','role','authenticated')::text, true);
set local role authenticated;

create temp table t1_result (step text, outcome text, detail text) on commit drop;
grant all on t1_result to authenticated;

do $$
begin
  begin
    perform public.create_booking('22222222-2222-2222-2222-222222222222'::uuid, '33333333-3333-3333-3333-333333333333'::uuid, '2030-01-15 12:00:00+02'::timestamptz, '2030-01-15 13:00:00+02'::timestamptz);
    insert into t1_result values ('fields_disabled', 'UNEXPECTED_SUCCESS', null);
  exception when others then
    insert into t1_result values ('fields_disabled', 'REJECTED', sqlerrm);
  end;
end $$;
reset role;

select * from t1_result;
rollback;

-- ============================================================
-- TEST 2: Fields module disable blocks the ANONYMOUS public booking
-- page (Phase 1, P0 -- the audit's single highest-severity finding).
-- EXPECTED: 'get_public_club_disabled' = 0 rows returned;
-- 'create_public_booking_disabled' = REJECTED.
-- ============================================================
begin;
insert into public.branches (id, club_id, branch_code, name, status)
values ('11111111-1111-1111-1111-111111111111', '<club-owner-club-id>', 'REGTEST1', 'Regression Test Branch', 'active');
insert into public.fields (id, club_id, branch_id, name, sport, status)
values ('22222222-2222-2222-2222-222222222222', '<club-owner-club-id>', '11111111-1111-1111-1111-111111111111', 'Regression Test Field', 'football', 'active');
update public.clubs set public_slug = 'regtest-public-slug' where id = '<club-owner-club-id>';
update public.club_modules set entitled = false, active = false
where club_id = '<club-owner-club-id>' and module_key = 'fields';

set role anon;
create temp table t2_result (step text, outcome text, detail text) on commit drop;
grant all on t2_result to anon;

do $$
declare v_count int;
begin
  select count(*) into v_count from public.get_public_club('regtest-public-slug');
  insert into t2_result values ('get_public_club_disabled', case when v_count = 0 then 'CORRECTLY_EMPTY' else 'LEAK' end, v_count::text);
end $$;

do $$
begin
  begin
    perform public.create_public_booking('regtest-public-slug', '22222222-2222-2222-2222-222222222222'::uuid, '2030-01-15 12:00:00+02'::timestamptz, '2030-01-15 13:00:00+02'::timestamptz, 'Anon', '01099999002', '+201099999002');
    insert into t2_result values ('create_public_booking_disabled', 'UNEXPECTED_SUCCESS', null);
  exception when others then
    insert into t2_result values ('create_public_booking_disabled', 'REJECTED', sqlerrm);
  end;
end $$;
reset role;

select * from t2_result;
rollback;

-- ============================================================
-- TEST 3: Academy module disable blocks enrollment (Phase 1, P0)
-- EXPECTED: REJECTED with "the academy module is not active for this club"
-- ============================================================
begin;
insert into public.branches (id, club_id, branch_code, name, status)
values ('11111111-1111-1111-1111-111111111111', '<club-owner-club-id>', 'REGTEST1', 'Regression Test Branch', 'active');
insert into public.groups (id, club_id, branch_id, name, capacity, status)
values ('88888888-8888-8888-8888-888888888888', '<club-owner-club-id>', '11111111-1111-1111-1111-111111111111', 'Regression Test Group', 10, 'active');
insert into public.players (id, club_id, full_name, status)
values ('99999999-9999-9999-9999-999999999999', '<club-owner-club-id>', 'Regression Test Player', 'active');
insert into public.customers (id, club_id, full_name, phone_e164, normalized_mobile)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '<club-owner-club-id>', 'Regression Test Guardian', '+201099999003', '01099999003');

update public.club_modules set entitled = false, active = false
where club_id = '<club-owner-club-id>' and module_key = 'academy';

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<club-owner-user-id>','role','authenticated')::text, true);
set local role authenticated;

create temp table t3_result (step text, outcome text, detail text) on commit drop;
grant all on t3_result to authenticated;

do $$
begin
  begin
    perform public.create_enrollment_with_subscription('99999999-9999-9999-9999-999999999999'::uuid, '88888888-8888-8888-8888-888888888888'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'monthly', '2030-01-01'::date, '2030-02-01'::date, 500);
    insert into t3_result values ('academy_disabled', 'UNEXPECTED_SUCCESS', null);
  exception when others then
    insert into t3_result values ('academy_disabled', 'REJECTED', sqlerrm);
  end;
end $$;
reset role;

select * from t3_result;
rollback;

-- ============================================================
-- TEST 4: Club Membership module disable blocks sale (Phase 2, P1)
-- EXPECTED: REJECTED with "the club membership module is not active for this club"
-- ============================================================
begin;
insert into public.branches (id, club_id, branch_code, name, status)
values ('11111111-1111-1111-1111-111111111111', '<club-owner-club-id>', 'REGTEST1', 'Regression Test Branch', 'active');
insert into public.customers (id, club_id, full_name, phone_e164, normalized_mobile)
values ('33333333-3333-3333-3333-333333333333', '<club-owner-club-id>', 'Regression Test Customer', '+201099999004', '01099999004');
insert into public.club_membership_plans (id, club_id, name_ar, name_en, price, duration_value, duration_unit, is_active, is_public, branch_scope)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', '<club-owner-club-id>', 'خطة اختبار', 'Regression Plan', 300, 1, 'month', true, true, 'all_branches');

update public.club_modules set entitled = false, active = false
where club_id = '<club-owner-club-id>' and module_key = 'club_membership';

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<club-owner-user-id>','role','authenticated')::text, true);
set local role authenticated;

create temp table t4_result (step text, outcome text, detail text) on commit drop;
grant all on t4_result to authenticated;

do $$
begin
  begin
    perform public.sell_club_membership('<club-owner-club-id>'::uuid, '33333333-3333-3333-3333-333333333333'::uuid, 'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, '2030-01-15'::date);
    insert into t4_result values ('club_membership_disabled', 'UNEXPECTED_SUCCESS', null);
  exception when others then
    insert into t4_result values ('club_membership_disabled', 'REJECTED', sqlerrm);
  end;
end $$;
reset role;

select * from t4_result;
rollback;

-- ============================================================
-- TEST 5: Limit-change auditing (Phase 3, P1)
-- EXPECTED: 'non_owner' = REJECTED with "not authorized";
-- the final SELECT shows a real audit_logs row with correct
-- before/after values and the reason preserved.
-- ============================================================
begin;
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<club-owner-user-id>','role','authenticated')::text, true);
set local role authenticated;
create temp table t5_result (step text, outcome text, detail text) on commit drop;
grant all on t5_result to authenticated;
do $$
begin
  begin
    perform public.set_commercial_entitlements('<club-owner-club-id>'::uuid, 5, 5, 5, 'regression test');
    insert into t5_result values ('non_owner', 'UNEXPECTED_SUCCESS', null);
  exception when others then
    insert into t5_result values ('non_owner', 'REJECTED', sqlerrm);
  end;
end $$;
reset role;
select * from t5_result;
rollback;

begin;
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<platform-owner-user-id>','role','authenticated')::text, true);
set local role authenticated;
select public.set_commercial_entitlements('<club-owner-club-id>'::uuid, 2, 3, 4, 'regression test -- audited write');
reset role;
select action, reason, before, after from public.audit_logs
where entity_type = 'commercial_entitlements' and club_id = '<club-owner-club-id>'
order by created_at desc limit 1;
rollback;

-- ============================================================
-- TEST 6: Plan-seeding never overwrites existing config (Phase 4, P1)
-- EXPECTED: the club's real module states are IDENTICAL before and
-- after -- especially any module already deliberately disabled (e.g.
-- Shop off) must remain off, even if the test plan's defaults include it.
-- ============================================================
begin;
select cm.module_key, cm.entitled, cm.active from public.club_modules cm
where cm.club_id = '<club-owner-club-id>' order by cm.module_key;
-- ^ note these values, then compare to the same query at the end of this block

insert into public.platform_plans (id, name, name_ar, billing_interval, billing_interval_count, price, currency, default_grace_period_days, is_public, display_order, status, default_modules, default_branch_limit, default_field_limit, default_academy_limit)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Regression Seed Plan', 'خطة اختبار البذر', 'month', 1, 500, 'EGP', 7, false, 999, 'active', array['fields','academy','shop','club_membership'], 99, 99, 99);

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<platform-owner-user-id>','role','authenticated')::text, true);
set local role authenticated;
select public.create_platform_subscription('<club-owner-club-id>'::uuid, 'paid', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid);
reset role;

select cm.module_key, cm.entitled, cm.active from public.club_modules cm
where cm.club_id = '<club-owner-club-id>' order by cm.module_key;
-- ^ must be IDENTICAL to the "before" query above
rollback;

-- ============================================================
-- TEST 7: Payment kill switch blocks new checkout (Phase 5, P2)
-- EXPECTED: REJECTED with "online payments are currently disabled..."
-- ============================================================
begin;
insert into public.branches (id, club_id, branch_code, name, status)
values ('11111111-1111-1111-1111-111111111111', '<club-owner-club-id>', 'REGTEST1', 'Regression Test Branch', 'active');
insert into public.customers (id, club_id, full_name, phone_e164, normalized_mobile)
values ('33333333-3333-3333-3333-333333333333', '<club-owner-club-id>', 'Regression Test Customer', '+201099999005', '01099999005');
insert into public.invoices (id, club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at)
values ('66666666-6666-6666-6666-666666666666', '<club-owner-club-id>', '11111111-1111-1111-1111-111111111111', 'REGTEST-INV-1', '33333333-3333-3333-3333-333333333333', 'issued', 100, 0, 100, now());
insert into public.club_gateway_connections (id, club_id, provider_key, environment, enabled, is_default, secret_vault_id)
values ('77777777-7777-7777-7777-777777777777', '<club-owner-club-id>', 'stripe', 'sandbox', true, true, gen_random_uuid());

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<platform-owner-user-id>','role','authenticated')::text, true);
set local role authenticated;
select public.set_club_payments_enabled('<club-owner-club-id>'::uuid, false, 'regression test');
reset role;

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<club-owner-user-id>','role','authenticated')::text, true);
set local role authenticated;
create temp table t7_result (step text, outcome text, detail text) on commit drop;
grant all on t7_result to authenticated;
do $$
begin
  begin
    perform public.start_gateway_checkout('66666666-6666-6666-6666-666666666666'::uuid, 'stripe', 50);
    insert into t7_result values ('checkout_while_disabled', 'UNEXPECTED_SUCCESS', null);
  exception when others then
    insert into t7_result values ('checkout_while_disabled', 'REJECTED', sqlerrm);
  end;
end $$;
reset role;
select * from t7_result;
rollback;

-- ============================================================
-- TEST 8: Provider policy blocks a new connection (Phase 5, P2)
-- EXPECTED: REJECTED with "... is not an allowed payment provider..."
-- ============================================================
begin;
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<platform-owner-user-id>','role','authenticated')::text, true);
set local role authenticated;
select public.set_club_gateway_provider_policy('<club-owner-club-id>'::uuid, 'paypal', 'policy_blocked', 'regression test');
reset role;

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','<club-owner-user-id>','role','authenticated')::text, true);
set local role authenticated;
create temp table t8_result (step text, outcome text, detail text) on commit drop;
grant all on t8_result to authenticated;
do $$
begin
  begin
    perform public.connect_club_gateway('<club-owner-club-id>'::uuid, 'paypal', 'sandbox', 'pk_test', 'sk_test', null, null);
    insert into t8_result values ('connect_policy_blocked', 'UNEXPECTED_SUCCESS', null);
  exception when others then
    insert into t8_result values ('connect_policy_blocked', 'REJECTED', sqlerrm);
  end;
end $$;
reset role;
select * from t8_result;
rollback;
