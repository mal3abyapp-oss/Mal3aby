-- Sales Intelligence: AI Offer Generator becomes provider-agnostic
-- (2026-09-04). Owner decision: "Anthropic paid API usage is NOT
-- approved for Mal3aby at this stage... Anthropic may remain
-- implemented as an OPTIONAL provider for future use, but Mal3aby must
-- not require it." sales-ai-offer-generator/index.ts now calls through
-- _shared/ai-provider-adapter.ts, selecting the active provider from
-- sales_provider_configs.ai_offer_generator.config->>'provider'
-- (defaults to 'groq', Mal3aby's supported zero-cost default) rather
-- than hardcoding Anthropic. This migration adds the columns needed to
-- record, per generated message, which real provider/model actually
-- ran it -- required by the acceptance mission ("provider recorded,
-- model recorded, usage recorded where available").
--
-- sales_provider_configs itself needs NO schema change: its existing
-- `config jsonb` column (added in the original schema specifically
-- for "non-secret provider config, e.g. {"model": "...", ...}") already
-- covers {"provider": "groq", "model": "openai/gpt-oss-120b", ...} --
-- the provider_key check constraint stays 'ai_offer_generator' (the
-- logical module slot), the underlying AI vendor is config data, not a
-- schema-level identity.

alter table public.sales_outreach_messages
  add column if not exists ai_provider text,
  add column if not exists ai_model text,
  add column if not exists ai_usage jsonb,
  add column if not exists ai_latency_ms int;

comment on column public.sales_outreach_messages.ai_provider is 'Which AI adapter actually generated this message (e.g. groq, anthropic) -- null for manually-authored/non-AI messages.';
comment on column public.sales_outreach_messages.ai_model is 'The specific model id used, e.g. openai/gpt-oss-120b -- null for manually-authored/non-AI messages.';
comment on column public.sales_outreach_messages.ai_usage is 'Token usage reported by the provider where available: {"input_tokens": n, "output_tokens": n}. Null if the provider did not report usage.';
comment on column public.sales_outreach_messages.ai_latency_ms is 'Round-trip latency of the AI generation call in milliseconds, for provider health/observability.';

-- sales_generate_outreach_message(): widen to accept and persist the
-- new provider/model/usage/latency fields. Same authorization logic,
-- same do_not_contact guard, same activity-log wiring -- only the
-- insert/column list changes. Old callers that omit the new params
-- (all default null) behave identically to before.
create or replace function public.sales_generate_outreach_message(
  p_lead_id uuid,
  p_channel text,
  p_message_type text,
  p_language text,
  p_subject text,
  p_body text,
  p_grounding jsonb,
  p_campaign_id uuid default null,
  p_ai_provider text default null,
  p_ai_model text default null,
  p_ai_usage jsonb default null,
  p_ai_latency_ms int default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_message_id uuid;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.generate_offer')) then
    raise exception 'not authorized';
  end if;

  if exists (select 1 from public.sales_leads where id = p_lead_id and status = 'do_not_contact') then
    raise exception 'this lead is marked do_not_contact -- outreach content cannot be generated for it';
  end if;

  insert into public.sales_outreach_messages (
    lead_id, campaign_id, channel, message_type, language, subject, body, grounding,
    ai_provider, ai_model, ai_usage, ai_latency_ms, created_by
  )
  values (
    p_lead_id, p_campaign_id, p_channel, p_message_type, p_language, p_subject, p_body, p_grounding,
    p_ai_provider, p_ai_model, p_ai_usage, p_ai_latency_ms, auth.uid()
  )
  returning id into v_message_id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (
    p_lead_id, 'message_generated',
    jsonb_build_object('message_id', v_message_id, 'channel', p_channel, 'type', p_message_type, 'ai_provider', p_ai_provider, 'ai_model', p_ai_model),
    auth.uid()
  );

  return v_message_id;
end;
$$;

-- Grants unchanged from the original definition (this create-or-replace
-- keeps the same signature-compatible overload since every new param
-- has a default -- no drop/overload-cleanup needed).
revoke all on function public.sales_generate_outreach_message(uuid, text, text, text, text, text, jsonb, uuid, text, text, jsonb, int) from public, anon;
grant execute on function public.sales_generate_outreach_message(uuid, text, text, text, text, text, jsonb, uuid, text, text, jsonb, int) to authenticated, service_role;

-- Seed the default provider config for ai_offer_generator so a fresh
-- configure (attaching a Groq vault secret) picks up the right
-- provider/model without requiring the operator to hand-author the
-- config JSON. Idempotent -- only touches rows that don't already have
-- a 'provider' key set, so an operator's existing choice is never
-- silently overwritten.
update public.sales_provider_configs
set config = config || jsonb_build_object('provider', 'groq', 'model', 'openai/gpt-oss-120b')
where provider_key = 'ai_offer_generator'
  and not (config ? 'provider');
