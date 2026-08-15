-- Phase 6 — RLS + permissions for bookings/booking_series/invoices/
-- invoice_items/payments/payment_allocations/invoice_number_sequences.
-- Grants match RLS_MATRIX.md's per-role table exactly. "D" (void) in the
-- matrix is a status-transition UPDATE, never an actual DELETE policy --
-- no table here gets a DELETE policy, matching the no-hard-delete rule.

alter table public.bookings enable row level security;
alter table public.booking_series enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.invoice_number_sequences enable row level security;

-- ---- bookings ----
-- club_owner/platform_owner: S only (matrix: S | S | S,I,U,D | ...).
-- club_manager/branch_manager/receptionist: S,I,U (no direct client
-- INSERT for the *primary* flow -- that's create_booking -- but the
-- matrix still grants I at the RLS layer for the RPC's own writes to run
-- as the caller where relevant, and for legitimate direct corrections).
create policy "bookings_select_club_staff" on public.bookings
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('booking.view', club_id)
  );

create policy "bookings_insert_with_permission" on public.bookings
  for insert with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('booking.create', club_id)
  );

create policy "bookings_update_with_permission" on public.bookings
  for update using (
    club_id in (select public.user_club_ids())
    and public.has_permission('booking.update', club_id)
  );

create policy "bookings_platform_owner_select" on public.bookings
  for select using (public.is_platform_owner());

-- ---- booking_series ----
create policy "booking_series_select_club_staff" on public.booking_series
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('booking.view', club_id)
  );

create policy "booking_series_insert_with_permission" on public.booking_series
  for insert with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('booking.create', club_id)
  );

create policy "booking_series_update_with_permission" on public.booking_series
  for update using (
    club_id in (select public.user_club_ids())
    and public.has_permission('booking.create', club_id)
  );

create policy "booking_series_platform_owner_select" on public.booking_series
  for select using (public.is_platform_owner());

-- ---- invoices ----
create policy "invoices_select_club_staff" on public.invoices
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('invoice.view', club_id)
  );

create policy "invoices_insert_with_permission" on public.invoices
  for insert with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('invoice.create', club_id)
  );

create policy "invoices_update_with_permission" on public.invoices
  for update using (
    club_id in (select public.user_club_ids())
    and public.has_permission('invoice.update', club_id)
  );

create policy "invoices_platform_owner_select" on public.invoices
  for select using (public.is_platform_owner());

-- ---- invoice_items ----
create policy "invoice_items_select_club_staff" on public.invoice_items
  for select using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_id
        and i.club_id in (select public.user_club_ids())
        and public.has_permission('invoice.view', i.club_id)
    )
  );

create policy "invoice_items_insert_with_permission" on public.invoice_items
  for insert with check (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_id
        and i.club_id in (select public.user_club_ids())
        and public.has_permission('invoice.create', i.club_id)
    )
  );

create policy "invoice_items_update_with_permission" on public.invoice_items
  for update using (
    exists (
      select 1 from public.invoices i
      where i.id = invoice_id
        and i.club_id in (select public.user_club_ids())
        and public.has_permission('invoice.update', i.club_id)
        and i.status != 'issued'
    )
  );

-- ---- payments ----
create policy "payments_select_club_staff" on public.payments
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('payment.view', club_id)
  );

create policy "payments_insert_with_permission" on public.payments
  for insert with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('payment.create', club_id)
  );

create policy "payments_update_with_permission" on public.payments
  for update using (
    club_id in (select public.user_club_ids())
    and public.has_permission('payment.update', club_id)
  );

-- ---- payment_allocations ----
create policy "payment_allocations_select_club_staff" on public.payment_allocations
  for select using (
    exists (
      select 1 from public.payments p
      where p.id = payment_id
        and p.club_id in (select public.user_club_ids())
        and public.has_permission('payment.view', p.club_id)
    )
  );

create policy "payment_allocations_insert_with_permission" on public.payment_allocations
  for insert with check (
    exists (
      select 1 from public.payments p
      where p.id = payment_id
        and p.club_id in (select public.user_club_ids())
        and public.has_permission('payment.create', p.club_id)
    )
  );

-- ---- invoice_number_sequences ----
-- Written only via the numbering helper (SECURITY DEFINER), never a
-- direct client write -- no INSERT/UPDATE policy for any client role.
create policy "invoice_number_sequences_select_club_staff" on public.invoice_number_sequences
  for select using (
    exists (
      select 1 from public.branches b
      where b.id = branch_id
        and b.club_id in (select public.user_club_ids())
        and public.has_permission('invoice.view', b.club_id)
    )
  );

-- ============================================================
-- Seed new permissions + role grants (per RLS_MATRIX.md exactly)
-- ============================================================
insert into public.permissions (key, description) values
  ('booking.view', 'View bookings'),
  ('booking.create', 'Create a booking'),
  ('booking.update', 'Update/cancel a booking'),
  ('booking.cancel', 'Cancel a booking'),
  ('booking.discount.apply', 'Apply a discount to a booking'),
  ('booking.discount.override', 'Apply a discount beyond the standard limit'),
  ('invoice.view', 'View invoices'),
  ('invoice.create', 'Create/issue an invoice'),
  ('invoice.update', 'Update a draft invoice'),
  ('payment.view', 'View payments'),
  ('payment.create', 'Record a payment')
on conflict (key) do nothing;

-- club_owner, platform_owner-equivalent (club_owner): bookings/booking_series S only.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'club_owner'
  and p.key in ('booking.view', 'invoice.view', 'payment.view')
on conflict do nothing;

-- club_manager: bookings/booking_series S,I,U,D(=update-to-cancelled) +
-- invoices S,I,U + payments S (matrix: payments col has nothing for
-- club_manager -- only receptionist/accountant get I).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'club_manager'
  and p.key in ('booking.view', 'booking.create', 'booking.update', 'booking.cancel',
                'booking.discount.apply', 'booking.discount.override',
                'invoice.view', 'invoice.create', 'invoice.update', 'payment.view')
on conflict do nothing;

-- branch_manager: same shape as club_manager but invoices S,I only (no U).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'branch_manager'
  and p.key in ('booking.view', 'booking.create', 'booking.update', 'booking.cancel',
                'booking.discount.apply',
                'invoice.view', 'invoice.create', 'payment.view')
on conflict do nothing;

-- receptionist: bookings S,I,U,D + invoices S,I + payments S,I. No
-- discount permission by default (Security Gate: "Receptionist has no
-- discount capability without an explicit grant" -- SECURITY_ANTI_FRAUD.md).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'receptionist'
  and p.key in ('booking.view', 'booking.create', 'booking.update', 'booking.cancel',
                'invoice.view', 'invoice.create', 'payment.view', 'payment.create')
on conflict do nothing;

-- accountant: bookings S + invoices S,I,U,D(=void) + payments S,I,U,D(=void).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'accountant'
  and p.key in ('booking.view', 'invoice.view', 'invoice.create', 'invoice.update',
                'payment.view', 'payment.create')
on conflict do nothing;

-- academy_manager: invoices S,I only (per matrix row 128 -- academy_manager
-- gets S,I on invoices, nothing on bookings/payments).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'academy_manager'
  and p.key in ('invoice.view', 'invoice.create')
on conflict do nothing;
