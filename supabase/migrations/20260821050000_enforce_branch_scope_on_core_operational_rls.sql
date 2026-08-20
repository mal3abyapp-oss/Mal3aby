-- P1 security fix: branch-scoped memberships could read and mutate rows in
-- every branch of their club because core RLS checked club_id + permission
-- only.  Centralize the active-membership + branch-scope predicate and apply
-- it to the operational tables that carry a branch_id (or inherit one).

create or replace function public.user_has_branch_access(p_club_id uuid, p_branch_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select public.is_platform_owner()
    or exists (
      select 1
      from public.club_memberships cm
      where cm.user_id = (select auth.uid())
        and cm.club_id = p_club_id
        and cm.status = 'active'
        and (
          not exists (
            select 1 from public.membership_branches mb
            where mb.membership_id = cm.id
          )
          or (
            p_branch_id is not null
            and exists (
              select 1 from public.membership_branches mb
              where mb.membership_id = cm.id
                and mb.branch_id = p_branch_id
            )
          )
        )
    )
$$;

revoke all on function public.user_has_branch_access(uuid, uuid) from public, anon;
grant execute on function public.user_has_branch_access(uuid, uuid) to authenticated;

create or replace function public.user_has_field_access(p_club_id uuid, p_field_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.fields f
    where f.id = p_field_id
      and f.club_id = p_club_id
      and public.user_has_branch_access(f.club_id, f.branch_id)
  )
$$;

revoke all on function public.user_has_field_access(uuid, uuid) from public, anon;
grant execute on function public.user_has_field_access(uuid, uuid) to authenticated;

drop policy if exists branches_select_own_club on public.branches;
create policy branches_select_own_club on public.branches for select using (
  club_id in (select public.user_club_ids())
  and public.user_has_branch_access(club_id, id)
);

drop policy if exists branches_update_with_permission on public.branches;
create policy branches_update_with_permission on public.branches for update using (
  club_id in (select public.user_club_ids())
  and public.has_permission('branch.update', club_id)
  and public.user_has_branch_access(club_id, id)
) with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('branch.update', club_id)
  and public.user_has_branch_access(club_id, id)
);

drop policy if exists fields_select_club_staff on public.fields;
create policy fields_select_club_staff on public.fields for select using (
  club_id in (select public.user_club_ids())
  and public.has_permission('field.view', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);
drop policy if exists fields_insert_with_permission on public.fields;
create policy fields_insert_with_permission on public.fields for insert with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('field.create', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);
drop policy if exists fields_update_with_permission on public.fields;
create policy fields_update_with_permission on public.fields for update using (
  club_id in (select public.user_club_ids())
  and public.has_permission('field.update', club_id)
  and public.user_has_branch_access(club_id, branch_id)
) with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('field.update', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);

drop policy if exists field_operating_hours_select_club_staff on public.field_operating_hours;
create policy field_operating_hours_select_club_staff on public.field_operating_hours for select using (
  club_id in (select public.user_club_ids())
  and public.has_permission('field.view', club_id)
  and (
    (branch_id is not null and public.user_has_branch_access(club_id, branch_id))
    or (field_id is not null and public.user_has_field_access(club_id, field_id))
    or (branch_id is null and field_id is null and public.user_has_branch_access(club_id, null))
  )
);
drop policy if exists field_operating_hours_write_with_permission on public.field_operating_hours;
create policy field_operating_hours_write_with_permission on public.field_operating_hours for insert with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('field.update', club_id)
  and (
    (branch_id is not null and public.user_has_branch_access(club_id, branch_id))
    or (field_id is not null and public.user_has_field_access(club_id, field_id))
    or (branch_id is null and field_id is null and public.user_has_branch_access(club_id, null))
  )
);
drop policy if exists field_operating_hours_update_with_permission on public.field_operating_hours;
create policy field_operating_hours_update_with_permission on public.field_operating_hours for update using (
  club_id in (select public.user_club_ids())
  and public.has_permission('field.update', club_id)
  and (
    (branch_id is not null and public.user_has_branch_access(club_id, branch_id))
    or (field_id is not null and public.user_has_field_access(club_id, field_id))
    or (branch_id is null and field_id is null and public.user_has_branch_access(club_id, null))
  )
) with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('field.update', club_id)
  and (
    (branch_id is not null and public.user_has_branch_access(club_id, branch_id))
    or (field_id is not null and public.user_has_field_access(club_id, field_id))
    or (branch_id is null and field_id is null and public.user_has_branch_access(club_id, null))
  )
);
drop policy if exists field_operating_hours_delete_with_permission on public.field_operating_hours;
create policy field_operating_hours_delete_with_permission on public.field_operating_hours for delete using (
  club_id in (select public.user_club_ids())
  and public.has_permission('field.update', club_id)
  and (
    (branch_id is not null and public.user_has_branch_access(club_id, branch_id))
    or (field_id is not null and public.user_has_field_access(club_id, field_id))
    or (branch_id is null and field_id is null and public.user_has_branch_access(club_id, null))
  )
);

