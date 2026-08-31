-- CUSTOMER/PARENT EXPERIENCE DIRECTIVE, Section 2A: closes the last
-- Academy P3 finding (AC7 from ACADEMY_PRODUCTION_ACCEPTANCE.md).
--
-- get_my_portal_academy() had two related bugs:
--   1. `left join subscriptions s on s.enrollment_id = e.id` had no
--      ordering/limit -- an enrollment with renewal history (multiple
--      subscription rows) could surface an arbitrary historical
--      subscription instead of the current one, in an undefined row
--      order. The frontend (PortalAcademyPage.tsx) then naively took
--      `subscriptions[0]`, compounding the ambiguity.
--   2. The returned `subscription_end_date` was the raw `end_date`
--      column, never adjusted for an active freeze extension -- a
--      parent could see a stale/wrong expiry date for a subscription
--      that was frozen with extends_expiry = true.
--
-- Fix: adopt the exact same deterministic-selection pattern already
-- proven correct in get_customer_academy_players() (`left join
-- lateral (... order by created_at desc limit 1) s on true`), and
-- inline the freeze-sum effective-date math directly (the same
-- reasoning as the AC5 cron fix: get_subscription_effective_end_date()
-- is permission-gated against has_permission('subscription.view', ...),
-- which requires a club_memberships row -- a pure customer/guardian
-- portal user has NONE, so calling the gated wrapper from here would
-- silently return NULL for every portal customer, not just fail to
-- account for freezes).
--
-- Return shape is UNCHANGED (same column names/types) -- this is a
-- body-only fix, no frontend contract change required beyond reading
-- the now-correct value.
create or replace function public.get_my_portal_academy()
 returns table(player_id uuid, player_full_name text, player_photo_url text, enrollment_id uuid, enrollment_status text, group_name text, branch_name text, field_name text, subscription_status text, subscription_end_date date)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select p.id, p.full_name, p.photo_url, e.id, e.status, g.name, br.name, f.name,
    s.status,
    -- Effective end date: raw end_date + sum of extends_expiry freeze
    -- durations, computed inline (mirrors get_subscription_effective_
    -- end_date()'s own math exactly, just without that function's
    -- has_permission() gate, which a portal customer can never pass).
    case when s.id is null then null else
      s.end_date + coalesce(
        (select sum(sf.end_date - sf.start_date)::int from public.subscription_freezes sf
         where sf.subscription_id = s.id and sf.extends_expiry = true),
        0
      )
    end
  from public.players p
  join public.guardian_links gl on gl.player_id = p.id
  join public.customers c on c.id = gl.customer_id
  left join public.enrollments e on e.player_id = p.id
  left join public.groups g on g.id = e.group_id
  left join public.branches br on br.id = g.branch_id
  left join public.fields f on f.id = g.field_id
  left join lateral (
    select s2.* from public.subscriptions s2
    where s2.enrollment_id = e.id
    order by s2.created_at desc limit 1
  ) s on true
  where c.user_id = auth.uid();
$function$;
