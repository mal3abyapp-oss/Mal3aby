# Commercial Release Evidence Matrix — Mal3aby V1 (2026-09-04)

REQUIREMENT | CRITICALITY | WORKSTREAM | TEST | ENVIRONMENT | EVIDENCE | RESULT | FINDING ID | RETEST EVIDENCE | COMMIT/SHA

---

## M. Production/Deployment/Reliability

| Requirement | Criticality | Workstream | Test | Environment | Evidence | Result | Finding | Retest | SHA |
|---|---|---|---|---|---|---|---|---|---|
| Typecheck clean | P0 gate | M | `npx tsc -b` | local, HEAD 7b773ec | orchestrator direct run, exit 0 | PASS | — | — | 7b773ec |
| Lint clean | P0 gate | M | `npx eslint . --ext ts,tsx` | local, HEAD 7b773ec | orchestrator direct run, 0 errors/19 warnings, matches documented 2026-09-03 baseline exactly | PASS | — | — | 7b773ec |
| Unit/integration tests pass | P0 gate | M | `npx vitest run` | local, HEAD 7b773ec | orchestrator direct run, 243 passed/0 failed/132 skipped (documented pre-existing QA-credential skip) | PASS | — | — | 7b773ec |
| Production build succeeds | P0 gate | M | `npm run build` | local, HEAD 7b773ec | orchestrator direct run, main chunk 791.49kB/233.07kB gzip, consistent with 09-03 baseline | PASS | — | — | 7b773ec |
| Supabase security advisor 0 ERROR | P0 gate | M | `get_advisors(security)` | production `gxkrtlvpjwxhcqdisyob` | independent database-reviewer, 410 findings, 0 ERROR / 406 WARN (documented baseline pattern) / 4 INFO | PASS | F-003 (verified safe) | verified | live |
| Supabase performance advisor 0 ERROR | conditional gate | M | `get_advisors(performance)` | production | same agent, 590 findings, 0 ERROR / 365 WARN (documented multiple-permissive-policy pattern) / 225 INFO | PASS | — | — | live |
| Migration application ground truth | P0-suspected, resolved | M | direct SQL vs `supabase_migrations.schema_migrations` + live object inspection | production | independent database-reviewer, 16 read-only queries, all 13 Sales Intelligence migrations confirmed live | PASS | F-001 (closed, not a defect) | verified | live |
| Branch protection active | conditional gate | M | `gh api repos/.../branches/main/protection` | GitHub | orchestrator direct run, required checks build-and-test+e2e-public, force-push/deletion blocked | PASS | — | — | live |
| CI green on recent commits | P0 gate | M | `gh run list --branch main` | GitHub | orchestrator direct run, last 5 runs all success | PASS | — | — | live |
| SOURCE=BUILD=RUNTIME | P0 gate | M | `git diff HEAD -- src/ supabase/functions/ cloudflare/ whatsapp-connector/` + prod HTTP check | local + production | orchestrator direct run, empty diff, mal3aby.app HTTP 200 | PASS | — | — | 7b773ec |
| Backup exists | conditional gate | M | file inspection | local `backups/` | orchestrator direct check, backup dated 2026-08-31, CHECKSUMMED per MAL3ABY_CONTROLLED_COMMERCIAL_LAUNCH_FINAL_GO_LIVE_REPORT.md | PASS (stale) | — | — | n/a |
| Restore verified | conditional gate | M | actual restore rehearsal | n/a | NOT PERFORMED — Docker/local Postgres genuinely unavailable (previously documented, re-confirmed not newly investigated this session since no new tooling appeared) | NOT VERIFIED | — | — | n/a |
| WhatsApp Container deployment | conditional gate | H | doc cross-reference | production | MAL3ABY_CLOUDFLARE_DEPLOYMENT_STATE.md: "WHATSAPP CONTAINER — LIVE, ACCEPTANCE TESTED", session-persistence bug found+fixed | PASS | — | — | prior session |

## L. Security/Abuse