drop policy if exists field_blocks_select_club_staff on public.field_blocks;
create policy field_blocks_select_club_staff on public.field_blocks for select using (
  club_id in (select public.user_club_ids())
  and public.has_permission('field.view', club_id)
  and public.user_has_field_access(club_id, field_id)
);
drop policy if exists field_blocks_write_with_permission on public.field_blocks;
create policy field_blocks_write_with_permission on public.field_blocks for insert with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('field.update', club_id)
  and public.user_has_field_access(club_id, field_id)
);

drop policy if exists pricing_rules_select_club_staff on public.pricing_rules;
create policy pricing_rules_select_club_staff on public.pricing_rules for select using (
  club_id in (select public.user_club_ids())
  and public.has_permission('pricing.view', club_id)
  and (
    (field_id is not null and public.user_has_field_access(club_id, field_id))
    or (field_id is null and public.user_has_branch_access(club_id, null))
  )
);
drop policy if exists pricing_rules_write_with_permission on public.pricing_rules;
create policy pricing_rules_write_with_permission on public.pricing_rules for insert with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('pricing.update', club_id)
  and (
    (field_id is not null and public.user_has_field_access(club_id, field_id))
    or (field_id is null and public.user_has_branch_access(club_id, null))
  )
);
drop policy if exists pricing_rules_update_with_permission on public.pricing_rules;
create policy pricing_rules_update_with_permission on public.pricing_rules for update using (
  club_id in (select public.user_club_ids())
  and public.has_permission('pricing.update', club_id)
  and (
    (field_id is not null and public.user_has_field_access(club_id, field_id))
    or (field_id is null and public.user_has_branch_access(club_id, null))
  )
) with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('pricing.update', club_id)
  and (
    (field_id is not null and public.user_has_field_access(club_id, field_id))
    or (field_id is null and public.user_has_branch_access(club_id, null))
  )
);
drop policy if exists pricing_rules_delete_with_permission on public.pricing_rules;
create policy pricing_rules_delete_with_permission on public.pricing_rules for delete using (
  club_id in (select public.user_club_ids())
  and public.has_permission('pricing.update', club_id)
  and (
    (field_id is not null and public.user_has_field_access(club_id, field_id))
    or (field_id is null and public.user_has_branch_access(club_id, null))
  )
);

drop policy if exists bookings_select_club_staff on public.bookings;
create policy bookings_select_club_staff on public.bookings for select using (
  club_id in (select public.user_club_ids())
  and public.has_permission('booking.view', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);
drop policy if exists bookings_insert_with_permission on public.bookings;
create policy bookings_insert_with_permission on public.bookings for insert with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('booking.create', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);
drop policy if exists bookings_update_with_permission on public.bookings;
create policy bookings_update_with_permission on public.bookings for update using (
  club_id in (select public.user_club_ids())
  and public.has_permission('booking.update', club_id)
  and public.user_has_branch_access(club_id, branch_id)
) with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('booking.update', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);

drop policy if exists booking_series_select_club_staff on public.booking_series;
create policy booking_series_select_club_staff on public.booking_series for select using (
  club_id in (select public.user_club_ids())
  and public.has_permission('booking.view', club_id)
  and public.user_has_field_access(club_id, field_id)
);
drop policy if exists booking_series_insert_with_permission on public.booking_series;
create policy booking_series_insert_with_permission on public.booking_series for insert with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('booking.create', club_id)
  and public.user_has_field_access(club_id, field_id)
);
drop policy if exists booking_series_update_with_permission on public.booking_series;
create policy booking_series_update_with_permission on public.booking_series for update using (
  club_id in (select public.user_club_ids())
  and public.has_permission('booking.create', club_id)
  and public.user_has_field_access(club_id, field_id)
) with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('booking.create', club_id)
  and public.user_has_field_access(club_id, field_id)
);

