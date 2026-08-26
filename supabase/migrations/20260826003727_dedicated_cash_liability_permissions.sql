-- DEDICATED CASH LIABILITY PERMISSIONS phase.
--
-- Separates cash-liability visibility/settlement from the general
-- payment.create permission. Builds on the existing STAFF ACCESS
-- CONTROL & CUSTOM ROLES system (roles/permissions/role_permissions,
-- club_roles/club_role_permissions) -- no new architecture.
--
-- Two new permission keys:
--   cash.liability.view   -- see liability totals/list/history
--   cash.liability.settle -- record partial/full settlement
--
-- Idempotent (on conflict do nothing throughout) -- safe to re-run.

insert into public.permissions (key, description) values
  ('cash.liability.view', 'View employee cash shortage/liability totals, list, and history'),
  ('cash.liability.settle', 'Record a partial or full settlement of an employee cash liability')
on conflict (key) do nothing;

-- =======================================================================
-- Default system-role backfill, exactly per the mandated matrix.
-- Every existing custom role is deliberately left untouched -- no
-- automatic grant based on payment.create or any other existing
-- permission (see the migration's closing comment for why this is
-- safe and does not break any real customer).
-- =======================================================================
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('club_owner', 'accountant') and p.key in ('cash.liability.view', 'cash.liability.settle')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('club_manager', 'branch_manager') and p.key = 'cash.liability.view'
on conflict do nothing;

-- receptionist, coach, scanner, academy_manager: no grant (DENY/DENY,
-- matches the mandated matrix -- nothing to insert).
-- platform_owner: unchanged -- is_platform_owner() remains a global
-- bypass wherever it already applies (e.g. RLS ALL-policies); the
-- settlement/view RPCs below are gated purely on has_permission() for
-- every caller (consistent with how every other staff/cash RPC in
-- this schema already works, including the existing
-- settle_employee_cash_liability() before this migration -- it never
-- had a platform_owner bypass, and none is added now).

