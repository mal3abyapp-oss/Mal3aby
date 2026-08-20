-- Staff 360 directive, mandatory pre-implementation audit found the
-- cash-custody/shift/liability backend already fully built (prior
-- phase), but with real gaps against this directive's absolute rules.
-- Fixes only -- no redesign of what already works correctly.

-- Rule #10: employee cannot settle/reverse/correct their own liability,
-- even with a general Finance permission. Rule #8/#42/#90: settlement
-- retry/double-click must never create a duplicate settlement --
-- idempotency key, database-enforced.
create table if not exists public.employee_cash_liability_settlement_keys (
  idempotency_key text primary key,
  liability_id uuid not null references public.employee_cash_liabilities(id),
  created_at timestamptz not null default now()
);

alter table public.employee_cash_liability_settlement_keys enable row level security;
-- No direct client access -- only ever touched from inside the
-- SECURITY DEFINER settlement RPC below.
create policy employee_cash_liability_settlement_keys_no_direct_access
  on public.employee_cash_liability_settlement_keys for all
  using (false) with check (false);

create or replace function public.settle_employee_cash_liability(
  p_liability_id uuid,
  p_amount numeric,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_liability record;
  v_new_outstanding numeric;
  v_existing_key record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_amount <= 0 then
    raise exception 'settlement amount must be positive';
  end if;

  select * into v_liability from public.employee_cash_liabilities where id = p_liability_id for update;
  if v_liability.id is null then
    raise exception 'liability not found';
  end if;

  if not (v_liability.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_liability.club_id)) then
    raise exception 'not authorized';
  end if;

  -- Rule #10 / #47: segregation of duties -- the indebted employee can
  -- never settle their own liability, regardless of what permissions
  -- their role otherwise grants.
  if v_liability.employee_id = auth.uid() then
    raise exception 'you cannot settle your own liability -- ask another authorized staff member';
  end if;

  -- Idempotency: same key seen before -> return the liability's
  -- CURRENT state without re-applying the settlement. Recorded before
  -- any mutation so a genuine unique_violation on concurrent identical
  -- retries is the actual guarantee, not a check-then-insert race.
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

