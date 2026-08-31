-- STAFF OPERATIONS PRODUCTION ACCEPTANCE (2026-08-31) Section 39
-- (double-click/retry safety): record_expense() had no server-side
-- idempotency protection at all, unlike every other financial-
-- commitment RPC in this codebase (record_payment, create_refund both
-- already accept p_idempotency_key). Live-confirmed gap: the client's
-- own recordMutation only disables its submit button while isPending
-- ("a disabled button alone is not a sufficient integrity guarantee",
-- per this directive) -- a genuine double-click race, or a client
-- retry after a dropped response, would insert two separate expense
-- rows with no dedup mechanism whatsoever.
--
-- Fix: add expenses.idempotency_key (mirrors payments/refunds'
-- column shape), back it with a proper partial unique index (the
-- refunds_payment_idempotency_key_unique pattern -- the stronger of
-- the two existing precedents; payments.idempotency_key itself has no
-- DB-level uniqueness backing its own RPC-level dedup, a pre-existing
-- gap in the closed Finance baseline, not touched here since no
-- concrete staff-journey defect was reproduced against it), then add
-- the same early-return-on-existing-key check record_payment/
-- create_refund already use.

alter table public.expenses add column if not exists idempotency_key uuid;

create unique index if not exists expenses_club_idempotency_key_unique
  on public.expenses (club_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.record_expense(
  p_club_id uuid,
  p_branch_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_description text,
  p_category_id uuid default null,
  p_reference text default null,
  p_paid_to text default null,
  p_expense_date date default current_date,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_expense_id uuid;
  v_existing_expense_id uuid;
  v_has_custody boolean;
  v_active_shift_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('expense.create', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_idempotency_key is not null then
    select id into v_existing_expense_id
    from public.expenses
    where club_id = p_club_id and idempotency_key = p_idempotency_key;

    if v_existing_expense_id is not null then
      return v_existing_expense_id;
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;
  if p_payment_method not in ('cash', 'card', 'bank_transfer', 'wallet', 'other') then
    raise exception 'invalid payment method';
  end if;
  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'a description is required';
  end if;
  if p_expense_date > current_date then
    raise exception 'expense date cannot be in the future';
  end if;

  if not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'branch not found in this club';
  end if;
  if not public.user_has_branch_access(p_club_id, p_branch_id) then
    raise exception 'not authorized for this branch';
  end if;

  if p_category_id is not null and not exists (
    select 1 from public.expense_categories where id = p_category_id and club_id = p_club_id
  ) then
    raise exception 'category not found in this club';
  end if;

  if p_payment_method = 'cash' then
    select coalesce(bool_or(has_cash_custody), false) into v_has_custody
    from public.club_memberships
    where user_id = auth.uid() and club_id = p_club_id and status = 'active';

    if v_has_custody then
      select id into v_active_shift_id
      from public.cash_shifts
      where branch_id = p_branch_id and opened_by = auth.uid() and status = 'open';

      if v_active_shift_id is null then
        raise exception 'cash expenses require an active cash shift -- open one before recording a cash expense';
      end if;
    end if;
  end if;

  insert into public.expenses (
    club_id, branch_id, category_id, amount, payment_method, cash_shift_id,
    description, reference, paid_to, expense_date, created_by, idempotency_key
  ) values (
    p_club_id, p_branch_id, p_category_id, p_amount, p_payment_method, v_active_shift_id,
    btrim(p_description), nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(p_paid_to, '')), ''),
    p_expense_date, auth.uid(), p_idempotency_key
  )
  returning id into v_expense_id;

  perform public.write_audit_log(
    p_club_id, 'expense.create', 'expense', v_expense_id, null,
    jsonb_build_object(
      'amount', p_amount, 'payment_method', p_payment_method, 'branch_id', p_branch_id,
      'category_id', p_category_id, 'description', p_description, 'expense_date', p_expense_date,
      'cash_shift_id', v_active_shift_id
    ),
    null
  );

  return v_expense_id;
end;
$function$;
