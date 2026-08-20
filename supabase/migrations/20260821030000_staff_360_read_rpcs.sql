-- Staff 360 directive section 71: "a deliberate small RPC set", not
-- dozens of browser queries and not one giant lifetime-history RPC.
-- Mirrors Customer 360's proven pattern: get_*_summary for the header/
-- cards, paginated get_* for each tab's list. Every RPC below is
-- SECURITY DEFINER STABLE, gated by user_club_ids() + has_permission,
-- and revoked from anon.

-- ============================================================
-- get_staff_360_summary -- Overview tab header + summary cards
-- ============================================================
create or replace function public.get_staff_360_summary(
  p_club_id uuid,
  p_membership_id uuid
)
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
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) then
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

  -- Rule #21: current shift. Custody/shifts are keyed by user_id
  -- (shared across a person's memberships in this club), not this
  -- specific membership row -- a shift belongs to the person.
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
    'last_activity_at', v_last_activity
  );
end;
$function$;

revoke all on function public.get_staff_360_summary(uuid, uuid) from public;
revoke all on function public.get_staff_360_summary(uuid, uuid) from anon;
grant execute on function public.get_staff_360_summary(uuid, uuid) to authenticated;

-- ============================================================
-- get_staff_shift_history -- Cash Shifts & Custody tab, paginated
-- ============================================================
create or replace function public.get_staff_shift_history(
  p_club_id uuid,
  p_membership_id uuid,
  p_limit int default 20,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_user_id uuid;
  v_rows jsonb;
  v_total bigint;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  select user_id into v_user_id from public.club_memberships where id = p_membership_id and club_id = p_club_id;
  if v_user_id is null then
    raise exception 'staff member not found';
  end if;

  select count(*) into v_total from public.cash_shifts where opened_by = v_user_id and club_id = p_club_id;

  with page as (
    select cs.id, cs.branch_id, b.name as branch_name, cs.opened_at, cs.closed_at,
           cs.opening_float, cs.closing_count, cs.expected_cash, cs.variance, cs.status,
           (select coalesce(sum(p.amount), 0) from public.payments p where p.cash_shift_id = cs.id and p.method = 'cash' and p.status = 'completed') as cash_collected
    from public.cash_shifts cs
    join public.branches b on b.id = cs.branch_id
    where cs.opened_by = v_user_id and cs.club_id = p_club_id
    order by cs.opened_at desc
    limit p_limit offset p_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id, 'branch_id', page.branch_id, 'branch_name', page.branch_name,
    'opened_at', page.opened_at, 'closed_at', page.closed_at,
    'opening_float', page.opening_float, 'cash_collected', page.cash_collected,
    'closing_count', page.closing_count, 'expected_cash', page.expected_cash,
    'variance', page.variance, 'status', page.status
  ) order by page.opened_at desc), '[]'::jsonb) into v_rows
  from page;

  return jsonb_build_object('rows', v_rows, 'total_count', v_total);
end;
$function$;

revoke all on function public.get_staff_shift_history(uuid, uuid, int, int) from public;
revoke all on function public.get_staff_shift_history(uuid, uuid, int, int) from anon;
grant execute on function public.get_staff_shift_history(uuid, uuid, int, int) to authenticated;

-- ============================================================
-- get_staff_shift_detail -- Shift Detail drill-down (rule #24)
-- ============================================================
create or replace function public.get_staff_shift_detail(
  p_club_id uuid,
  p_shift_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_shift record;
  v_employee_name text;
  v_branch_name text;
  v_closed_by_name text;
  v_payments jsonb;
  v_liability jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select * into v_shift from public.cash_shifts where id = p_shift_id and club_id = p_club_id;
  if v_shift.id is null then
    raise exception 'shift not found';
  end if;

  select full_name into v_employee_name from public.profiles where user_id = v_shift.opened_by;
  select name into v_branch_name from public.branches where id = v_shift.branch_id;
  if v_shift.closed_by is not null then
    select full_name into v_closed_by_name from public.profiles where user_id = v_shift.closed_by;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'amount', p.amount, 'method', p.method, 'status', p.status, 'received_at', p.received_at,
    'official_receipt_serial', ocr.receipt_serial
  ) order by p.received_at desc), '[]'::jsonb) into v_payments
  from public.payments p
  left join public.official_collection_receipts ocr on ocr.payment_id = p.id and ocr.status = 'active'
  where p.cash_shift_id = p_shift_id;

  select jsonb_build_object('id', id, 'kind', kind, 'original_amount', original_amount, 'outstanding', outstanding, 'status', status)
    into v_liability
  from public.employee_cash_liabilities
  where cash_shift_id = p_shift_id
  limit 1;

  return jsonb_build_object(
    'id', v_shift.id, 'branch_name', v_branch_name, 'employee_name', v_employee_name,
    'opened_at', v_shift.opened_at, 'closed_at', v_shift.closed_at,
    'opening_float', v_shift.opening_float, 'closing_count', v_shift.closing_count,
    'expected_cash', v_shift.expected_cash, 'variance', v_shift.variance, 'status', v_shift.status,
    'closed_by_name', v_closed_by_name, 'notes', v_shift.notes,
    'payments', v_payments, 'liability', v_liability
  );
