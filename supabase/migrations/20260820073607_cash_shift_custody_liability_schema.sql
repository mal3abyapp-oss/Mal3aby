-- Phase D: Cash Shift / Employee Custody / Shortage Liability.
--
-- Builds on the existing lean-V1 cash_shifts (20260817040000) rather
-- than replacing it -- that migration's open/close/variance mechanics
-- are correct and stay as-is. This adds what was missing: an explicit
-- per-person custody flag, a hard link from each cash payment/refund to
-- the shift that collected it (replacing the prior time-window-only
-- derivation, which worked for the existing variance math but couldn't
-- support D16's "which payments does this shift actually contain"
-- question precisely once concurrent same-branch activity is possible),
-- and a real accountable liability ledger for shortages -- not a single
-- mutable balance column, an append-only ledger so partial settlements,
-- adjustments, and reversals are all individually audited and the
-- current balance is always a derived sum, never directly overwritten.

begin;

-- D1: employee custody -- explicit per (user, club), not inferred from
-- role. A club_owner or receptionist role doesn't automatically imply
-- custody; a club decides per person. Defaults false -- no employee is
-- silently granted cash-handling responsibility.
alter table public.club_memberships
  add column has_cash_custody boolean not null default false;

comment on column public.club_memberships.has_cash_custody is
  'Phase D: explicit per-person cash-handling authorization. Independent of role -- a club_owner is not automatically granted custody. Gates whether cash_shifts/liability ledger apply to this person at all (D2: cash collection by a custody employee requires an active shift).';

-- D5: explicit link from a cash payment/refund to the shift that
-- collected it, instead of deriving membership purely from
-- received_at falling inside [opened_at, closed_at]. The time-window
-- approach close_cash_shift()/get_open_cash_shift_status() already use
-- remains correct and is NOT changed here (touching working
-- reconciliation math for its own sake is out of scope) -- this column
-- is additive, used by the new liability/audit surfaces that need to
-- answer "which shift does this specific payment belong to" precisely,
-- and by future close_cash_shift() calls to become the authoritative
-- link going forward. Nullable: a payment method other than cash, or a
-- cash payment collected by someone without custody (see D2's guard,
-- next migration), never gets one.
alter table public.payments
  add column cash_shift_id uuid references public.cash_shifts(id);

create index payments_cash_shift_id_idx on public.payments(cash_shift_id) where cash_shift_id is not null;

alter table public.refunds
  add column cash_shift_id uuid references public.cash_shifts(id);

create index refunds_cash_shift_id_idx on public.refunds(cash_shift_id) where cash_shift_id is not null;

-- D10/D11: one row per shortage or overage EVENT (created once, at
-- shift close, when close_cash_shift()'s own variance is negative or
-- positive). A shortage survives shift closure (D10: "It survives
-- shift closure") and accumulates settlements over time via the ledger
-- below -- this row's own `outstanding` column is a DERIVED, cached
-- total for fast reads (recomputed by every ledger-writing RPC in the
-- same transaction as the ledger insert, never edited independently).
create table public.employee_cash_liabilities (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  cash_shift_id uuid not null references public.cash_shifts(id),
  employee_id uuid not null references auth.users(id),
  kind text not null check (kind in ('shortage', 'overage')),
  original_amount numeric not null check (original_amount > 0),
  outstanding numeric not null check (outstanding >= 0),
  status text not null default 'outstanding' check (status in ('outstanding', 'settled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ecl_settled_zero_outstanding check (
    (status = 'settled' and outstanding = 0) or (status = 'outstanding' and outstanding > 0)
  )
);

comment on table public.employee_cash_liabilities is
  'Phase D: one row per shortage/overage discovered at cash-shift close. outstanding is a cached derived total, kept in sync with employee_cash_liability_ledger by every RPC that writes a ledger entry -- never updated directly outside those RPCs.';

create index ecl_employee_idx on public.employee_cash_liabilities(employee_id, status);
create index ecl_club_idx on public.employee_cash_liabilities(club_id, status);

-- D11/D12/D13/D14: append-only ledger -- the real audit trail. A
-- shortage's `outstanding` balance is ALWAYS a sum over this table for
-- that liability_id, never a value some RPC just overwrites (D11:
-- "Never overwrite balance directly").
create table public.employee_cash_liability_ledger (
  id uuid primary key default gen_random_uuid(),
  liability_id uuid not null references public.employee_cash_liabilities(id),
  entry_type text not null check (entry_type in ('shortage_created', 'settlement', 'adjustment', 'reversal')),
  -- Positive = increases outstanding (shortage_created, a positive
  -- adjustment). Negative = decreases outstanding (settlement, a
  -- negative adjustment, a reversal of a shortage_created entry).
  amount numeric not null,
  actor_id uuid not null references auth.users(id),
  reason text,
  created_at timestamptz not null default now()
);

create index ecll_liability_idx on public.employee_cash_liability_ledger(liability_id, created_at);

comment on table public.employee_cash_liability_ledger is
  'Phase D: append-only. shortage_created is the initial positive entry when a liability row is created; settlement/adjustment/reversal entries move the balance from there. Sum(amount) over a liability_id always equals that liability''s outstanding column.';

alter table public.employee_cash_liabilities enable row level security;
alter table public.employee_cash_liability_ledger enable row level security;

create policy "ecl_select_own_club" on public.employee_cash_liabilities
  for select using (club_id in (select public.user_club_ids()));

create policy "ecll_select_own_club" on public.employee_cash_liability_ledger
  for select using (
    liability_id in (select id from public.employee_cash_liabilities where club_id in (select public.user_club_ids()))
  );

-- No direct INSERT/UPDATE policy on either table -- every write goes
-- through SECURITY DEFINER RPCs in the next migration, same pattern as
-- cash_shifts itself.

commit;
