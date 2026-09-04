-- MAL3ABY V1 COMMERCIAL PACKAGING -- Step 6: extend public_plans to
-- expose plan id, plan family name, and capacity limits so the public
-- pricing page can render actual branch/field/academy/staff/active-
-- player numbers per tier without a second authenticated query. Purely
-- additive (no column removed) -- existing PricingPage.tsx query
-- (`select('*')`) keeps working unchanged; only gains new columns.
--
-- `id` is safe to expose (used as create_platform_subscription's
-- p_plan_id and as a stable React key -- already effectively
-- discoverable since it round-trips through create_platform_subscription
-- error messages/URLs in the Platform Owner UI, and is not a secret).
-- `name` (the English/family label, e.g. "Starter", "Starter (Annual)")
-- lets the frontend GROUP the two billing-interval rows per tier
-- without parsing name_ar text.
-- CREATE OR REPLACE VIEW cannot reorder/prepend columns ahead of an
-- existing view's leading column (Postgres error 42P16) -- the live
-- view begins with name_ar, not id. Since nothing depends on this view
-- (verified via pg_depend before this migration was applied -- zero
-- dependent views/rules), DROP + CREATE is safe here.
--
-- IMPORTANT (found live via get_advisors immediately after first
-- applying this migration without this option): a bare CREATE VIEW
-- with no explicit security_invoker setting runs with definer-like
-- semantics (the view owner's privileges, not the querying role's) --
-- Supabase's linter correctly flags this as security_definer_view,
-- ERROR level. This view is a genuinely public, non-sensitive subset
-- (is_public=true/status='active' plans, granted to anon+authenticated)
-- so security_invoker=true is the correct fix, matching every other
-- view in this release (commercial_entitlements_usage,
-- whatsapp_usage_by_club).
drop view if exists public.public_plans;

create view public.public_plans
with (security_invoker = true) as
select id, name, name_ar, description_ar, billing_interval, billing_interval_count, price, currency,
       discount_label, features_summary, default_grace_period_days,
       default_branch_limit, default_field_limit, default_academy_limit,
       default_staff_limit, default_active_player_limit, display_order
from public.platform_plans
where is_public = true and status = 'active'
order by display_order;

grant select on public.public_plans to anon;
grant select on public.public_plans to authenticated;

comment on view public.public_plans is
  'Safe public column subset of platform_plans (ADR-040 definer-view pattern), security_invoker=true so it respects the querying role''s own privileges rather than the view owner''s. Extended for commercial packaging release: id/name/capacity-limit columns added so the public pricing page can show real branch/field/academy/staff/active-player numbers per tier and group monthly+annual rows by plan family. Still excludes internal-only columns (status, is_public, created_at/updated_at, default_modules).';