end;
$function$;

revoke all on function public.get_staff_shift_detail(uuid, uuid) from public;
revoke all on function public.get_staff_shift_detail(uuid, uuid) from anon;
grant execute on function public.get_staff_shift_detail(uuid, uuid) to authenticated;

-- ============================================================
-- get_staff_financial_account -- Financial Account tab
-- ============================================================
create or replace function public.get_staff_financial_account(
  p_club_id uuid,
  p_membership_id uuid,
  p_limit int default 20,
  p_offset int default 0
)
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
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  select user_id into v_user_id from public.club_memberships where id = p_membership_id and club_id = p_club_id;
  if v_user_id is null then
    raise exception 'staff member not found';
  end if;

  -- Rule #38/#73: derived from source, never a stored snapshot.
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

revoke all on function public.get_staff_financial_account(uuid, uuid, int, int) from public;
revoke all on function public.get_staff_financial_account(uuid, uuid, int, int) from anon;
grant execute on function public.get_staff_financial_account(uuid, uuid, int, int) to authenticated;

-- ============================================================
-- get_staff_liability_ledger -- one liability's settlement/adjustment
-- history (directive rules #35/#37 -- ledger, not a flat number)
-- ============================================================
create or replace function public.get_staff_liability_ledger(
  p_club_id uuid,
  p_liability_id uuid
)
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
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) then
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

revoke all on function public.get_staff_liability_ledger(uuid, uuid) from public;
revoke all on function public.get_staff_liability_ledger(uuid, uuid) from anon;
grant execute on function public.get_staff_liability_ledger(uuid, uuid) to authenticated;

-- ============================================================
-- get_staff_activity -- Activity & Audit tab (mirrors get_customer_
-- activity's proven pattern exactly, filtered by actor_id instead of
-- entity_id -- directive rule #58: Actor, not Subject)
-- ============================================================
create or replace function public.get_staff_activity(
  p_club_id uuid,
  p_membership_id uuid,
  p_limit int default 30,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_user_id uuid;
  v_rows jsonb;
  v_total bigint;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  select user_id into v_user_id from public.club_memberships where id = p_membership_id and club_id = p_club_id;
  if v_user_id is null then
    raise exception 'staff member not found';
  end if;

  select count(*) into v_total from public.audit_logs where club_id = p_club_id and actor_id = v_user_id;

  with page as (
    select al.id, al.action, al.entity_type, al.entity_id, al.before, al.after, al.created_at
    from public.audit_logs al
    where al.club_id = p_club_id and al.actor_id = v_user_id
    order by al.created_at desc
    limit p_limit offset p_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id, 'action', page.action, 'entity_type', page.entity_type, 'entity_id', page.entity_id,
    'before', page.before, 'after', page.after, 'created_at', page.created_at
  ) order by page.created_at desc), '[]'::jsonb) into v_rows
  from page;

  return jsonb_build_object('rows', v_rows, 'total_count', v_total);
end;
$function$;

revoke all on function public.get_staff_activity(uuid, uuid, int, int) from public;
revoke all on function public.get_staff_activity(uuid, uuid, int, int) from anon;
grant execute on function public.get_staff_activity(uuid, uuid, int, int) to authenticated;

-- ============================================================
-- get_staff_access_profile -- Access & Permissions tab: role
-- defaults + friendly permission groups (directive rule #11)
-- ============================================================
create or replace function public.get_staff_access_profile(
  p_club_id uuid,
  p_membership_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_membership record;
  v_role record;
  v_permissions jsonb;
  v_branches jsonb;
  v_all_branches jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id and club_id = p_club_id;
  if v_membership.id is null then
    raise exception 'staff member not found';
  end if;

  select id, key, name, name_ar into v_role from public.roles where id = v_membership.role_id;

  select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'description', p.description) order by p.key), '[]'::jsonb)
    into v_permissions
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  where rp.role_id = v_membership.role_id;

  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name)), '[]'::jsonb) into v_branches
  from public.membership_branches mb
  join public.branches b on b.id = mb.branch_id
  where mb.membership_id = p_membership_id;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) into v_all_branches
  from public.branches where club_id = p_club_id and status = 'active';

  return jsonb_build_object(
    'role', jsonb_build_object('id', v_role.id, 'key', v_role.key, 'name', v_role.name, 'name_ar', v_role.name_ar),
    'permissions', v_permissions,
    'assigned_branches', v_branches,
    'all_club_branches', v_all_branches,
    'branch_scope_is_all', jsonb_array_length(v_branches) = 0
  );
end;
$function$;

revoke all on function public.get_staff_access_profile(uuid, uuid) from public;
revoke all on function public.get_staff_access_profile(uuid, uuid) from anon;
grant execute on function public.get_staff_access_profile(uuid, uuid) to authenticated;
