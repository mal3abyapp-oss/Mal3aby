# Final Owner Decisions Required — Mal3aby Premium UI/UX Remediation

Generated 2026-09-05, end of the premium UI/UX remediation mission on branch `design-remediation/premium-ui-ux-audit`.

These are the items this mission could not safely decide on its own — either a genuine business/policy question, or a change large enough to need a deliberate design decision rather than an autonomous one. Everything else executable was completed; see [MAL3ABY_DESIGN_REMEDIATION_REPORT.md](MAL3ABY_DESIGN_REMEDIATION_REPORT.md) for the full account.

## 1. Trial length: 7 days (live) vs. 14 days (documented) — ✅ RESOLVED 2026-09-05

**Owner decision received: the official trial length is 14 days**, applied platform-wide. What changed:
- `platform_settings.default_trial_days` live-updated 7→14 via the same audited path as `update_platform_settings()` (confirmed in `audit_logs`: before `{7}`, after `{14}`), plus a forward migration (`supabase/migrations/20260905150000_default_trial_days_14.sql`) so the column's own schema-level default also reads 14 for any future direct insert.
- All 8 trial-length i18n strings (4 keys × 2 locales) now consistently say 14/١٤ — verified live in both languages, both `/` and `/pricing`, on both dev-server pages.
- Docs updated to reflect 14 as current (`README.md`, `docs/DESIGN_SYSTEM.md`, `docs/USER_FLOWS.md`, `docs/ARCHITECTURE.md`, `docs/TEST_PLAN.md`, `docs/SCREEN_MAP.md`, `docs/IMPLEMENTATION_PLAN.md`); `docs/DECISIONS.md`'s ADR-037 kept as historical record with an update note appended, not rewritten.
- New regression test (`src/lib/i18n/trial-length-consistency.test.ts`) guards against a future change silently reintroducing "7" in one location while missing another.
- Independently re-verified twice (fresh adversarial reviewers, live DB queries, both live functions' source read directly) — REGRESSION_PASSED both times.

**Still no "Demo" step exists in the shipped code** (`/signup` → onboarding wizard → immediate trial start, no sales-gate) — the packaging doc's "Demo → Onboarding → 14-day trial" framing describes an aspirational funnel shape, not the literal implemented flow. This is unchanged from before and was reported, not silently resolved — the CTA copy itself was previously checked against the real flow and found accurate (self-service, no demo step), so no code changed here. If a real demo-gate step is wanted, that is a product feature to build, not a copy fix.
- (c) Is there really meant to be a demo-gate step before onboarding? If so, that is unimplemented — a real feature gap, not a copy fix, and out of scope for this mission to build without your sign-off.

**No code or config was changed for this decision beyond the copy revert described above.** Nothing was allowed to silently pick a side.

## 2. Platform Owner surfaces — code-reviewed only, not live-verified this session

No authenticated platform-owner test credentials were available in this environment. The Platform Owner improvements made (grouped KPI sections, mobile card-table adoption, section headings) are LOCALLY PROVEN (gates green) but not INDEPENDENTLY VERIFIED against a real authenticated session. Two prior sessions (referenced in project memory) did previously verify Platform Owner via RLS-impersonation and found/fixed 9+ defects — this mission's changes build on top of that but were not re-verified live. **Recommendation**: a quick authenticated pass before treating Platform Owner changes as fully proven, if/when real credentials are available to this environment.

## 3. Today dashboard / Academy fixes — not yet independently confirmed against a live custom-role account

The permission-key-based fixes to `TodayPage.tsx` and `AcademyPage.tsx` were verified by: (a) re-deriving the exact permission sets from `docs/CURRENT_AUTHORIZATION_MODEL.md` and `NAV_DOMAIN_PERMISSIONS`, (b) an independent reviewer checking the diff line-by-line against that same documentation and confirming it preserves all 9 built-in roles' existing behavior, and (c) new unit tests covering the permission-derivation logic directly. What was **not** done: creating a real custom-role test membership and loading the Today/Academy pages as that user in an authenticated browser session (no test credentials were available). If you can provide/seed one, that would move this from LOCALLY PROVEN to INDEPENDENTLY VERIFIED.

## 4. Uncommitted branch — nothing has been merged or deployed

`design-remediation/premium-ui-ux-audit` currently has **zero commits** — every change described in this mission exists only as uncommitted working-tree modifications (32 modified files + this mission's new files). Nothing has been pushed, no PR has been opened, and nothing has been deployed. Per this session's standing rule, merging to `main` and any production deployment require your explicit go-ahead at that specific moment — this document is not that request. When you're ready, the next step is: review the diff, approve committing it, then decide on PR/merge/deploy timing separately.

## 5. Uneven mobile-card rollout (minor, tracked not blocking)

The new `DataTable` `variant="cards-on-mobile"` pattern was adopted on the highest-value tables (Academy, Platform Clubs/Trials/SupportHistory) but not swept across every table in the app (Staff, Finance, etc. still use the classic scroll-only table). This is backward-compatible and not a regression — just an incomplete rollout of a good pattern. Left as a follow-up rather than expanding scope further in this pass.