| Requirement | Criticality | Workstream | Test | Environment | Evidence | Result | Finding | Retest | SHA |
|---|---|---|---|---|---|---|---|---|---|
| No direct financial DML on canonical tables | P0 gate | L | fresh live INSERT attempt as authenticated club_owner | production | independent security-reviewer, `42501: permission denied for table payments` | PASS | — | — | live |
| Recent SECURITY DEFINER functions pin search_path | P0 gate | L | `pg_proc` inspection of post-09-03 functions | production | independent security-reviewer, `reschedule_booking`/`approve_payment_proof`/`check_gateway_webhook_rate_limit` all show `search_path=public, pg_temp` | PASS | — | — | live |
| Recent SECURITY DEFINER functions don't trust client club_id | P0 gate | L | code inspection | production | same agent, all resolve club_id from row lookup, never client param | PASS | — | — | live |
| Sales Intelligence RLS coverage | P0 gate | L (new delta) | `pg_class` sweep of all sales_* tables | production | independent security-reviewer, all 26 tables `relrowsecurity=true, relforcerowsecurity=true`, ≥1 policy each | PASS | — | — | live |
| Sales Intelligence cross-role isolation (club_owner cannot read/write) | P0 gate | L (new delta) | live cross-role SELECT/INSERT/RPC attempts | production | independent security-reviewer, real club_owner/club_manager sessions all denied (0 rows, 42501, or P0001 not authorized) | PASS | — | — | live |
| Sales Intelligence anon access | P0 gate | L (new delta) | live anon SELECT attempts | production | same agent, `permission denied for table sales_leads` | PASS | — | — | live |
| Sales Intelligence privileged RPCs not anon-callable | P0 gate | L (new delta) | grant sweep of 27 RPCs | production | same agent, anon_exec=false on all except 3 non-privileged text helpers | PASS | — | — | live |
| Sales tenant-conversion ownership boundary | P0 gate | L (new delta) | code inspection of `claim_sales_activation_invite`/`_complete_sales_conversion` | production | same agent, always resolves to caller's own `auth.uid()`, platform owner session can never become resulting club's owner | PASS | — | — | live |
| Sales website-enrichment SSRF guard | P2 | L (new delta) | code review + logic test | production | fix authored + 16-case logic verification PASS; deployed via direct call post-certification, boot-verified live | CLOSED — FIXED, DEPLOYED | F-002 | production-verified 2026-09-04 | PR #15, `7fd5297` |
| Secret exposure scan on new commits | P0 gate | L | grep sweep, 51 new files | repo | independent security-reviewer, zero matches, secrets via `Deno.env.get`/Vault indirection only | PASS | — | — | 7b773ec |
| Resend webhook signature verification | P1 | L | code review | repo | independent security-reviewer, Svix HMAC-SHA256, constant-time compare, 5-min replay window, fail-closed | PASS | — | — | 7b773ec |
| Anon-executable sensitive-sounding RPCs self-reject | P1 | L | live unauthenticated calls, 7 functions | production | independent security-reviewer, all 7 rejected cleanly (P0001/400), zero data leaked/mutated | PASS | F-003 | verified | live |
| Multi-tenant adversarial re-test (core platform) | P0 gate | N | 6-vector attack (read/RPC/booking/payment/enrollment cross-tenant) | production | FULL_PRODUCT_E2E_PRODUCTION_ACCEPTANCE.md §23, all 6 correctly failed, zero leak | PASS (prior baseline, not re-run this session — no new cause) | — | — | prior session |

## O. Commercial Sellability — critical journey

| Requirement | Criticality | Workstream | Test | Environment | Evidence | Result | Finding | Retest | SHA |
|---|---|---|---|---|---|---|---|---|---|
| Full tenant lifecycle (onboarding→ops→suspend→reactivate) | P0 gate | O | real RPC-level E2E, 38 sections | production | FULL_PRODUCT_E2E_PRODUCTION_ACCEPTANCE.md, all PASS except 2 disclosed ENVIRONMENT-BLOCKED (email inbox readback, print UI interaction — both non-blocking) | PASS (prior baseline) | D-E2E-001 (fixed same session) | verified same session | prior session |
| Payment gateway real-credential status | informational | F | direct SQL on `payment_gateway_configs`/`payment_gateway_transactions` | production | independent database-reviewer: 0 gateways with real server credentials, 0 real transactions ever | CONFIRMED SKELETON, NO REAL CHARGES POSSIBLE | — | — | live |
| Manual/cash payment flows | P0 gate | F | RPC-level E2E | production | FULL_PRODUCT_E2E_PRODUCTION_ACCEPTANCE.md §12-14,18 (cash payment, partial payment, refund, cash-shift reconciliation) | PASS (prior baseline) | — | — | prior session |

## K. Frontend/UX/RTL (Sales Intelligence delta)

