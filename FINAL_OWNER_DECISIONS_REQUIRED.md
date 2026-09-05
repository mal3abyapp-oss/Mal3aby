# Final Owner Decisions Required — Mal3aby Premium UI/UX Remediation

Generated 2026-09-05, end of the premium UI/UX remediation mission on branch `design-remediation/premium-ui-ux-audit`.

These are the items this mission could not safely decide on its own — either a genuine business/policy question, or a change large enough to need a deliberate design decision rather than an autonomous one. Everything else executable was completed; see [MAL3ABY_DESIGN_REMEDIATION_REPORT.md](MAL3ABY_DESIGN_REMEDIATION_REPORT.md) for the full account.

## 1. Trial length: 7 days (live) vs. 14 days (documented) — REAL CONFLICT, NOT YET RESOLVED

**The single most important open decision.** Two authoritative sources disagree:

- **Live production config**: `platform_settings.default_trial_days = 7` (last changed 2026-08-19), and every EN/AR i18n string describing the trial consistently says **7 days** (hero badge, final CTA, terms & conditions §2, onboarding success message). This is what actually happens today for every real signup.
- **Committed documentation**: [MAL3ABY_V1_COMMERCIAL_PACKAGING.md](MAL3ABY_V1_COMMERCIAL_PACKAGING.md) (merged the same day, same HEAD `1712371`) states the approved model is "Demo → Onboarding → **14-day** trial → Paid." The sales deck and presenter script also consistently say 14 days.

During this mission, one implementing agent changed a single inconsistent copy string (`pricing.trialFunnelHint`) from "14-day" to "7-day" to match live behavior — an independent adversarial reviewer correctly flagged this as a regression against the just-merged commercial packaging doc, and it was reverted back to 14-day wording. **That revert makes the copy internally consistent with the doc again, but it does NOT resolve the underlying conflict** — the copy now says 14 days while the live database, the RPC, and 4 other i18n strings still say 7. The product is currently self-contradictory on this one fact, just with the contradiction moved rather than closed.

**Also found**: there is no "Demo" step anywhere in the actual shipped code (`/signup` → onboarding wizard → immediate trial start via `mark_club_onboarding_complete()`, no sales-gate, no waiting). The "Demo →" prefix in the packaging doc's stated model does not match the real signup flow either.

**Decision needed from you:**
- (a) Is **14 days** the real, intended policy? If so: run `update_platform_settings(p_default_trial_days: 14)` (the existing audited RPC) to change the live value, then update the 4 remaining "7 days" i18n strings (both locales) to say 14/١٤. This is a live commercial-config change and needs your explicit go-ahead since it affects every future signup's actual entitlement.
- (b) Is **7 days** actually correct, and the packaging doc/sales deck are the ones that are wrong? If so: update `MAL3ABY_V1_COMMERCIAL_PACKAGING.md`, the sales deck, and the presenter script instead, and revert the `trialFunnelHint` copy back toward 7-day framing.
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
