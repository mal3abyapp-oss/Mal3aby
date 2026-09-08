-- Platform Owner Control Plane V1, Phase 8 (WhatsApp Platform Visibility).
--
-- get_whatsapp_usage_platform_wide() (20260904210400) has ZERO frontend
-- call site anywhere in src/ (confirmed by the Platform Owner deep dive,
-- Section 22) and, unlike every sibling platform-wide aggregate fixed by
-- the M-2 remediation (20260903140100), was never updated to exclude
-- QA/test-fixture clubs -- because nothing read it yet, the gap was
-- latent rather than live. This migration wires the RPC into a real
-- screen (PlatformReportsPage's new WhatsApp tab) in the same commit,
-- so the fixture-filter fix ships at the same time the data actually
-- becomes visible, rather than leaving a second M-2-shaped gap to be
-- rediscovered later.
--
-- Fix approach: identical predicate style already established by
-- search_platform_clubs() / the M-2 migration --
-- `coalesce(c.is_test_fixture, false) = false` -- applied inside the RPC
-- (not the underlying whatsapp_usage_by_club view, which stays a
-- reusable building block; the platform-wide RPC is the one place that
-- must exclude fixtures, matching how get_platform_whatsapp_health()
-- already handles the same distinction).
create or replace function public.get_whatsapp_usage_platform_wide()
returns setof public.whatsapp_usage_by_club
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select w.*
  from public.whatsapp_usage_by_club w
  join public.clubs c on c.id = w.club_id
  where public.is_platform_owner()
    and coalesce(c.is_test_fixture, false) = false
  order by w.messages_last_30d desc;
$$;

comment on function public.get_whatsapp_usage_platform_wide() is
  'Platform-Owner-only (the WHERE clause returns zero rows for any non-platform-owner caller, matching this codebase''s established defensive-empty-result pattern rather than raising). QA/test-fixture clubs excluded (Platform Owner Control Plane V1, Phase 8) -- the M-2 remediation missed this RPC because it had no frontend call site at the time; now wired into PlatformReportsPage''s WhatsApp tab in the same change. No new WhatsApp billing infrastructure -- read-only aggregation of existing notification_queue rows.';
