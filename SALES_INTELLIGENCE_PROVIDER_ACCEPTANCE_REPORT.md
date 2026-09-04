# Sales Intelligence — Provider Activation + 3-Lead End-to-End Acceptance Report

**Date**: 2026-09-04
**Scope**: Google Places discovery, Website Enrichment, AI Offer Generator activation (zero-cost provider); 3 real Wave 1 leads run through the full pipeline; regression, security, quota, CRM/dashboard preservation.
**Explicitly out of scope**: Wave 2 discovery, sending outreach, approving generated outreach.
**Owner cost policy**: Anthropic paid API usage NOT approved for Mal3aby. No paid AI billing was enabled at any point in this mission. AI cost = **$0**.

---

## 1. Governed integration into `main`

Three PRs, each opened, CI-verified, and squash-merged through the repository's normal governance — no direct pushes to `main`, no skipped checks.

| PR | Title | CI | Merge commit |
|---|---|---|---|
| [#4](https://github.com/mal3abyapp-oss/Mal3aby/pull/4) | `sales_claim_discovery_job()` ambiguous-column fix + `sales_upsert_discovered_lead()`/`sales_find_duplicate_candidates()` service_role auth fix | `build-and-test` ✅, `e2e-public` ✅ | `d0ad50e` |
| [#5](https://github.com/mal3abyapp-oss/Mal3aby/pull/5) | `sales_record_signal()`/`sales_change_lead_status()` service_role auth fix (same defect class, different broken check) | `build-and-test` ✅, `e2e-public` ✅ | `a4d9528` |
| [#6](https://github.com/mal3abyapp-oss/Mal3aby/pull/6) | AI Offer Generator made provider-agnostic; Groq (zero-cost) wired as active default; Anthropic kept as optional/disabled | `build-and-test` ✅, `e2e-public` ✅ | `7c81cda` |

**Final `main` HEAD**: `7c81cda72bbda4c70878c7c74a4b6cc7fcb315cd`
**Working tree**: clean (no uncommitted Sales Intelligence changes)

No separate deploy step was required beyond the two Edge Function redeploys performed as part of this work (`sales-ai-offer-generator` + the new `_shared/ai-provider-adapter.ts`) — both already live and verified against production before and after each merge. Database migrations were applied directly to the live Supabase project and are the durable, reproducible record.

### Root-cause pattern found and closed across #4/#5 (3 functions)

All three broken functions shared one root cause: `sales-google-places-discovery`/`sales-website-enrichment` deliberately call certain RPCs via a `service_role` admin client, but those RPCs' authorization checks couldn't recognize a `service_role` caller correctly — either `is_platform_owner()` with no `auth.uid()` fallback (`sales_upsert_discovered_lead`, `sales_find_duplicate_candidates`), or a `current_user <> 'service_role'` bypass that cannot work inside a `SECURITY DEFINER` function (`sales_record_signal`, `sales_change_lead_status` — proven empirically that `current_user`/`session_user` inside such a function always reflect the function's *owner*, never the caller). Fixed uniformly with `auth.uid() is null` as the service-role discriminator, safe because grants on every affected function are `authenticated` + `service_role` only.

---

## 2. Google Places discovery — VERIFIED

Real end-to-end against the live Google Places API (New), dedicated GCP project, key restricted to Places API (New) only, stored in Vault, never client-reachable (`get_vault_secret_service` confirmed `service_role`-only).

| Before fix | After both fixes |
|---|---|
| discovered 20, new 0, duplicates 0, **failed 20** | discovered 20, new 19, duplicates 1, **failed 0** |

**Known finding (documented, not fixed — out of this mission's scope)**: `sales-google-places-discovery/index.ts` accepts a `job_id` parameter to resume a specific paginated job, but never actually passes it to `sales_claim_discovery_job()`, which always claims the globally-oldest `pending`/`retryable` job regardless. Confirmed by code inspection and live reproduction. Does not corrupt data (dedup still protects against false duplicates) but should be fixed before relying on multi-page discovery or concurrent operators.

---

## 3. Website Enrichment — VERIFIED

Real end-to-end against `https://www.blackballsportingclub.com` (no API key needed — plain same-domain HTTP fetch, `sales_provider_configs.website_enrichment.enabled = true` by design). Result: 5 pages scanned, 11 signals recorded (5 unique active after correct signal-key deduplication), 10 social links found — every signal carries a real `source_url` and `confidence`.

---

## 4. AI Offer Generator — VERIFIED THROUGH REAL FREE PROVIDER

### Provider selected: **Groq**, model **`openai/gpt-oss-120b`**

**Why selected**:
- **$0 current inference cost** — genuine free tier, no credit card, no prepaid credits, no mandatory subscription (confirmed by direct account inspection: Groq console shows no billing/credits UI gating key creation, unlike Anthropic's Evaluation-access + $0 credits state)
- **Commercial-use suitability** — no free-tier commercial-use exclusion found (unlike Gemini's free tier, which explicitly excludes commercial/revenue-generating use per its own docs)
- **Production-tier model** — `openai/gpt-oss-120b` is Groq's standard production model, not a preview/eval-only offering (Groq's Qwen models were deliberately not selected for this reason — preview/eval-only as of this writing)
- **Arabic quality** — ~75-83% MMMLU-Arabic (varying by reasoning effort) per published third-party benchmarks, competitive with proprietary models; verified further by direct manual review of real generated Arabic output (§4c below)
- **Reliability/rate limits** — 30 req/min, 1,000 req/day free tier, comfortably above Mal3aby's actual current combined Sales Intelligence volume (7-16 requests/day across all 3 providers as of this report)
- **Structured-output capability** — OpenAI-compatible chat completions API, supports `response_format` JSON mode/schema
- **Integration simplicity** — near drop-in `fetch()` replacement for the prior Anthropic call shape
- **Security** — standard `Authorization: Bearer` header auth, same Vault-secret pattern as every other provider in this codebase
- **Future migration flexibility** — Anthropic kept fully working as an available-but-disabled adapter; re-enabling it later is a one-line config change (`sales_provider_configs.ai_offer_generator.config.provider = 'anthropic'`) plus a funded credential, no code change

**Alternatives researched and rejected**:
- **Google Gemini** — free tier explicitly excludes commercial use per Google's own terms; disqualifying for a commercial SaaS
- **OpenRouter free models** — explicitly documented by the provider as "well-suited for exploration... not designed for production workloads"
- **Cloudflare Workers AI** — commercial-use terms not clearly documented; would need direct legal confirmation before commercial reliance

**Free-tier limits**: 30 requests/minute, 1,000 requests/day, 6,000 tokens/minute (model-dependent).
**Known restrictions**: free tier is rate-limited by design; Groq's own docs frame it as suited to development/prototyping rather than heavy production load — acceptable at Mal3aby's current real volume, worth monitoring if discovery/enrichment/offer-generation volume grows materially.
**Fallback behavior**: **none, by design.** No automatic fallback to Anthropic or any paid provider exists anywhere in the code. A Groq failure surfaces as a real, honest error (`FREE_TIER_QUOTA_EXHAUSTED` / `AI_PROVIDER_TIMEOUT` / `AI_PROVIDER_AUTH_FAILED` / `AI_PROVIDER_EMPTY_RESPONSE` / `CONFIGURATION_BLOCKED`) to the caller — never a silent bill.

**Anthropic status**: `OPTIONAL / DISABLED — OWNER DECLINED PAID API CREDITS`. Fully implemented in `_shared/ai-provider-adapter.ts`, correctly recognized as available (not a system failure) in the Sales Settings UI, never called by default.

### 4a. Architecture (Phase 1-4)

No prior provider abstraction existed — `sales-ai-offer-generator/index.ts` called `api.anthropic.com` directly and inline. Introduced `supabase/functions/_shared/ai-provider-adapter.ts`: a single `generateSalesOffer(prompt, providerKey, config)` entry point returning a normalized `{text, provider, model, usage, latencyMs}` result. Business logic (grounding-prompt construction, evidence rules, persistence via `sales_generate_outreach_message()`) is completely provider-unaware. `sales_provider_configs.ai_offer_generator.config` (a pre-existing `jsonb` column, no schema change needed for this part) now stores `{"provider": "groq", "model": "openai/gpt-oss-120b"}` — switching providers is a config change, not a code change. `sales_outreach_messages` gained `ai_provider`/`ai_model`/`ai_usage`/`ai_latency_ms` columns for full attribution.

### 4b. Configuration (Phase 5) — owner manual technical configuration = 0

Owner actions were limited to the two genuinely unavoidable human-authentication steps: logging into `platform.claude.com` (later superseded by the Groq decision) and `console.groq.com`, and completing Groq's Cloudflare CAPTCHA (which repeatedly failed to complete automatically in this session's browser automation — the owner ultimately created the key manually in the Groq console and provided it directly). Every other step — key restriction decisions, Vault storage, provider config, code, migrations, deployment, testing — was performed autonomously. The Groq key is stored exclusively in Supabase Vault (`sales_ai_offer_generator_groq_api_key`), confirmed metadata-only exposure (`vault.secrets` returns id/name/description/created_at, never the decrypted value), and `get_vault_secret_service` (the only function that can decrypt it) is granted to `service_role` only.

### 4c. Real generation for the 3 selected Wave 1 leads (Phase 8-11)

Same 3 leads as originally selected, no re-selection, all BEFORE/AFTER evidence from §5 preserved unchanged.

| Lead | Message type / language | AI provider | Model | Latency | Tokens (in/out) | Status |
|---|---|---|---|---|---|---|
| Black Ball Sporting Club | offer / en | groq | openai/gpt-oss-120b | 1946ms | 597 / 800 | generated |
| Petrosport Club | intro / ar | groq | openai/gpt-oss-120b | 1202ms | 377 / 421 | generated |
| PadelPod Academy | intro / ar | groq | openai/gpt-oss-120b | 1081ms | 377 / 403 | generated |

All three: real Groq request occurred and returned (`ai_provider`/`ai_model`/`ai_usage`/`ai_latency_ms` all populated from the live API response, not synthesized), correct adapter used (`groq`, matching `sales_provider_configs.ai_offer_generator.config.provider`), grounding payload used (verified below), message persisted via `sales_generate_outreach_message()` with `status = 'generated'`, provider/model recorded on both the message row and the `sales_lead_activities` audit trail, quota incremented (`sales_quota_usage.ai_offer_generator.request_count` 4 → 7 across the 3 real calls).

### 4d. Hallucination/grounding gate (Phase 10) — **PASS, 0 unsupported claims**

Every factual commercial claim in all three generated messages was checked against the exact `grounding` jsonb persisted alongside each message:

- **Black Ball Sporting Club**: "two five-a-side football courts" (VERIFIED — `multi_field_facility` evidence), "4.3-star reputation (609 reviews)" (VERIFIED — `rating`/`review_count`), "phone and email" bookings / "no dedicated online booking widget" (VERIFIED — `phone_only_booking`/`no_online_booking`), "academy/training program" (VERIFIED — `academy_present`), "three distinct contact channels" (VERIFIED — `multiple_contact_channels: 3`), "squash, badminton, and swimming pools" (VERIFIED — quoted directly from the signal's own evidence text). QR-check-in / dynamic pricing / reporting are offered Mal3aby capabilities (SUPPORTED_INFERENCE, correctly framed as "our offer," never claimed as something the lead already has).
- **Petrosport Club**: "16,000-capacity stadium... per a Yellow Pages listing" (VERIFIED — directly cited from the `no_website` signal's own evidence detail and `source_url: yellowpages.com.eg`, not invented — this claim was initially flagged for a closer look during this review and re-verified against the raw grounding payload before being cleared), "no official website" (VERIFIED — `lead.website = null`, `no_website` signal).
- **PadelPod Academy**: "no website" (VERIFIED), "found via a Yellow Pages listing" (VERIFIED — matches `source_url`).

**UNSUPPORTED FACTUAL CLAIMS = 0** across all three. No regeneration was required.

### 4e. Arabic quality gate (Phase 11) — **PASS**

Both Arabic messages (Petrosport, PadelPod) reviewed directly: natural, professional Modern Standard Arabic appropriate for a B2B Egyptian business context, no awkward machine-translation artifacts, no invented claims, restrained (not over-the-top) marketing language, clear structure, and the PadelPod message includes an explicit, appropriately soft CTA ("هل يناسبكم تحديد موعد قصير للحديث عن ذلك؟"). Recommended Mal3aby modules were appropriately generic given the thin evidence available for these two leads (no signals beyond "no website" existed for either) — the model correctly did not overreach into unsupported specifics, consistent with the grounding prompt's explicit instruction to speak "in terms of the general opportunity" when detail is missing.

---

## 5. Three Wave 1 lead acceptance tests (full detail, preserved from initial pass)

Selected from the real, existing **"Egypt Launch — Cairo & Giza Sports Facilities — Wave 1"** campaign (30 leads).

| Lead | Status (before) | Website | Data confidence (before) | Score (before) |
|---|---|---|---|---|
| **Black Ball Sporting Club** (`53900ba5-...`) | contact_ready | https://www.blackballsportingclub.com | medium | 20 (cold) |
| **Petrosport Club** (`407f32ee-...`) | enriched | none | low | 0 (cold) |
| **PadelPod Academy** (`0b269439-...`) | enriched | none | low | 0 (cold) |

### 5a. Google Places matching/enrichment
- **Black Ball Sporting Club**: matched precisely with a targeted query; real Google data attached (rating 4.3, 609 reviews, `last_verified_at` updated). `source_place_id` correctly stayed unset — the merge path never overwrites a lead's authoritative source identity.
- **Petrosport Club** / **PadelPod Academy**: no matching Google Places result found under targeted queries — honest negative results, not bugs.

### 5b. Dedup verification
Black Ball's targeted search also surfaced a second, real Google Places record for the same business with a null `city` field from Google's own response — correctly landed as a `medium`-confidence possible-duplicate (domain match without corroborating name+city match), routed to `sales_possible_duplicates` for human review rather than silently merged. No false duplicate was ever created against Petrosport or PadelPod specifically.

### 5c. Website Enrichment (where applicable)
Only Black Ball has a website; enrichment ran and succeeded (§3). Petrosport and PadelPod have no website — enrichment correctly does not apply and was not run.

### 5d. BEFORE vs AFTER scoring

| Lead | Score before | Band before | Score after | Band after | Driven by |
|---|---|---|---|---|---|
| Black Ball Sporting Club | 20 | cold | **63** | **warm** | Website enrichment signals + real Google rating/review count |
| Petrosport Club | 0 | cold | 0 | cold | No contact channel found — score correctly floored to 0 by design |
| PadelPod Academy | 0 | cold | 0 | cold | Same — no contact channel found |

### 5e. AI-provider offer generation
See §4c-4e — completed for all 3 leads via Groq, 0 unsupported claims, Arabic quality PASS.

---

## 6. CRM / pipeline / dashboard preservation — VERIFIED

Live dashboard (`/platform/sales`) after all activity above: 72 total leads, pipeline funnel intact, score bands correctly reflect Black Ball's new warm score, source breakdown correct (Google Places 42, Public search 30), follow-ups list intact with real Wave 1 entries, lead detail page renders fully (signals with evidence/source URLs, real rating/reviews, score with bilingual explanation, complete activity timeline including the new `message_generated` entries, duplicate-candidate indicator, Convert-to-Tenant section present and intact). No functional console errors on any page visited.

---

## 7. Provider usage / quota verification — VERIFIED

| Provider | Requests today | Daily cap | Status |
|---|---|---|---|
| `google_places` | 13 | 100 | well within cap |
| `website_enrichment` | 3 | 100 | well within cap |
| `ai_offer_generator` | 7 | 100 | well within cap |

Mal3aby's own quota mechanism (independent of and in addition to Groq's own free-tier limit) verified live: artificially set `request_count = daily_cap`, confirmed a clean `429` with truthful counts and no lead corruption, then reset to the correct real value (4 → 7 after the 3 real generations above).

---

## 8. Security verification — VERIFIED

- **Vault secret isolation**: `get_vault_secret_service` — `execute` confirmed `service_role`-only across `anon`/`authenticated`/`service_role`. No client-reachable path can read a decrypted provider credential (Google Places, nor the new Groq key).
- **RLS isolation**: a random non-owner authenticated UUID sees 0 rows on `sales_leads`/`sales_discovery_jobs`.
- **No anonymous invocation**: every Sales Intelligence Edge Function requires a valid `Authorization` header and re-verifies the real user server-side (`callerClient.auth.getUser()`), never trusting a client-side "I'm allowed" assumption.
- **No club_owner provider access**: Sales Intelligence remains platform-owner-scoped throughout (`is_platform_owner()`/`has_platform_permission('platform.sales.*')`); no `club_id` column anywhere in this module's write paths.
- **No secret in git**: the Groq key was read once from the browser DOM/user message, transmitted directly into a single `vault.create_secret()` SQL call, and never echoed, printed, or committed anywhere in this session's output or the repository.
- **Authorization regression re-check**: every fixed function re-verified to still correctly reject an authenticated non-owner with `not authorized`.

---

## 9. Relevant regression — VERIFIED

- `get_lead_full_profile()` (fixed in a prior session) re-verified live — full nested payload returns correctly with no errors.
- `sales_compute_lead_score()` — no service-role caller exists; proactively re-checked for the same defect class as a precaution — clean, no fix needed.
- `sales_claim_queued_outreach_message()` / `sales_mark_outreach_sent()` (outreach-sending path, explicitly out of this mission's scope) — proactively checked for the same auth defect class; both correctly service_role-only with no in-body check at all, matching the correct pattern. **Separately noticed, not fixed**: `sales_claim_queued_outreach_message()`'s `if v_msg.message_id is null` guard references a field name that does not exist on its own `SELECT INTO` record — worth a dedicated look before outreach sending is ever exercised.
- Exhaustive `grep` across every Sales Intelligence migration + cross-reference against every `admin.rpc(...)` call in all 5 Sales Intelligence Edge Functions confirmed no other function uses either broken auth pattern.
- `tsc -b`: **clean**, 0 errors.
- `npm run lint`: **0 errors**, 19 pre-existing unrelated warnings (unchanged from baseline).
- `npx vitest run`: **200 passed / 132 skipped / 0 failed** — identical to the pre-change baseline, confirmed via a direct `git stash` comparison.
- Structural regression suite (`supabase/tests/sales_intelligence_structural_regression.sql`) re-run live: RLS-enabled+forced, zero anon/public grants, pinned `search_path` on every SECURITY DEFINER sales function, **zero stale function overloads** (directly relevant — this session's own `sales_generate_outreach_message()` widening initially created exactly this defect, caught and fixed within the same session before merge).

---

## 10. Final acceptance status

```
MAL3ABY SALES INTELLIGENCE
ZERO-COST AI PROVIDER ACCEPTANCE REPORT

ACTIVE AI PROVIDER   = Groq
MODEL                = openai/gpt-oss-120b
FREE TIER            = yes (30 req/min, 1,000 req/day, 6,000 tok/min)
PAID BILLING ENABLED = NO

GOOGLE PLACES        = VERIFIED
WEBSITE ENRICHMENT   = VERIFIED
AI OFFER GENERATOR   = VERIFIED (real Groq calls, 3/3 leads)

BLACK BALL SPORTING CLUB
  AI OFFER            = GENERATED (email/offer/en)
  GROUNDING           = 6 VERIFIED, 0 UNSUPPORTED
  UNSUPPORTED CLAIMS  = 0

PETROSPORT CLUB
  AI OFFER            = GENERATED (email/intro/ar)
  GROUNDING           = 2 VERIFIED, 0 UNSUPPORTED
  UNSUPPORTED CLAIMS  = 0

PADELPOD ACADEMY
  AI OFFER            = GENERATED (email/intro/ar)
  GROUNDING           = 2 VERIFIED, 0 UNSUPPORTED
  UNSUPPORTED CLAIMS  = 0

AI CALLS             = 3 real generations (+ 4 deliberate failure-path tests, all $0)
AI COST              = $0
OUTREACH GENERATED   = 3 (status: generated)
OUTREACH SENT        = 0

SECURITY             = VERIFIED (vault isolation, RLS, no anon invocation, no secret leak)
TESTS                = 200 passed / 132 skipped / 0 failed
CI                   = 3/3 PRs green (build-and-test + e2e-public)
RUNTIME SHA           = 7c81cda72bbda4c70878c7c74a4b6cc7fcb315cd
WORKING TREE          = clean

BUGS FOUND            = 5 (2 in #4, 2 in #5, 1 self-caught stale-overload in #6 before merge)
BUGS FIXED            = 5

OWNER MANUAL TECHNICAL CONFIGURATION = 0
(owner actions limited to: 2 unavoidable console logins, 1 CAPTCHA that would not
complete via automation, providing the resulting key directly — no code, no SQL,
no Vault operation, no deploy, no PR/merge decision was performed by the owner)

FINAL STATUS =
PROVIDER ACCEPTANCE PASSED
```