-- Rule #10 on the adjustment path too -- an employee with payment.refund
-- (e.g. a manager who is ALSO an indebted employee elsewhere) must not
-- adjust their own liability.
create or replace function public.adjust_employee_cash_liability(
  p_liability_id uuid,
  p_amount numeric,
  p_reason text
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

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required for a liability adjustment';
  end if;

  if p_amount = 0 then
    raise exception 'adjustment amount cannot be zero';
  end if;

  select * into v_liability from public.employee_cash_liabilities where id = p_liability_id for update;
  if v_liability.id is null then
    raise exception 'liability not found';
  end if;

  if not (v_liability.club_id in (select public.user_club_ids()) and public.has_permission('payment.refund', v_liability.club_id)) then
    raise exception 'not authorized -- liability adjustments require manager/owner authorization';
  end if;

  if v_liability.employee_id = auth.uid() then
    raise exception 'you cannot adjust your own liability -- ask another authorized staff member';
  end if;

  v_new_outstanding := v_liability.outstanding + p_amount;
  if v_new_outstanding < 0 then
    raise exception 'adjustment would make the outstanding balance negative';
  end if;

  insert into public.employee_cash_liability_ledger (liability_id, entry_type, amount, actor_id, reason)
  values (p_liability_id, 'adjustment', p_amount, auth.uid(), p_reason);

  update public.employee_cash_liabilities
  set outstanding = v_new_outstanding,
      status = case when v_new_outstanding <= 0 then 'settled' else 'outstanding' end,
      updated_at = now()
  where id = p_liability_id;

  perform public.write_audit_log(
    v_liability.club_id, 'employee_cash_liability.adjusted', 'employee_cash_liability', p_liability_id,
    jsonb_build_object('outstanding', v_liability.outstanding),
    jsonb_build_object('outstanding', v_new_outstanding, 'adjustment_amount', p_amount),
    p_reason
  );

  return jsonb_build_object('outstanding', v_new_outstanding, 'status', case when v_new_outstanding <= 0 then 'settled' else 'outstanding' end);
end;
$function$;

-- Directive section 44: a dedicated Reverse action, distinct from a
-- generic Adjustment -- sets the liability fully back to its original
-- outstanding amount (undoes settlements/prior adjustments), for the
-- case where the liability itself was recorded in error. Still an
-- entity-preserving ledger entry, never a raw UPDATE/DELETE of history.
create or replace function public.reverse_employee_cash_liability(
  p_liability_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_liability record;
  v_reversal_amount numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to reverse a liability';
  end if;

  select * into v_liability from public.employee_cash_liabilities where id = p_liability_id for update;
  if v_liability.id is null then
    raise exception 'liability not found';
  end if;

  if not (v_liability.club_id in (select public.user_club_ids()) and public.has_permission('payment.refund', v_liability.club_id)) then
    raise exception 'not authorized -- liability reversal requires manager/owner authorization';
  end if;

  if v_liability.employee_id = auth.uid() then
    raise exception 'you cannot reverse your own liability -- ask another authorized staff member';
  end if;

  if v_liability.outstanding <= 0 then
    raise exception 'nothing outstanding to reverse';
  end if;

  v_reversal_amount := v_liability.outstanding;

  insert into public.employee_cash_liability_ledger (liability_id, entry_type, amount, actor_id, reason)
  values (p_liability_id, 'reversal', -v_reversal_amount, auth.uid(), p_reason);

  update public.employee_cash_liabilities
  set outstanding = 0,
      status = 'settled',
      updated_at = now()
  where id = p_liability_id;

  perform public.write_audit_log(
    v_liability.club_id, 'employee_cash_liability.reversed', 'employee_cash_liability', p_liability_id,
    jsonb_build_object('outstanding', v_liability.outstanding),
    jsonb_build_object('outstanding', 0, 'reversed_amount', v_reversal_amount),
    p_reason
  );

  return jsonb_build_object('outstanding', 0, 'status', 'settled');
end;
$function$;

revoke all on function public.reverse_employee_cash_liability(uuid, text) from public;
revoke all on function public.reverse_employee_cash_liability(uuid, text) from anon;
grant execute on function public.reverse_employee_cash_liability(uuid, text) to authenticated;

-- Rule #17/#97: cannot turn OFF cash custody while the employee has an
-- open shift -- would orphan it (no custody = the shift can no longer
-- be legitimately closed by this employee's own custody-gated flow).
create or replace function public.set_staff_cash_custody(
  p_membership_id uuid,
  p_has_custody boolean
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_membership record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id;
  if v_membership.id is null then
    raise exception 'membership not found';
  end if;

  if not (v_membership.club_id in (select public.user_club_ids()) and public.has_permission('staff.update', v_membership.club_id)) then
    raise exception 'not authorized';
  end if;

  if p_has_custody = false and v_membership.has_cash_custody = true then
    if exists (
      select 1 from public.cash_shifts
      where opened_by = v_membership.user_id and club_id = v_membership.club_id and status = 'open'
    ) then
      raise exception 'this employee has an open cash shift -- close it before removing cash custody';
    end if;
  end if;

  update public.club_memberships set has_cash_custody = p_has_custody, updated_at = now()
  where id = p_membership_id;

  perform public.write_audit_log(
    v_membership.club_id, 'staff.cash_custody.set', 'club_membership', p_membership_id,
    jsonb_build_object('has_cash_custody', v_membership.has_cash_custody),
    jsonb_build_object('has_cash_custody', p_has_custody),
    null
  );
end;
$function$;

-- Rule #52/#98: cannot suspend a staff member with an open shift --
-- would orphan it. Rule #59: role/status changes must be audited
-- (this RPC had none before).
create or replace function public.deactivate_staff_member(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_membership record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id;
  if v_membership.id is null then
    raise exception 'membership not found';
  end if;

  if not (v_membership.club_id in (select public.user_club_ids()) and public.has_permission('staff.update', v_membership.club_id)) then
    raise exception 'not authorized';
  end if;

  if exists (
    select 1 from public.cash_shifts
    where opened_by = v_membership.user_id and club_id = v_membership.club_id and status = 'open'
  ) then
    raise exception 'this employee has an open cash shift -- close it before suspending';
  end if;

  update public.club_memberships
  set status = 'inactive', updated_at = now()
  where id = p_membership_id;

  perform public.write_audit_log(
    v_membership.club_id, 'staff.suspended', 'club_membership', p_membership_id,
    jsonb_build_object('status', v_membership.status),
    jsonb_build_object('status', 'inactive'),
    null
  );
end;
$function$;

-- Reactivation had no dedicated RPC (only incidental via re-invite).
-- A direct, audited reactivate action, symmetric with deactivate.
create or replace function public.reactivate_staff_member(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_membership record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id;
  if v_membership.id is null then
    raise exception 'membership not found';
  end if;

  if not (v_membership.club_id in (select public.user_club_ids()) and public.has_permission('staff.update', v_membership.club_id)) then
    raise exception 'not authorized';
  end if;

  update public.club_memberships
  set status = 'active', updated_at = now()
  where id = p_membership_id;

  perform public.write_audit_log(
    v_membership.club_id, 'staff.reactivated', 'club_membership', p_membership_id,
    jsonb_build_object('status', v_membership.status),
    jsonb_build_object('status', 'active'),
    null
  );
end;
$function$;

revoke all on function public.reactivate_staff_member(uuid) from public;
revoke all on function public.reactivate_staff_member(uuid) from anon;
grant execute on function public.reactivate_staff_member(uuid) to authenticated;

-- Rule #59: role/branch changes on invite (including a re-invite that
-- changes an existing membership's status/branches) must be audited --
-- this RPC had no audit call at all.
create or replace function public.invite_staff_member(
  p_club_id uuid,
  p_email text,
  p_role_key text,
  p_branch_ids uuid[] default null::uuid[]
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_target_user_id uuid;
  v_role_id uuid;
  v_membership_id uuid;
  v_branch_id uuid;
  v_default_custody boolean;
  v_was_existing boolean;
  v_prior_status text;
begin
  if not public.has_permission('staff.create', p_club_id) then
    raise exception 'not authorized';
  end if;

  select id into v_target_user_id
  from auth.users
  where lower(email) = lower(p_email)
  limit 1;

  if v_target_user_id is null then
    raise exception 'no account found for that email -- the person must sign up first';
  end if;

  select id into v_role_id from public.roles where key = p_role_key;
  if v_role_id is null then
    raise exception 'unknown role';
  end if;

  if p_role_key = 'platform_owner' then
    raise exception 'not authorized';
  end if;

  select exists (
    select 1 from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id
    where rp.role_id = v_role_id and p.key = 'payment.create'
  ) into v_default_custody;

  select id, status into v_membership_id, v_prior_status
  from public.club_memberships
  where user_id = v_target_user_id and club_id = p_club_id and role_id = v_role_id;
  v_was_existing := v_membership_id is not null;

  insert into public.club_memberships (user_id, club_id, role_id, status, has_cash_custody)
  values (v_target_user_id, p_club_id, v_role_id, 'active', v_default_custody)
  on conflict (user_id, club_id, role_id)
    do update set status = 'active', updated_at = now()
  returning id into v_membership_id;

  delete from public.membership_branches where membership_id = v_membership_id;

  if p_branch_ids is not null then
    foreach v_branch_id in array p_branch_ids loop
      insert into public.membership_branches (membership_id, branch_id)
      values (v_membership_id, v_branch_id)
      on conflict do nothing;
    end loop;
  end if;

  perform public.write_audit_log(
    p_club_id,
    case when v_was_existing then 'staff.membership_reactivated' else 'staff.invited' end,
    'club_membership', v_membership_id,
    case when v_was_existing then jsonb_build_object('status', v_prior_status) else null end,
    jsonb_build_object('role_key', p_role_key, 'branch_ids', p_branch_ids, 'status', 'active'),
    null
  );

  return v_membership_id;
end;
$function$;
