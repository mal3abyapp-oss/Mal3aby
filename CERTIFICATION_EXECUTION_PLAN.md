# Mal3aby V1 — Commercial Release Certification — Execution Plan

Mission start: 2026-09-04. Mode: full autonomous certification, zero owner checkpoints.

## Ground truth at mission start

- Branch: `main`
- HEAD SHA: `7b773ec55420671c88c8381a50dd8813349a6bf8` ("fix(sales): sales_claim_queued_outreach_message record field name bug (#14)")
- Working tree: clean for all deployable code (`src/`, `supabase/functions/`, `cloudflare/`, `whatsapp-connector/`) — `git diff --stat HEAD -- src/ supabase/functions/ cloudflare/ whatsapp-connector/` is empty.
- Untracked (non-deployed) paths present: `design-assets/mal3aby-visuals/` (marketing source PNGs + AR briefs), `public/images/marketing/` (generated responsive webp/png marketing images), `scripts/generate-marketing-images.mjs` (one-off build-time asset generator, not imported by app code). These are in-progress marketing asset work, not yet wired into any route/component as far as confirmed at plan-write time — treated as out of V1 commercial-readiness critical path unless found otherwise.
- Two stale worktrees exist under `.claude/worktrees/` (`elegant-dhawan-0289b7`, `fervent-kapitsa-327418`) — per mission instruction, treated as unmerged/unofficial, not part of `main`'s certified state.
- Production Supabase project: `gxkrtlvpjwxhcqdisyob` (`mal3abyapp-oss's Project`, eu-central-1, Postgres 17.6.1.155, `ACTIVE_HEALTHY`).
- Production frontend: `https://mal3aby.app` (Cloudflare Worker `mala3by-frontend`), confirmed live HTTP 200, Arabic RTL default (`dir="rtl" lang="ar"`).
- GitHub: `mal3abyapp-oss/Mal3aby`, CI green on every recent push (last 5 runs all `success`), branch protection enabled on `main` (`build-and-test` + `e2e-public` required checks, force-push/deletion blocked, per PRODUCTION_AUDIT_REMEDIATION_2026-09-03.md §10).
- No open PRs.

## Known external integrations

- Supabase (Auth, Postgres, Storage, Edge Functions, RLS) — core platform.
- Resend — transactional email, verified send+receive for `mal3aby.app` per prior session memory (2026-09-04).
- WhatsApp/Baileys connector (`whatsapp-connector/`) — self-hosted session-based connector, Cloudflare Container + Durable Object orchestration (`cloudflare/whatsapp-worker/`). QR pairing bug found and fixed 2026-08-21, PASS across full matrix (see WHATSAPP_QR_PAIRING_FINAL_ACCEPTANCE_REPORT.md).
- Payment gateway skeletons: Stripe/PayPal adapters exist (`PaymentGateway` interface), explicitly NOT connected to live credentials — every call path returns honest `GatewayNotConnectedError`, no real charges possible. Also `PAYMENT_GATEWAY_*` docs at root reference a broader multi-provider matrix — to be re-confirmed against actual code in Phase 9.
- Google Places — Sales Intelligence lead-discovery provider, activated today (2026-09-04) per untracked-until-now migration trail.
- AI Offer Generator — made provider-agnostic/zero-cost-default per 2026-09-04 owner decision (Anthropic paid API NOT approved for V1).

## Governance already read (Phase 0)

