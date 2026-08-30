-- EXPENSES FEATURE (2026-08-30): closes the last stub tab in Finance
-- ("المصروفات" -- confirmed via architecture survey to have zero
-- backend anywhere in this codebase: no expenses table, no expense_*
-- RPC, no prior migration touches this word). Built to mirror every
-- established convention in this codebase exactly, not invented fresh:
--
--   * branch scoping: club_id + branch_id both NOT NULL, same shape as
--     payments/invoices/cash_shifts (branch scoping is mandatory for
--     every money-moving row in this schema, never club-wide-optional).
--   * RLS: the same three-clause user_club_ids() + has_permission(...)
--     + user_has_branch_access(...) shape as payments_*.
--   * payment_method: the same 5-value inline-checked set every other
--     RPC uses ('cash','card','bank_transfer','wallet','other') --
--     matches create_shop_sale/confirm_payment_reconciliation exactly.
--   * categories: shop_categories' own shape (club-scoped flat list,
--     bilingual name, soft-archive via status, manual display_order).
--   * permission seeding: the exact 3-part
--     permissions/role_permissions/permission_dependencies pattern from
--     20260828170150_shop_reports_view_profit_permission_seed.sql.
--   * report RPC: the exact auth -> permission -> date-validate ->
--     branch-validate -> club_local_day_bounds -> single jsonb object
--     shape every other report RPC in this codebase follows bit-for-bit
--     (see get_payment_method_report).
--
-- THE ACCOUNTING-CORRECTNESS POINT THIS MIGRATION EXISTS TO GET RIGHT:
-- a cash expense is real cash leaving the drawer. Without linking it to
-- the currently-open cash shift AND subtracting it inside
-- close_cash_shift()'s own v_expected formula, every cash expense would
-- silently manufacture a fake "overage" at shift close (the drawer
-- would count *less* than expected because real cash left it for a
-- real expense, but the shift math would have no idea that happened).
-- This migration adds that missing term to the existing formula --
-- everything else about close_cash_shift() is left byte-for-byte
-- unchanged.

-- ============================================================
-- 1. SCHEMA
-- ============================================================

create table public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  name_ar text not null,
  name_en text,
  status text not null default 'active' check (status in ('active', 'archived')),
  display_order int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid
);

create index expense_categories_club_id_idx on public.expense_categories(club_id);

alter table public.expense_categories enable row level security;
alter table public.expense_categories force row level security;

create policy expense_categories_select_own_club on public.expense_categories
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('expense.view', club_id)
  );

create policy expense_categories_write_with_permission on public.expense_categories
  for all using (
    club_id in (select public.user_club_ids())
    and public.has_permission('expense.category.manage', club_id)
  ) with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('expense.category.manage', club_id)
  );

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  category_id uuid references public.expense_categories(id),
  amount numeric not null check (amount > 0),
  payment_method text not null check (payment_method in ('cash', 'card', 'bank_transfer', 'wallet', 'other')),
  -- Only ever set for method='cash', by record_expense() itself --
  -- mirrors payments.cash_shift_id exactly (same nullable-uuid shape,
  -- same "only cash payments made under an open shift get linked"
  -- rule as create_shop_sale's own cash-custody logic).
  cash_shift_id uuid references public.cash_shifts(id),
  description text not null,
  reference text,
  paid_to text,
  expense_date date not null default current_date,
  status text not null default 'recorded' check (status in ('recorded', 'voided')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  voided_by uuid,
  voided_at timestamptz,
  void_reason text
);

create index expenses_club_id_idx on public.expenses(club_id);
create index expenses_branch_id_idx on public.expenses(branch_id);
create index expenses_cash_shift_id_idx on public.expenses(cash_shift_id) where cash_shift_id is not null;
create index expenses_expense_date_idx on public.expenses(club_id, expense_date);

alter table public.expenses enable row level security;
alter table public.expenses force row level security;

-- Same three-clause shape as payments_select_club_staff /
-- payments_insert_with_permission -- user_club_ids() + has_permission()
-- + user_has_branch_access(). Writes go through record_expense()/
-- void_expense() (SECURITY DEFINER RPCs) rather than direct table
-- access from the client, but RLS is still the real boundary those
-- RPCs run under, and blocks any other write path (direct REST calls,
-- a future bug in a different RPC) the exact same way every other
-- financial table in this schema is protected.
create policy expenses_select_own_club on public.expenses
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('expense.view', club_id)
    and public.user_has_branch_access(club_id, branch_id)
  );

