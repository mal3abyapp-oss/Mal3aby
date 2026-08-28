-- SHOP MODULE UX HARDENING (2026-08-28) -- real production acceptance
-- pass found public.shop_inventory_locations (client-side direct-table
-- writes from ShopSettingsPage.tsx, matching this table's own RLS-only
-- design) had the same two issues already found and fixed on
-- shop_suppliers:
--   1. Full default anon/authenticated table grants (INSERT/SELECT/
--      UPDATE/DELETE/...) despite FORCE RLS + real scoped policies --
--      same accepted-safe-but-inconsistent-with-convention class as
--      the earlier shop_suppliers finding, tightened for the same
--      defense-in-depth reason.
--   2. INSERT/UPDATE policies checked only user_club_ids() + a
--      permission key (inventory.receive) -- never
--      _shop_module_active(club_id). A club whose Shop module is not
--      entitled/active could still have its owner (who holds
--      inventory.receive by default -- confirmed live) create
--      inventory locations directly. Low practical impact (an orphaned
--      location row, no financial/data-integrity harm since nothing
--      else can write stock without the module being active -- already
--      fixed separately), but inconsistent with the module's own
--      "not entitled = nothing works" guarantee, fixed for
--      consistency with every other Shop write path.
revoke all on public.shop_inventory_locations from anon;
revoke all on public.shop_inventory_locations from authenticated;
grant select, insert, update on public.shop_inventory_locations to authenticated;

-- Module-active check applied to the WHOLE authorization expression
-- (both the regular-member branch AND the platform-support branch),
-- matching receive_shop_stock's own established precedent: that RPC
-- checks _shop_module_active() unconditionally AFTER its full
-- authorization OR-check, so even a platform support session cannot
-- write to a club's Shop data while the module is disabled for that
-- club.
drop policy if exists shop_inventory_locations_insert on public.shop_inventory_locations;
create policy shop_inventory_locations_insert on public.shop_inventory_locations
  for insert
  with check (
    (
      (club_id in (select public.user_club_ids()) and public.has_permission('inventory.receive', club_id))
      or public.has_platform_support_access(club_id, true)
    )
    and public._shop_module_active(club_id)
  );

drop policy if exists shop_inventory_locations_update on public.shop_inventory_locations;
create policy shop_inventory_locations_update on public.shop_inventory_locations
  for update
  using (
    (
      (club_id in (select public.user_club_ids()) and public.has_permission('inventory.receive', club_id))
      or public.has_platform_support_access(club_id, true)
    )
    and public._shop_module_active(club_id)
  );