-- =======================================================================
-- settle_employee_cash_liability(): CRITICAL enforcement change.
-- Was gated on has_permission('payment.create', ...) -- now gated
-- SOLELY on has_permission('cash.liability.settle', ...), no fallback
-- to payment.create. Same signature/return type as before (jsonb) --
-- safe in-place CREATE OR REPLACE, no new overload, grants unaffected.
-- Self-settlement guard, overpayment guard, double-settlement guard,
-- FOR UPDATE row lock, and idempotency-key handling are all preserved
-- byte-for-byte from the prior (already-verified-correct) version.
-- =======================================================================
create or replace function public.settle_employee_cash_liability(
  p_liability_id uuid, p_amount numeric, p_reason text default null::text, p_idempotency_key text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_liability record;
  v_new_outstanding numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_amount <= 0 then
    raise exception 'settlement amount must be positive';
  end if;

  select * into v_liability
  from public.employee_cash_liabilities
  where id = p_liability_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('cash.liability.settle', club_id)
  for update;

  if v_liability.id is null then
    raise exception 'liability not found or you do not have permission to settle it';
  end if;

  if v_liability.employee_id = auth.uid() then
    raise exception 'you cannot settle your own liability -- ask another authorized staff member';
  end if;

  if p_idempotency_key is not null then
    begin
      insert into public.employee_cash_liability_settlement_keys (idempotency_key, liability_id)
      values (p_idempotency_key, p_liability_id);
    exception when unique_violation then
      select * into v_liability from public.employee_cash_liabilities where id = p_liability_id;
      return jsonb_build_object('outstanding', v_liability.outstanding, 'status', v_liability.status, 'idempotent_replay', true);
    end;
  end if;

  if v_liability.status = 'settled' then
    raise exception 'this liability is already fully settled';
  end if;

  if p_amount > v_liability.outstanding then
    raise exception 'settlement amount (%) exceeds the outstanding balance (%)', p_amount, v_liability.outstanding;
  end if;

  insert into public.employee_cash_liability_ledger (liability_id, entry_type, amount, actor_id, reason)
  values (p_liability_id, 'settlement', -p_amount, auth.uid(), p_reason);

  v_new_outstanding := v_liability.outstanding - p_amount;

  update public.employee_cash_liabilities
  set outstanding = v_new_outstanding,
      status = case when v_new_outstanding <= 0 then 'settled' else 'outstanding' end,
      updated_at = now()
  where id = p_liability_id;

  perform public.write_audit_log(
    v_liability.club_id, 'employee_cash_liability.settled', 'employee_cash_liability', p_liability_id,
    jsonb_build_object('outstanding', v_liability.outstanding),
    jsonb_build_object('outstanding', v_new_outstanding, 'settlement_amount', p_amount),
    p_reason
  );

  return jsonb_build_object('outstanding', v_new_outstanding, 'status', case when v_new_outstanding <= 0 then 'settled' else 'outstanding' end);
end;
$function$;

-- =======================================================================
-- get_staff_360_summary() / get_staff_financial_account() /
-- get_staff_liability_ledger(): widened to accept EITHER staff.update
-- (the existing, full-access gate -- unchanged behavior for every
-- current caller) OR cash.liability.view (the new, narrower gate) --
-- this is what lets an Accountant open Employee 360 far enough to see
-- liability data without staff.update, per the phase's least-privilege
-- requirement. get_staff_access_profile() and get_staff_shift_history()
-- are deliberately NOT touched -- role/permission and cash-shift
-- management data stay staff.update-only, genuinely outside "viewing a
-- liability." Same RETURNS jsonb shape for all three -- safe in-place
-- CREATE OR REPLACE.
-- =======================================================================
create or replace function public.get_staff_360_summary(p_club_id uuid, p_membership_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_membership record;
  v_full_name text;
  v_email text;
  v_branches jsonb;
  v_current_shift jsonb;
  v_outstanding numeric;
  v_settled numeric;
  v_last_shift jsonb;
  v_last_collection jsonb;
  v_last_activity timestamptz;
  v_activity_counts jsonb;
  v_month_start timestamptz;
begin
  if not (
    p_club_id in (select public.user_club_ids())
    and (public.has_permission('staff.update', p_club_id) or public.has_permission('cash.liability.view', p_club_id))
  ) then
    raise exception 'not authorized';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id and club_id = p_club_id;
  if v_membership.id is null then
    raise exception 'staff member not found';
  end if;

  select full_name into v_full_name from public.profiles where user_id = v_membership.user_id;
  select email into v_email from auth.users where id = v_membership.user_id;

  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name)), '[]'::jsonb)
    into v_branches
  from public.membership_branches mb
  join public.branches b on b.id = mb.branch_id
  where mb.membership_id = p_membership_id;

  select jsonb_build_object(
    'id', cs.id, 'branch_id', cs.branch_id, 'branch_name', b.name,
    'opened_at', cs.opened_at, 'opening_float', cs.opening_float
  ) into v_current_shift
  from public.cash_shifts cs
  join public.branches b on b.id = cs.branch_id
  where cs.opened_by = v_membership.user_id and cs.club_id = p_club_id and cs.status = 'open'
  limit 1;

  select coalesce(sum(outstanding), 0) into v_outstanding
  from public.employee_cash_liabilities
  where employee_id = v_membership.user_id and club_id = p_club_id and status = 'outstanding';

  select coalesce(sum(original_amount - outstanding), 0) into v_settled
  from public.employee_cash_liabilities
  where employee_id = v_membership.user_id and club_id = p_club_id;

  select jsonb_build_object('id', cs.id, 'closed_at', cs.closed_at, 'branch_name', b.name)
    into v_last_shift
  from public.cash_shifts cs
  join public.branches b on b.id = cs.branch_id
  where cs.opened_by = v_membership.user_id and cs.club_id = p_club_id and cs.status = 'closed'
  order by cs.closed_at desc nulls last
  limit 1;

  select jsonb_build_object('id', p.id, 'amount', p.amount, 'received_at', p.received_at)
    into v_last_collection
  from public.payments p
  where p.received_by = v_membership.user_id and p.club_id = p_club_id
  order by p.received_at desc
  limit 1;

  select max(created_at) into v_last_activity
  from public.audit_logs
  where club_id = p_club_id and actor_id = v_membership.user_id;

  v_month_start := date_trunc('month', now());

  select jsonb_build_object(
    'bookings_created_total', (select count(*) from public.bookings where created_by = v_membership.user_id and club_id = p_club_id),
    'bookings_created_this_month', (select count(*) from public.bookings where created_by = v_membership.user_id and club_id = p_club_id and created_at >= v_month_start),
    'payments_collected_total', (select count(*) from public.payments where received_by = v_membership.user_id and club_id = p_club_id),
    'payments_collected_amount_total', (select coalesce(sum(amount), 0) from public.payments where received_by = v_membership.user_id and club_id = p_club_id),
    'payments_collected_this_month', (select count(*) from public.payments where received_by = v_membership.user_id and club_id = p_club_id and received_at >= v_month_start),
    'payments_collected_amount_this_month', (select coalesce(sum(amount), 0) from public.payments where received_by = v_membership.user_id and club_id = p_club_id and received_at >= v_month_start),
    'attendance_marked_total', (select count(*) from public.attendance where marked_by = v_membership.user_id and club_id = p_club_id),
    'attendance_marked_this_month', (select count(*) from public.attendance where marked_by = v_membership.user_id and club_id = p_club_id and marked_at >= v_month_start),
    'official_receipts_issued_total', (select count(*) from public.official_collection_receipts where entered_by = v_membership.user_id and club_id = p_club_id and status = 'active')
  ) into v_activity_counts;

  return jsonb_build_object(
    'membership', jsonb_build_object(
      'id', v_membership.id, 'user_id', v_membership.user_id,
      'full_name', v_full_name, 'email', v_email,
      'status', v_membership.status, 'has_cash_custody', v_membership.has_cash_custody,
      'created_at', v_membership.created_at
    ),
    'branches', v_branches,
    'current_shift', v_current_shift,
    'outstanding_liability', v_outstanding,
    'total_settled', v_settled,
    'last_shift', v_last_shift,
    'last_collection', v_last_collection,
    'last_activity_at', v_last_activity,
    'activity_counts', v_activity_counts
  );
