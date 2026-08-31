-- Follow-up to 20260901090000_add_clubs_is_test_fixture_marker.sql.
--
-- CREATE OR REPLACE FUNCTION with a new trailing parameter creates a
-- SECOND overload in Postgres (signature change = new function
-- object) rather than replacing the original -- the same pattern
-- already documented from prior migration work in this project. The
-- original 7-arg search_platform_clubs() was left live, still granted
-- EXECUTE to `authenticated`, and does NOT know about
-- is_test_fixture -- any caller invoking it with exactly 7 positional
-- args would silently get QA fixtures mixed back into results,
-- defeating the whole point of this fix.
--
-- Drop the stale 7-arg overload. The new 8-arg version (with
-- p_include_test_fixtures default false) is the only one the
-- frontend calls (named-parameter RPC calls always resolve to the
-- one matching signature) and remains fully functional.
drop function if exists public.search_platform_clubs(
  text, text, text, text, boolean, integer, integer
);