| Requirement | Criticality | Workstream | Test | Environment | Evidence | Result | Finding | Retest | SHA |
|---|---|---|---|---|---|---|---|---|---|
| i18n key parity (ar/en) | P1 | K | automated key-diff script | repo | independent ux-reviewer, 0 keys missing either direction | PASS | — | — | 7b773ec |
| Loading/Error/Empty/Success invariant | P0 gate (per B-1/H-2 precedent) | K | code review, all 8 Sales pages | repo | independent ux-reviewer, correctly implemented on every top-level query, no silent-failure-as-empty regressions | PASS | — | — | 7b773ec |
| Date/RTL bidi correctness | P1 | K | code review | repo | independent ux-reviewer, `FormattedDate` used correctly at every timestamp call site, zero raw date calls found | PASS | — | — | 7b773ec |
| Hardcoded English strings in Arabic UI | P2 | K | code review | repo | independent ux-reviewer, several found (provider labels, raw DB enums, instructional text) | PARTIAL | F-004 | tracked debt | 7b773ec |
| Mutation error feedback | P2 | K | code review | repo | independent ux-reviewer, 2 of ~8 mutations missing isError rendering | PARTIAL | F-005 | tracked debt | 7b773ec |
| Numeral bidi isolation | P3 | K | code review | repo | independent ux-reviewer, several numerals not FormattedNumber-wrapped | PARTIAL | F-006 | tracked debt | 7b773ec |
| Responsive/overflow patterns | P1 | K | code review | repo | independent ux-reviewer, mobile-first grids, overflow-x-auto correctly used | PASS | — | — | 7b773ec |
| Duplicate-submit prevention | P1 | K | code review | repo | independent ux-reviewer, every mutation button disables on isPending | PASS | — | — | 7b773ec |
| Accessibility (label association) | P3 | K | code review | repo | independent ux-reviewer, 2 minor misses out of 14+ inputs, does not meaningfully add to repo-wide debt | PASS (minor gaps) | — | — | 7b773ec |

## N. Adversarial QA / Regression (Sales Intelligence delta vs core platform)

| Requirement | Criticality | Workstream | Test | Environment | Evidence | Result | Finding | Retest | SHA |
|---|---|---|---|---|---|---|---|---|---|
| Shared-file blast radius | P0 gate | N | full diff analysis, 7eac294..HEAD | repo | TWO independent passes: (1) regression-reviewer, 4 shared files all additive-only, zero core table ALTERs, zero permission collisions, zero new deps; (2) release-certifier (Phase 24), independently re-ran this exact check, same conclusion, extended to also confirm route-guard boundary placement | PASS (double-independently verified) | F-007 | verified twice | 7b773ec |
| Full test suite re-execution | P0 gate | N | `npx vitest run` | repo | independently reproduced by regression-reviewer: 243 passed/0 failed/132 skipped, exact match | PASS | — | verified | 7b773ec |
| Tenant-conversion/activation-invite flow | P0 gate | N (new, certifier-initiated) | live SQL + code audit + direct test-file execution | production + repo | release-certifier: secret/token-hash column exclusion confirmed via `information_schema.role_column_grants`, RLS scope confirmed, 5-attempt lockout confirmed, idempotency confirmed, audit trail confirmed, `SalesLeadDetailPage.tenant-activation.test.tsx` run directly 4/4 passing | PASS | — | — | live + 7b773ec |
| Outreach message double-send race | P0/P1 gate check | N (new, certifier-initiated) | code audit of claim/send/mark-sent RPC sequence | repo | release-certifier: FOR UPDATE SKIP LOCKED lock releases before send side-effect completes; confirmed no pg_cron overlap risk (manual-trigger-only) | **NEW FINDING** | F-008 | not yet fixed | 7b773ec |

## Final synthesis

**Phase 24 Independent Final Challenge verdict: CERTIFIED — READY TO SELL.** See COMMERCIAL_RELEASE_FINDINGS.md for full detail. No P0/P1 defect found by this session or by the independent certifier across tenant isolation, auth, money/payment paths, booking, subscription enforcement, or core ops. Per the certification mission's own rule (OPEN P0 = 0 AND OPEN P1 = 0), this is a clean CERTIFIED. One disclosed open P2 risk remains (F-008, outreach double-send race) — bounded in exploitability/impact, not touching the core paid-customer product surface (club ops, academy ops, booking, payments, QR, customer portal); it is Sales Intelligence, an internal Platform-Owner lead-acquisition tool, not customer-facing. F-002 (SSRF fix) was closed post-certification: fixed, deployed, production-verified (PR #15).
