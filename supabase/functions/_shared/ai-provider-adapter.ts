// _shared/ai-provider-adapter.ts -- Sales Intelligence: provider-agnostic
// AI text-generation adapter layer. Introduced 2026-09-04 when the
// owner explicitly declined to enable Anthropic paid billing for
// Mal3aby ("Anthropic paid API usage is NOT approved for Mal3aby at
// this stage... Anthropic may remain implemented as an OPTIONAL
// provider for future use, but Mal3aby must not require it") and
// directed the AI Offer Generator to run on a genuine zero-cost
// provider instead, through a clean adapter so business logic never
// depends on one vendor's request/response shape.
//
// Business logic (sales-ai-offer-generator/index.ts: grounding-prompt
// construction, evidence rules, persistence via
// sales_generate_outreach_message()) is completely unaware of which
// adapter actually ran -- it calls generateSalesOffer(prompt, config)
// and gets back a normalized GenerationResult, regardless of vendor.
//
// Anthropic is kept here, fully working, as an available-but-disabled
// adapter -- never deleted just because billing isn't enabled. Do not
// remove it; a future paid activation should only ever require
// switching sales_provider_configs.ai_offer_generator.config.provider
// back to 'anthropic' and attaching a funded credential, no code change.

export interface GenerationConfig {
  apiKey: string
  model: string
  maxTokens: number
  timeoutMs: number
}

export interface GenerationResult {
  text: string
  provider: string
  model: string
  usage: { input_tokens: number | null; output_tokens: number | null } | null
  latencyMs: number
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly kind: 'timeout' | 'rate_limited' | 'quota_exhausted' | 'auth' | 'upstream_error' | 'empty_response',
  ) {
    super(message)
  }
}

// ============================================================
// Groq adapter (ACTIVE default, 2026-09-04) -- genuine $0 free tier,
// no credit card, no prepaid credits, OpenAI-compatible chat
// completions API. Model: openai/gpt-oss-120b (production-tier, not
// preview -- Groq's Qwen offerings are preview/eval-only as of this
// writing and were deliberately not chosen for that reason). 131K
// context, strong Arabic (MMMLU-Arabic ~75-83% depending on reasoning
// effort per published third-party benchmarks). Free tier limits: 30
// requests/min, 1,000 requests/day, 6,000 tokens/min -- comfortably
// above Mal3aby's actual current Sales Intelligence volume (see
// sales_quota_usage; every provider combined is under 20 requests/day
// as of this writing). See SALES_INTELLIGENCE_PROVIDER_ACCEPTANCE_REPORT.md
// for the full selection rationale and alternatives considered
// (Gemini free tier explicitly excludes commercial use; OpenRouter/
// Cloudflare Workers AI free tiers are explicitly not production-
// intended per their own docs).
// ============================================================
async function generateWithGroq(prompt: string, config: GenerationConfig): Promise<GenerationResult> {
  const started = Date.now()
  let res: Response
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ProviderRequestError('groq request timed out', 'groq', 'timeout')
    }
    throw new ProviderRequestError('groq request failed unexpectedly', 'groq', 'upstream_error')
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderRequestError('groq authentication failed', 'groq', 'auth')
  }
  if (res.status === 429) {
    // Free-tier RPM/RPD exhaustion -- distinct, honest error class per
    // the mission's "fail gracefully with a truthful status... must
    // NOT silently generate a bill" requirement (moot for a $0 tier,
    // but the honesty requirement stands regardless).
    throw new ProviderRequestError('groq free-tier rate/quota limit reached', 'groq', 'quota_exhausted')
  }
  if (!res.ok) {
    throw new ProviderRequestError(`groq request failed: ${res.status}`, 'groq', 'upstream_error')
  }

  const json = await res.json()
  const text = json?.choices?.[0]?.message?.content ?? ''
  if (!text) {
    throw new ProviderRequestError('groq returned no content', 'groq', 'empty_response')
  }

  return {
    text,
    provider: 'groq',
    model: config.model,
    usage: json?.usage
      ? { input_tokens: json.usage.prompt_tokens ?? null, output_tokens: json.usage.completion_tokens ?? null }
      : null,
    latencyMs: Date.now() - started,
  }
}

// ============================================================
// Anthropic adapter (OPTIONAL / DISABLED by default) -- kept fully
// working, never removed. sales_provider_configs.ai_offer_generator
// only routes here when config.provider = 'anthropic' AND a real
// funded credential is attached; Mal3aby's default configuration
// never requires this path.
// ============================================================
async function generateWithAnthropic(prompt: string, config: GenerationConfig): Promise<GenerationResult> {
  const started = Date.now()
  let res: Response
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ProviderRequestError('anthropic request timed out', 'anthropic', 'timeout')
    }
    throw new ProviderRequestError('anthropic request failed unexpectedly', 'anthropic', 'upstream_error')
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderRequestError('anthropic authentication failed', 'anthropic', 'auth')
  }
  if (res.status === 429) {
    throw new ProviderRequestError('anthropic rate/quota limit reached', 'anthropic', 'quota_exhausted')
  }
  if (res.status === 400) {
    // Covers credit_balance_too_low and other request-rejection cases
    // (billing not enabled is surfaced by Anthropic as a 400, not 402/429).
    throw new ProviderRequestError('anthropic rejected the request (billing/credit or request error)', 'anthropic', 'upstream_error')
  }
  if (!res.ok) {
    throw new ProviderRequestError(`anthropic request failed: ${res.status}`, 'anthropic', 'upstream_error')
  }

  const json = await res.json()
  const text = json?.content?.[0]?.text ?? ''
  if (!text) {
    throw new ProviderRequestError('anthropic returned no content', 'anthropic', 'empty_response')
  }

  return {
    text,
    provider: 'anthropic',
    model: config.model,
    usage: json?.usage
      ? { input_tokens: json.usage.input_tokens ?? null, output_tokens: json.usage.output_tokens ?? null }
      : null,
    latencyMs: Date.now() - started,
  }
}

const ADAPTERS: Record<string, (prompt: string, config: GenerationConfig) => Promise<GenerationResult>> = {
  groq: generateWithGroq,
  anthropic: generateWithAnthropic,
}

// generateSalesOffer(): the single entry point business logic calls.
// `providerKey` comes from sales_provider_configs.ai_offer_generator.
// config->>'provider' (defaults to 'groq' if unset, since that is
// Mal3aby's supported default provider) -- never hardcoded by the
// caller, so switching providers is a config change, not a code change.
// Deliberately NO automatic fallback between providers (mission's
// explicit "no automatic paid fallback... no automatic Anthropic
// fallback" requirement) -- a failure here is a real failure the
// caller must handle explicitly, never silently retried on a
// different (possibly paid) provider.
export async function generateSalesOffer(
  prompt: string,
  providerKey: string,
  config: GenerationConfig,
): Promise<GenerationResult> {
  const adapter = ADAPTERS[providerKey]
  if (!adapter) {
    throw new ProviderRequestError(`unknown AI provider: ${providerKey}`, providerKey, 'upstream_error')
  }
  return adapter(prompt, config)
}
