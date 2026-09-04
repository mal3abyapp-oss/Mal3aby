-- Follow-up to 20260904150000_sales_ai_offer_generator_provider_agnostic.sql.
--
-- Same defect class already documented and fixed elsewhere in this
-- project (e.g. 20260901090500_drop_search_platform_clubs_stale_overload.sql):
-- CREATE OR REPLACE FUNCTION with new trailing parameters creates a
-- SECOND overload in Postgres rather than replacing the original,
-- since the parameter count differs even though every new parameter
-- has a default. The original 8-arg sales_generate_outreach_message()
-- was left live, still granted EXECUTE to authenticated/service_role,
-- and does NOT persist ai_provider/ai_model/ai_usage/ai_latency_ms --
-- any caller invoking it with exactly 8 positional/named args (an old
-- cached client, or a future direct call) would silently generate a
-- message with no AI-provider attribution, defeating the whole point
-- of the provider-agnostic tracking just added.
--
-- Drop the stale 8-arg overload. The new 12-arg version (with the 4
-- new params defaulting to null) is the only one the Edge Function
-- calls, and remains fully functional for a caller that omits them.
drop function if exists public.sales_generate_outreach_message(
  uuid, text, text, text, text, text, jsonb, uuid
);