drop policy if exists invoices_select_club_staff on public.invoices;
create policy invoices_select_club_staff on public.invoices for select using (
  club_id in (select public.user_club_ids())
  and public.has_permission('invoice.view', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);
drop policy if exists invoices_insert_with_permission on public.invoices;
create policy invoices_insert_with_permission on public.invoices for insert with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('invoice.create', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);
drop policy if exists invoices_update_with_permission on public.invoices;
create policy invoices_update_with_permission on public.invoices for update using (
  club_id in (select public.user_club_ids())
  and public.has_permission('invoice.update', club_id)
  and public.user_has_branch_access(club_id, branch_id)
) with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('invoice.update', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);

drop policy if exists invoice_items_select_club_staff on public.invoice_items;
create policy invoice_items_select_club_staff on public.invoice_items for select using (
  exists (select 1 from public.invoices i where i.id = invoice_id)
);
drop policy if exists invoice_items_insert_with_permission on public.invoice_items;
create policy invoice_items_insert_with_permission on public.invoice_items for insert with check (
  exists (
    select 1 from public.invoices i where i.id = invoice_id
      and public.has_permission('invoice.create', i.club_id)
      and public.user_has_branch_access(i.club_id, i.branch_id)
  )
);
drop policy if exists invoice_items_update_with_permission on public.invoice_items;
create policy invoice_items_update_with_permission on public.invoice_items for update using (
  exists (
    select 1 from public.invoices i where i.id = invoice_id
      and public.has_permission('invoice.update', i.club_id)
      and public.user_has_branch_access(i.club_id, i.branch_id)
      and i.status <> 'issued'
  )
);

drop policy if exists payments_select_club_staff on public.payments;
create policy payments_select_club_staff on public.payments for select using (
  club_id in (select public.user_club_ids())
  and public.has_permission('payment.view', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);
drop policy if exists payments_insert_with_permission on public.payments;
create policy payments_insert_with_permission on public.payments for insert with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('payment.create', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);
drop policy if exists payments_update_with_permission on public.payments;
create policy payments_update_with_permission on public.payments for update using (
  club_id in (select public.user_club_ids())
  and public.has_permission('payment.update', club_id)
  and public.user_has_branch_access(club_id, branch_id)
) with check (
  club_id in (select public.user_club_ids())
  and public.has_permission('payment.update', club_id)
  and public.user_has_branch_access(club_id, branch_id)
);

drop policy if exists payment_allocations_select_club_staff on public.payment_allocations;
create policy payment_allocations_select_club_staff on public.payment_allocations for select using (
  exists (select 1 from public.payments p where p.id = payment_id)
  and exists (select 1 from public.invoices i where i.id = invoice_id)
);
drop policy if exists payment_allocations_insert_with_permission on public.payment_allocations;
create policy payment_allocations_insert_with_permission on public.payment_allocations for insert with check (
  exists (
    select 1 from public.payments p
    join public.invoices i on i.id = invoice_id
    where p.id = payment_id
      and p.club_id = i.club_id
      and p.branch_id = i.branch_id
      and public.has_permission('payment.create', p.club_id)
      and public.user_has_branch_access(p.club_id, p.branch_id)
  )
);

drop policy if exists invoice_number_sequences_select_club_staff on public.invoice_number_sequences;
create policy invoice_number_sequences_select_club_staff on public.invoice_number_sequences for select using (
  exists (
    select 1 from public.branches b where b.id = branch_id
      and public.has_permission('invoice.view', b.club_id)
      and public.user_has_branch_access(b.club_id, b.id)
  )
);

comment on function public.user_has_branch_access(uuid, uuid) is
  'Central authenticated branch-scope predicate. Unscoped active memberships see all club branches; scoped memberships see only membership_branches rows; platform owners retain the documented bypass.';