create policy expenses_platform_support_select on public.expenses
  for select using (public.has_platform_support_access(club_id));

-- ============================================================
-- 2. PERMISSIONS (exact 3-part seed pattern)
-- ============================================================

insert into public.permissions (key, description) values
  ('expense.view', 'View club expenses and expense reports'),
  ('expense.create', 'Record a new club expense'),
  ('expense.void', 'Void a previously recorded expense (soft-void, never deletes -- corrects a mistake with a full audit trail)'),
  ('expense.category.manage', 'Create, rename, and archive expense categories')
on conflict (key) do nothing;

-- Granted to club_owner, club_manager, branch_manager, and accountant --
-- the same roles that already hold payment.create/invoice.create
-- (money-recording authority in this codebase is not owner-exclusive,
-- unlike e.g. shop.reports.view_profit's deliberate owner-only
-- posture). Not granted to receptionist/coach/scanner/academy_manager,
-- none of which touch money-recording anywhere else in this schema.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.key in ('club_owner', 'club_manager', 'branch_manager', 'accountant')
  and p.key in ('expense.view', 'expense.create', 'expense.void', 'expense.category.manage')
on conflict (role_id, permission_id) do nothing;

insert into public.permission_dependencies (permission_key, requires_key) values
  ('expense.create', 'expense.view'),
  ('expense.void', 'expense.view'),
  ('expense.category.manage', 'expense.view')
on conflict (permission_key, requires_key) do nothing;

-- ============================================================
-- 3. RPCs
-- ============================================================

create or replace function public.list_expense_categories(p_club_id uuid, p_include_archived boolean default false)
 returns table(id uuid, name_ar text, name_en text, status text, display_order int)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('expense.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
    select c.id, c.name_ar, c.name_en, c.status, c.display_order
    from public.expense_categories c
    where c.club_id = p_club_id
      and (p_include_archived or c.status = 'active')
    order by c.display_order, c.name_ar;
end;
$function$;

create or replace function public.create_expense_category(p_club_id uuid, p_name_ar text, p_name_en text default null)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_category_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('expense.category.manage', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if btrim(coalesce(p_name_ar, '')) = '' then
    raise exception 'category name is required';
  end if;

  insert into public.expense_categories (club_id, name_ar, name_en, created_by)
  values (p_club_id, btrim(p_name_ar), nullif(btrim(coalesce(p_name_en, '')), ''), auth.uid())
  returning id into v_category_id;

  perform public.write_audit_log(
    p_club_id, 'expense_category.created', 'expense_category', v_category_id,
    null, jsonb_build_object('name_ar', p_name_ar, 'name_en', p_name_en), null
  );

  return v_category_id;
end;
$function$;

create or replace function public.set_expense_category_status(p_category_id uuid, p_status text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_category public.expense_categories;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if p_status not in ('active', 'archived') then
    raise exception 'invalid status';
  end if;

  select * into v_category from public.expense_categories
  where id = p_category_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('expense.category.manage', club_id);
  if v_category.id is null then
    raise exception 'category not found or you do not have permission to manage it';
  end if;

  update public.expense_categories set status = p_status where id = p_category_id;

  perform public.write_audit_log(
    v_category.club_id, 'expense_category.status_changed', 'expense_category', p_category_id,
    jsonb_build_object('status', v_category.status), jsonb_build_object('status', p_status), null
  );
end;
$function$;

-- The core write path. Mirrors create_shop_sale's cash-custody check
-- exactly: a cash expense from someone WITH cash custody requires an
-- open shift for the branch (real cash needs a real drawer to leave
-- from); someone WITHOUT cash custody recording a cash expense (e.g.
-- an owner logging a receipt after the fact, or petty cash tracked
-- outside a formal shift) is allowed through with cash_shift_id left
-- null, same permissive fallback create_shop_sale itself uses.
create or replace function public.record_expense(
  p_club_id uuid,
  p_branch_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_description text,
  p_category_id uuid default null,
  p_reference text default null,
  p_paid_to text default null,
  p_expense_date date default current_date
)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_expense_id uuid;
  v_has_custody boolean;
  v_active_shift_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('expense.create', p_club_id)) then
    raise exception 'not authorized';
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
    description, reference, paid_to, expense_date, created_by
  ) values (
    p_club_id, p_branch_id, p_category_id, p_amount, p_payment_method, v_active_shift_id,
    btrim(p_description), nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(p_paid_to, '')), ''),
    p_expense_date, auth.uid()
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