end;
$function$;

create or replace function public.get_staff_financial_account(p_club_id uuid, p_membership_id uuid, p_limit integer default 20, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_user_id uuid;
  v_total_original numeric;
  v_total_settled numeric;
  v_total_outstanding numeric;
  v_liability_rows jsonb;
  v_liability_total bigint;
begin
  if not (
    p_club_id in (select public.user_club_ids())
    and (public.has_permission('staff.update', p_club_id) or public.has_permission('cash.liability.view', p_club_id))
  ) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  select user_id into v_user_id from public.club_memberships where id = p_membership_id and club_id = p_club_id;
  if v_user_id is null then
    raise exception 'staff member not found';
  end if;

  select coalesce(sum(original_amount), 0), coalesce(sum(original_amount - outstanding), 0), coalesce(sum(outstanding), 0)
    into v_total_original, v_total_settled, v_total_outstanding
  from public.employee_cash_liabilities
  where employee_id = v_user_id and club_id = p_club_id;

  select count(*) into v_liability_total from public.employee_cash_liabilities where employee_id = v_user_id and club_id = p_club_id;

  with page as (
    select ecl.id, ecl.kind, ecl.cash_shift_id, ecl.original_amount, ecl.outstanding, ecl.status, ecl.created_at
    from public.employee_cash_liabilities ecl
    where ecl.employee_id = v_user_id and ecl.club_id = p_club_id
    order by ecl.created_at desc
    limit p_limit offset p_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id, 'kind', page.kind, 'cash_shift_id', page.cash_shift_id,
    'original_amount', page.original_amount, 'outstanding', page.outstanding,
    'settled_amount', page.original_amount - page.outstanding,
    'status', page.status, 'created_at', page.created_at
  ) order by page.created_at desc), '[]'::jsonb) into v_liability_rows
  from page;

  return jsonb_build_object(
    'summary', jsonb_build_object(
      'total_original_liabilities', v_total_original,
      'total_settled', v_total_settled,
      'total_outstanding', v_total_outstanding
    ),
    'liabilities', jsonb_build_object('rows', v_liability_rows, 'total_count', v_liability_total)
  );
end;
$function$;

create or replace function public.get_staff_liability_ledger(p_club_id uuid, p_liability_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_liability record;
  v_rows jsonb;
begin
  if not (
    p_club_id in (select public.user_club_ids())
    and (public.has_permission('staff.update', p_club_id) or public.has_permission('cash.liability.view', p_club_id))
  ) then
    raise exception 'not authorized';
  end if;

  select * into v_liability from public.employee_cash_liabilities where id = p_liability_id and club_id = p_club_id;
  if v_liability.id is null then
    raise exception 'liability not found';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ecll.id, 'entry_type', ecll.entry_type, 'amount', ecll.amount,
    'actor_id', ecll.actor_id, 'actor_name', prof.full_name,
    'reason', ecll.reason, 'created_at', ecll.created_at
  ) order by ecll.created_at asc), '[]'::jsonb) into v_rows
  from public.employee_cash_liability_ledger ecll
  left join public.profiles prof on prof.user_id = ecll.actor_id
  where ecll.liability_id = p_liability_id;

  return jsonb_build_object(
    'liability', jsonb_build_object(
      'id', v_liability.id, 'kind', v_liability.kind, 'cash_shift_id', v_liability.cash_shift_id,
      'original_amount', v_liability.original_amount, 'outstanding', v_liability.outstanding, 'status', v_liability.status
    ),
    'entries', v_rows
  );
end;
$function$;

-- =======================================================================
-- Why no automatic backfill of existing custom roles: every custom role
-- was created THIS SESSION during the Staff Access Control phase and
-- confirmed deleted during that phase's own cleanup -- a live query
-- confirms zero custom roles exist in production as of this migration,
-- so there is no real customer whose existing custom role could be
-- silently broken by settle_employee_cash_liability() no longer
-- accepting payment.create. This is recorded here rather than assumed:
-- if a future audit finds a real custom role that held payment.create
-- specifically to settle liabilities, that is a genuine business
-- decision (grant it cash.liability.settle explicitly, or not) --
-- never a case for blind automatic backfill.
-- =======================================================================
