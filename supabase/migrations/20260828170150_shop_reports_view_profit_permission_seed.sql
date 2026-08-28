-- Commerce Pro C7: seeds shop.reports.view_profit (plan Section 3),
-- gap flagged but deliberately left unseeded by C6
-- ("Correction found during this phase: ... shop.reports.view_profit
-- ... was never actually seeded ... flagging the plan-vs-reality gap
-- here for whichever future phase (C7, cost-at-sale) actually needs
-- it" -- COMMERCE_C6_DASHBOARD_REPORT.md Section 4). C7 is that phase:
-- Gross Profit/Margin and Stock Valuation both expose real cost data
-- for the first time, so the permission this data needs to be gated
-- behind now has something real to protect. Follows the exact
-- established seed pattern (20260826205943_shop_inventory_permissions_seed.sql,
-- 20260828120000_shop_discount_permissions_seed.sql).
insert into public.permissions (key, description) values
  ('shop.reports.view_profit', 'View Shop profitability reports (Gross Profit/Margin, Stock Valuation) -- cost data is commercially sensitive, gated separately from shop.view/report.view')
on conflict (key) do nothing;

-- club_owner only, by default -- matches the plan's own framing of
-- this permission ("cost data is commercially sensitive... gated
-- separately") and this codebase's existing posture on other
-- commercially-sensitive views (e.g. shop.settings.manage is
-- club_owner-only). A club owner can grant it further via existing
-- role-composition mechanics if they want a manager/accountant to see
-- margin data too -- not granted to any other built-in role here.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.key = 'club_owner'
  and p.key = 'shop.reports.view_profit'
on conflict (role_id, permission_id) do nothing;

-- Dependency: viewing profit reports requires being able to view Shop
-- reports at all (report.view is the base gate every other Shop report
-- RPC already checks) -- mirrors shop.discount.apply's own dependency
-- on shop.sale.create (you can't have the narrower capability without
-- the broader one it sits inside).
insert into public.permission_dependencies (permission_key, requires_key) values
  ('shop.reports.view_profit', 'report.view')
on conflict (permission_key, requires_key) do nothing;