- docs/PROJECT_RULES.md — 18 non-negotiable rules (DB is authority, tenant isolation via RLS, no hard deletes on financial data, zero-cost-first, permission-based auth never role-key, SECURITY DEFINER checklist, etc).
- docs/PROJECT_STATE.md — full phase history 0-18, all COMPLETE, extremely detailed per-phase evidence trail through Phase 18 (production deploy). Payment Domain Track (#80-90) COMPLETE 2026-08-17.
- docs/engineering/{EXECUTION_STATE,EVIDENCE_LEDGER,TEST_COVERAGE_MATRIX,RELEASE_CERTIFICATION,DEFECT_REGISTER}.md — earlier audit cycle (2026-08-21), P0/P1 = 0 open, 9 defects (AUD-001..009) all CERTIFIED/closed.
- PRODUCTION_AUDIT_REMEDIATION_2026-09-03.md — most recent full master remediation before today: READY FOR PRODUCTION, independently certified, P0/P1 fully closed and re-verified live, adversarial multi-tenant re-test all PROVEN, full regression clean. Documents 4 real process incidents (parallel-writer stash collision, stale-overload security gap, false-complete PERF-06 claim, stale backup snapshot) — all caught by independent verification and corrected same-session. This is the direct precedent for why this mission enforces independent re-verification strictly.
- FULL_PRODUCT_E2E_PRODUCTION_ACCEPTANCE.md (2026-08-31) — full real cross-module business journey (tenant creation through subscription suspend/reactivate), all SERVER VERIFIED against live production with real RPC calls, one P0 found and fixed (D-E2E-001, invited staff never activated), all sections PASS except 2 ENVIRONMENT-BLOCKED items (email inbox read-back, print UI interaction — both disclosed, non-blocking).
- MAL3ABY_CONTROLLED_COMMERCIAL_LAUNCH_FINAL_GO_LIVE_REPORT.md (2026-08-31) — backup CREATED+VERIFIED (checksummed, 112 tables), RESTORE explicitly NOT proven (environment-blocked, honestly disclosed). Zero real customers at that time — all tenants QA fixtures. SOURCE=BUILD=RUNTIME confirmed holding as of that report.
- docs/SECURITY_BASELINE_2026-08-24.md — frozen security guarantees (no direct financial DML on canonical tables, canonical-RPC-only mutation, immutable subscription end_date). Treated as regression baseline, not re-litigated without new evidence.
- WHATSAPP_QR_PAIRING_FINAL_ACCEPTANCE_REPORT.md (2026-08-21) — WhatsApp pairing root-caused and fixed (stale auth dir on `loggedOut`), full matrix PASS live including real QA send.
- MAL3ABY_DEPLOYMENT_RUNBOOK.md (2026-08-18, likely stale re: WhatsApp Container — needs re-check against later WhatsApp acceptance docs which show live QA sends succeeding, implying the Container blocker was resolved after this runbook's date).

## Delta since 2026-08-31/09-03 baselines (this is the real incremental scope for this mission)

Per git log, all work since is Sales Intelligence module build-out (2026-09-01 through today, commits leading to and including `7b773ec`):
- Sales Intelligence & Lead Acquisition module (Platform Owner) — merged PR #3 (`61a3969`).
- Wave 1 campaign report (Egypt Cairo/Giza prospecting) — real prospect email already sent to Elmasry Football Academy earlier today. **DO NOT send another, DO NOT contact CIC Arenas or any other lead, per standing instruction.**
- 10 follow-up fix/feature commits today (PRs #4-#14): Google Places discovery pipeline fixes, quota RPC fix, enrichment UI wiring, lead-profile signals ORDER BY fix, AI offer generator made provider-agnostic, multi-channel outreach readiness (email reply-path, WhatsApp audit, channel eligibility engine), commercial quality gate for AI-generated outreach (hardened against truncation/artifacts/evidence overstatement), platform-owner outreach-send authorization fix, record-field-name bug fix.

**RESOLVED — CLOSED, NOT A DEFECT.** All 13 Sales Intelligence migrations (20260904130000 through 20260904200000) are confirmed FULLY APPLIED LIVE in production via direct read-only SQL ground-truth inspection (function-body content match for every fix marker, table/column existence for every new object, ACL/grant inspection for every service_role fix). Verified by an independent read-only database-reviewer agent running 16 direct SELECT queries against `pg_proc`/`information_schema`/`pg_catalog`/application tables — no CLI, no cache, no wrapper tool.

Root cause of the false-negative signal: `npx supabase migration list` compares local filename timestamps against `supabase_migrations.schema_migrations.version`, but this project has long-documented, pre-existing bookkeeping drift where the history table's `version` column reflects actual wall-clock apply time, not the migration filename's nominal timestamp (same class of drift already disclosed in docs/engineering/EXECUTION_STATE.md: "Historical Supabase migration identifiers remain widely drifted from local filenames. No blanket repair or `db push` was attempted"). 7 of the 13 have no history row at all under any version (fix live, bookkeeping row genuinely missing) but the live objects are 100% correct; the other 6 have history rows whose version numbers just don't match their filenames. Zero of the 13 are NOT APPLIED or PARTIALLY APPLIED. No remediation needed — this is accepted, pre-existing technical debt in migration bookkeeping, not a live production defect. Not repairing the bookkeeping table itself (would require force-reordering migration history — out of scope and risky per the no-destructive-migration-reordering rule).

This closes what could have been a P0 (3 of the 13 are self-documented P0 PRODUCTION-BREAKING FIXES for ambiguous-column bugs) — confirmed the fixes are genuinely live, so the underlying bugs are NOT currently active in production.

## Severity model, phase structure, evidence chain

Per mission instructions verbatim — P0/P1 must be 0 open for CERTIFIED. DISCOVERED → REPRODUCED → ROOT_CAUSE_CONFIRMED → FIXED → QA_VERIFIED → REGRESSION_PASSED → CERTIFIED for every material defect. Independence rule: implementer of a P0/P1 fix never self-certifies it.

## Regression commands (confirmed from package.json / repo convention)

- Typecheck: `npx tsc -b` (build script is `tsc -b && vite build`; `npx tsc --noEmit -p .` is the mission's suggested alternative, equivalent for CI purposes)
- Lint: `npx eslint . --ext ts,tsx`
- Unit/integration tests: `npx vitest run`
- Build: `npm run build`
- E2E: `npx playwright test` (has zero-credential public suite `e2e-public` wired into CI; authenticated suites require QA secrets not present in CI, confirmed skip-only)
- Supabase security advisor: `get_advisors(security)` via MCP

## Regression gate — run fresh at HEAD 7b773ec (2026-09-04, this session)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npx tsc -b` | PASS, exit 0, clean |
| Lint | `npx eslint . --ext ts,tsx` | PASS, 0 errors, 19 warnings (matches documented 2026-09-03 baseline exactly — no new warnings) |
| Unit/integration tests | `npx vitest run` | PASS, 243 passed / 0 failed / 132 skipped (pre-existing, missing QA credentials — documented, consistent with prior baseline) |
| Build | `npm run build` | PASS, main chunk 791.49 kB / 233.07 kB gzip (consistent with 2026-09-03 baseline of 785.83 kB, small expected growth from new Sales Intelligence UI) |

All 4 run directly by the orchestrator in this session, not self-reported by an implementer — satisfies independent re-verification for these gates.

## Next actions

1. ~~Resolve the migration-application contradiction~~ — DONE, see above, closed as not-a-defect.
2. V1 feature inventory — IN PROGRESS (architecture-reviewer delegated).
3. Fresh adversarial security/tenant-isolation spot-check on Sales Intelligence delta + baseline re-confirmation — IN PROGRESS (security-reviewer delegated).
4. Independent Supabase security/performance advisor check — IN PROGRESS (database-reviewer delegated).
5. Once above land: assess whether additional workstreams (integration-reviewer for payment gateways/Resend/WhatsApp, ux-reviewer for RTL/responsive on new Sales UI, resilience-reviewer for failure paths) are needed given the delta, or whether prior baseline evidence already covers them sufficiently.
6. Independent Phase 24 final challenge via release-certifier once findings are reconciled.
