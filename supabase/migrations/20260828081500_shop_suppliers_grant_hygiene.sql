-- SHOP MODULE UX HARDENING (2026-08-28) -- real production acceptance
-- pass found public.shop_suppliers had ZERO UI/RPC consumers anywhere
-- (confirmed: no routine in pg_proc references it), yet carried full
-- default anon/authenticated/service_role table grants
-- (INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER for every
-- role including anon). FORCE ROW LEVEL SECURITY is already on and the
-- 3 real policies (insert/select/update) only match `authenticated`
-- callers holding inventory.receive/inventory.view for their own club
-- -- so this was NOT an active exploit (same accepted-safe pattern as
-- the earlier-documented whatsapp_accounts finding: forced RLS + zero
-- matching policy for a role = default-deny for that role), but it
-- violates this project's own established "RPC-only, no direct
-- anon-writable table grants" convention. Tightened as defense in
-- depth while adding the first real UI consumer for this table.
revoke all on public.shop_suppliers from anon;
revoke all on public.shop_suppliers from authenticated;
grant select, insert, update on public.shop_suppliers to authenticated;
-- No delete grant: suppliers are archived (is_active = false) via the
-- same update path client-side, matching every other Shop entity's
-- soft-delete convention (products, categories) rather than a hard
-- DELETE.