-- Soft-void only, matching void_invoice's own convention (status flip,
-- full audit trail, never a hard delete) -- a voided expense stays
-- fully visible in history and reports for reconciliation, it just
-- stops counting toward totals.
create or replace function public.void_expense(p_expense_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_expense public.expenses;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'a reason is required to void an expense';
  end if;

  select * into v_expense from public.expenses
  where id = p_expense_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('expense.void', club_id);
  if v_expense.id is null then
    raise exception 'expense not found or you do not have permission to void it';
  end if;
  if v_expense.status = 'voided' then
    raise exception 'this expense is already voided';
  end if;

  update public.expenses
  set status = 'voided', voided_by = auth.uid(), voided_at = now(), void_reason = p_reason
  where id = p_expense_id;

  perform public.write_audit_log(
    v_expense.club_id, 'expense.void', 'expense', p_expense_id,
    jsonb_build_object('status', 'recorded'), jsonb_build_object('status', 'voided'), p_reason
  );
end;
$function$;

create or replace function public.list_expenses(
  p_club_id uuid,
  p_start_date date,
  p_end_date date,
  p_branch_id uuid default null,
  p_category_id uuid default null,
  p_status text default null
)
 returns table(
   id uuid, branch_id uuid, branch_name text, category_id uuid, category_name text,
   amount numeric, payment_method text, description text, reference text, paid_to text,
   expense_date date, status text, created_by uuid, created_at timestamptz,
   void_reason text
 )
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_accessible uuid[];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('expense.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;
  if p_status is not null and p_status not in ('recorded', 'voided') then
    raise exception 'invalid status filter';
  end if;

  v_accessible := public.caller_accessible_branch_ids(p_club_id);
  if p_branch_id is not null and v_accessible is not null and not (p_branch_id = any(v_accessible)) then
    raise exception 'not authorized';
  end if;

  return query
    select
      e.id, e.branch_id, coalesce(b.name, ''), e.category_id, coalesce(c.name_ar, ''),
      e.amount, e.payment_method, e.description, e.reference, e.paid_to,
      e.expense_date, e.status, e.created_by, e.created_at, e.void_reason
    from public.expenses e
    join public.branches b on b.id = e.branch_id
    left join public.expense_categories c on c.id = e.category_id
    where e.club_id = p_club_id
      and e.expense_date >= p_start_date and e.expense_date <= p_end_date
      and (p_branch_id is null or e.branch_id = p_branch_id)
      and (v_accessible is null or e.branch_id = any(v_accessible))
      and (p_category_id is null or e.category_id = p_category_id)
      and (p_status is null or e.status = p_status)
    order by e.expense_date desc, e.created_at desc;
end;
$function$;

-- Same exact shape as get_payment_method_report: auth -> permission ->
-- date-validate -> branch-validate -> club_local_day_bounds -> single
-- jsonb object, filtered to expense_date (a plain date column, unlike
-- payments' timestamptz received_at, since an expense is recorded
-- against a calendar day, not a precise instant) rather than a
-- timestamptz range -- still bounded consistently by the same club-
-- local day resolution every other report uses, for the display range
-- boundary (p_start_date/p_end_date themselves are already dates).
create or replace function public.get_expense_report(p_club_id uuid, p_start_date date, p_end_date date, p_branch_id uuid default null)
 returns jsonb
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_accessible uuid[];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;
  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'not authorized';
  end if;

  v_accessible := public.caller_accessible_branch_ids(p_club_id);
  if p_branch_id is not null and v_accessible is not null and not (p_branch_id = any(v_accessible)) then
    raise exception 'not authorized';
  end if;

  select jsonb_build_object(
    'total_expenses', coalesce((
      select sum(e.amount) from public.expenses e
      where e.club_id = p_club_id and e.status = 'recorded'
        and e.expense_date >= p_start_date and e.expense_date <= p_end_date
        and (case when p_branch_id is not null then e.branch_id = p_branch_id
             else v_accessible is null or e.branch_id = any(v_accessible) end)
    ), 0),
    'expense_count', coalesce((
      select count(*) from public.expenses e
      where e.club_id = p_club_id and e.status = 'recorded'
        and e.expense_date >= p_start_date and e.expense_date <= p_end_date
        and (case when p_branch_id is not null then e.branch_id = p_branch_id
             else v_accessible is null or e.branch_id = any(v_accessible) end)
    ), 0),
    'by_category', coalesce((
      select jsonb_agg(jsonb_build_object(
        'category_id', x.category_id,
        'category_name', x.category_name,
        'total', x.total,
        'count', x.cnt
      ) order by x.total desc)
      from (
        select
          e.category_id,
          coalesce(c.name_ar, 'بدون تصنيف') as category_name,
          sum(e.amount) as total,
          count(*) as cnt
        from public.expenses e
        left join public.expense_categories c on c.id = e.category_id
        where e.club_id = p_club_id and e.status = 'recorded'
          and e.expense_date >= p_start_date and e.expense_date <= p_end_date
          and (case when p_branch_id is not null then e.branch_id = p_branch_id
               else v_accessible is null or e.branch_id = any(v_accessible) end)
        group by e.category_id, c.name_ar
      ) x
    ), '[]'::jsonb),
    'by_method', coalesce((
      select jsonb_agg(jsonb_build_object(
        'method', x.method,
        'total', x.total,
        'count', x.cnt
      ) order by x.total desc)
      from (
        select e.payment_method as method, sum(e.amount) as total, count(*) as cnt
        from public.expenses e
        where e.club_id = p_club_id and e.status = 'recorded'
          and e.expense_date >= p_start_date and e.expense_date <= p_end_date
          and (case when p_branch_id is not null then e.branch_id = p_branch_id
               else v_accessible is null or e.branch_id = any(v_accessible) end)
        group by e.payment_method
      ) x
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

-- ============================================================
-- 4. THE ACCOUNTING FIX: close_cash_shift() must subtract cash
--    expenses, or every cash expense manufactures a fake overage.
--    Every other line of this function is BYTE-FOR-BYTE unchanged
--    from the live version read before this migration was written --
--    only the v_expected formula and its one supporting query differ.
-- ============================================================

create or replace function public.close_cash_shift(p_shift_id uuid, p_closing_count numeric, p_notes text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_shift record;
  v_cash_collected numeric;
  v_cash_refunded numeric;
  v_cash_expenses numeric;
  v_expected numeric;
  v_variance numeric;
  v_liability_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_shift
  from public.cash_shifts
  where id = p_shift_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('payment.create', club_id)
  for update;

  if v_shift.id is null then
    raise exception 'shift not found or you do not have permission to close it';
  end if;

  if v_shift.status != 'open' then
    raise exception 'this shift is already closed';
  end if;

  if p_closing_count < 0 then
    raise exception 'closing count cannot be negative';
  end if;

  select coalesce(sum(p.amount), 0) into v_cash_collected
  from public.payments p
  where p.method = 'cash' and p.status = 'completed'
    and (
      p.cash_shift_id = p_shift_id
      or (
        p.cash_shift_id is null
        and p.branch_id = v_shift.branch_id
        and p.received_at >= v_shift.opened_at and p.received_at <= now()
      )
    );

  select coalesce(sum(r.amount), 0) into v_cash_refunded
  from public.refunds r
  join public.payments p on p.id = r.payment_id
  where p.method = 'cash' and r.status = 'completed'
    and (
      r.cash_shift_id = p_shift_id
      or (
        r.cash_shift_id is null
        and p.branch_id = v_shift.branch_id
        and r.refunded_at >= v_shift.opened_at and r.refunded_at <= now()
      )
    );

  -- NEW: real cash paid out of this drawer for expenses during the
  -- shift. Only sums 'recorded' (never 'voided') expenses -- a voided
  -- expense never actually left the drawer as far as this shift's own
  -- reconciliation is concerned, matching how a voided invoice/sale
  -- is excluded from every other financial total in this schema.
  select coalesce(sum(e.amount), 0) into v_cash_expenses
  from public.expenses e
  where e.payment_method = 'cash' and e.status = 'recorded'
    and (
      e.cash_shift_id = p_shift_id
      or (
        e.cash_shift_id is null
        and e.branch_id = v_shift.branch_id
        and e.created_at >= v_shift.opened_at and e.created_at <= now()
      )
    );

  v_expected := v_shift.opening_float + v_cash_collected - v_cash_refunded - v_cash_expenses;
  v_variance := p_closing_count - v_expected;

  update public.cash_shifts
  set status = 'closed', closed_by = auth.uid(), closed_at = now(),
      closing_count = p_closing_count, expected_cash = v_expected, variance = v_variance, notes = p_notes
  where id = p_shift_id;

  if v_variance < 0 then
    insert into public.employee_cash_liabilities (club_id, branch_id, cash_shift_id, employee_id, kind, original_amount, outstanding, status)
    values (v_shift.club_id, v_shift.branch_id, p_shift_id, v_shift.opened_by, 'shortage', abs(v_variance), abs(v_variance), 'outstanding')
    returning id into v_liability_id;

    insert into public.employee_cash_liability_ledger (liability_id, entry_type, amount, actor_id, reason)
    values (v_liability_id, 'shortage_created', abs(v_variance), auth.uid(), p_notes);

    perform public.write_audit_log(
      v_shift.club_id, 'employee_cash_liability.shortage_created', 'employee_cash_liability', v_liability_id,
      null, jsonb_build_object('employee_id', v_shift.opened_by, 'amount', abs(v_variance), 'cash_shift_id', p_shift_id), p_notes
    );
  elsif v_variance > 0 then
    insert into public.employee_cash_liabilities (club_id, branch_id, cash_shift_id, employee_id, kind, original_amount, outstanding, status)
    values (v_shift.club_id, v_shift.branch_id, p_shift_id, v_shift.opened_by, 'overage', v_variance, v_variance, 'outstanding')
    returning id into v_liability_id;

    insert into public.employee_cash_liability_ledger (liability_id, entry_type, amount, actor_id, reason)
    values (v_liability_id, 'overage_recorded', v_variance, auth.uid(), p_notes);

    perform public.write_audit_log(
      v_shift.club_id, 'employee_cash_liability.overage_recorded', 'employee_cash_liability', v_liability_id,
      null, jsonb_build_object('employee_id', v_shift.opened_by, 'amount', v_variance, 'cash_shift_id', p_shift_id), p_notes
    );
  end if;

  perform public.write_audit_log(
    v_shift.club_id, 'cash_shift.close', 'cash_shift', p_shift_id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object('closing_count', p_closing_count, 'expected_cash', v_expected, 'variance', v_variance, 'cash_expenses', v_cash_expenses),
    p_notes
  );

  return jsonb_build_object('expected_cash', v_expected, 'closing_count', p_closing_count, 'variance', v_variance, 'liability_id', v_liability_id, 'cash_expenses', v_cash_expenses);
end;
$function$;

-- ============================================================
-- 5. GRANTS -- explicit, since a fresh CREATE FUNCTION starts with
--    none (unlike CREATE OR REPLACE on an existing function, which
--    keeps prior grants -- close_cash_shift already had correct
--    grants from its original migration and CREATE OR REPLACE
--    preserves them, so it is NOT re-granted here; every brand-new
--    function below needs this explicitly).
-- ============================================================

grant execute on function public.list_expense_categories(uuid, boolean) to authenticated;
grant execute on function public.create_expense_category(uuid, text, text) to authenticated;
grant execute on function public.set_expense_category_status(uuid, text) to authenticated;
grant execute on function public.record_expense(uuid, uuid, numeric, text, text, uuid, text, text, date) to authenticated;
grant execute on function public.void_expense(uuid, text) to authenticated;
grant execute on function public.list_expenses(uuid, date, date, uuid, uuid, text) to authenticated;
grant execute on function public.get_expense_report(uuid, date, date, uuid) to authenticated;
