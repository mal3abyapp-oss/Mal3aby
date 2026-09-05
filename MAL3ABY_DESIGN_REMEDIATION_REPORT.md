# Mal3aby Premium UI/UX Remediation — Report

Branch: `design-remediation/premium-ui-ux-audit` (off `main`, baseline HEAD `1712371`, uncommitted).
Mission executed via multi-agent Workflow orchestration (21 agents: 5 parallel audits, serialized implementation across 7 areas, real-browser visual QA, 2 independent adversarial reviewers, a fix-loop, and this synthesis), plus a direct follow-up pass by the orchestrating session to close two P0 gaps the independent review caught that the workflow's own implementation agents had missed.

## What this document is

An honest account of what was found, what was fixed, what was verified how, and what remains open — not a self-certification. Two independent reviewers (fresh agents that did not implement the changes) adversarially checked this work and their findings are included, both the ones fixed and the process the fix went through.

## Seed finding verdicts (from the prior Codex audit)

| # | Finding | Verdict |
|---|---|---|
| 3 | Landing page exposes legacy 499 EGP pricing | **CONFIRMED** (code-level — HomePage.tsx's own embedded pricing block had no legacy filter; fixed this pass) |
| 4 | Pricing page exposes new packages + 14-day trial | **PARTIALLY CONFIRMED** (packaging/structure correct and live-verified clean; trial length is actually 7 days platform-wide, not 14 — see Owner Decision #1) |
| 5 | Club subscription page exposes legacy and new packages together | **CONFIRMED** — and this was the mission's single most severe finding (F4/D1): live DB query confirmed legacy 499/4,499 rendering commingled with, and ordered ahead of, the real tiers on the authenticated billing page. **Fixed this pass.** |
| 6 | Renewal WhatsApp number differs from platform's published number | **CONFIRMED** — `SubscriptionPage.tsx` hardcoded `wa.me/201000000000`; fixed to use the same dynamic `get_platform_contact()` source as the rest of the app. |
| 7 | Custom administrator role → empty Today dashboard | **CONFIRMED** — root cause: `TodayPage.tsx` gated all content on `roleKey` string equality, ignoring `permissionKeys` entirely. **Fixed** with a permission-key-derived rewrite mirroring the already-correct `navigation.ts` pattern. |
| 8 | Dashboard relies on a limited set of built-in role names | **CONFIRMED** — found a second, independent occurrence of the exact same bug class in `AcademyPage.tsx` (`roleKey === 'coach'` routing). **Fixed this pass** after the workflow's own implementation missed it. |
| 9 | Shared Card/status color theme-token inconsistency | **CONFIRMED** — `tailwind.config.ts` hardcoded status hex literals instead of referencing `index.css`'s CSS variables (two independent sources of truth). Fixed: `tailwind.config.ts` now resolves from the same variables. |
| 10 | Status colors too light for small text | **CONFIRMED** — computed WCAG contrast: all 5 status tokens failed 4.5:1 AA as text (2.35–3.76:1). Fixed: darkened within the same hue family, with an automated contrast-regression test added. |
| 11 | Academy mobile tables rely excessively on horizontal scrolling | **CONFIRMED** — the shared `DataTable` had a single scroll-only render path. Fixed: added an opt-in `variant="cards-on-mobile"` mode, adopted by Academy's 3 list screens plus 3 Platform Owner tables. |
| 12 | Booking mobile UX may be a useful reference pattern | **CONFIRMED** — `BookingsMobileView.tsx` is a genuine, dedicated mobile-first implementation (not a squeezed desktop grid), explicitly documented as such in its own 2026-08-23 rewrite. Preserved untouched as the benchmark it is. |
| 13 | Platform Owner surfaces not fully live-tested | **NOT REPRODUCED / NOT RE-VERIFIED** — no authenticated platform-owner credentials were available this session; changes made are code-reviewed and gate-verified only. See Owner Decision #2. |

## New findings beyond the seed list (the audit's real value-add)

- **F4/D1 (P0, most severe of the mission)**: `SubscriptionPage.tsx` — legacy 499/4,499 EGP plans live-leaking to real customers, ranked first by price. Confirmed via direct production database query. **Fixed** (shared `filterPublicCommercialPlans()` helper, `src/lib/domain/billing.ts`, now used by `SubscriptionPage.tsx`, `PricingPage.tsx`, and `HomePage.tsx`).
- **D2 (P0)**: `HomePage.tsx`'s own embedded landing-page pricing preview had the identical unfiltered query as F4. **Fixed** in the same pass, same shared helper.
- **F2/P0-2 (P0)**: `AcademyPage.tsx` had the identical custom-role-misrouting defect as the Today dashboard (`roleKey === 'coach'` gate). **Fixed.**
- **D4 (P1, unresolved by design — real business question)**: platform-wide trial length is 7 days in live config and consistently in copy, contradicting the 14-day figure in the just-merged commercial packaging doc and sales deck. See [FINAL_OWNER_DECISIONS_REQUIRED.md](FINAL_OWNER_DECISIONS_REQUIRED.md#1-trial-length-7-days-live-vs-14-days-documented--real-conflict-not-yet-resolved).
- **P1-1/P1-2**: two more component-internal `roleKey`-array allowlists found (`EnrollmentSection.tsx`'s manual-activation gate, `QuickActionsPalette.tsx`'s quick-actions list) — same root cause as F1/F2 but lower severity (a missed convenience action, not an empty core screen). Documented, not fixed in this pass — flagged as a natural follow-up since the permission-derivation pattern is now established in three places.
- **RTL-A11Y-01/02/03**: status-color contrast, touch-target sizing, and token-duplication issues — all fixed with regression tests added.
- **B1**: 6 hardcoded hex colors on the landing page, duplicating the accent token family — consolidated into named tokens (`accent-emphasis/light/dark`).

## What was implemented (by area)

- **Today dashboard & Academy routing** — permission-key-derived visibility, replacing role-name string matching; both built-in-role behavior preservation and custom-role correctness now unit-tested.
- **Commercial pricing integrity** — shared legacy-plan filter now enforced on all three commercial surfaces (Pricing page, Subscription page, Home page), with regression tests asserting 499/4,499 never resolve and all 6 real tier prices do.
- **WhatsApp contact centralization** — `SubscriptionPage.tsx`'s hardcoded number replaced with the same dynamic `platform_settings` source used elsewhere.
- **Design tokens** — status-color contrast fixed (WCAG AA, tested), token duplication between `tailwind.config.ts`/`index.css` closed, 6 hardcoded hex literals consolidated into tokens, a false "clears 4.5:1" doc/code claim corrected after an independent reviewer caught it live (see below).
- **Mobile responsiveness** — `DataTable` gained an opt-in stacked-card mode for narrow viewports, adopted on Academy's 3 tables and 3 Platform Owner tables; touch targets on Academy's quick-action button increased to the 44×44px minimum.
- **Navigation & dashboards** — added distinguishing `aria-label`s to sidebar/mobile-nav landmarks, a visual grouping divider; a real dev-server-breaking CSS comment bug (`*/` inside prose) was found and fixed as a side effect of live-verifying this area.
- **Customer Portal** — replaced bare loading/error/empty text across 6 portal pages with the app's existing shared `Skeleton`/`ErrorState`/`EmptyState` components (previously unused there at all), giving the portal its own visual identity instead of reading as a repurposed admin panel.
- **Platform Owner** — grouped flat KPI grids into labeled sections (tenant health / commercial signals / needs attention / revenue), adopted mobile card tables on 3 high-column tables. Code-reviewed only, not live-verified (Owner Decision #2).
- **Forms & states** — migrated several pages' hand-rolled loading/empty/error UI to shared components; added `FormLabel` + required-markers to 2 forms found missing them.
- **RTL/microcopy** — fixed one physical-direction Tailwind class leak (`pl-4` → `ps-4`), two Arabic terminology inconsistencies (خطة vs باقة, الفريق vs الموظفون).

## Independent review — what it caught (this is the process working as intended)

Two fresh agents, neither of which implemented any of the above, reviewed the diff adversarially:

1. **Trial-copy regression** (P0): one implementation agent had changed trial-length copy from 14→7 days to match live DB config, without checking it against the just-merged commercial packaging doc. Caught, reverted.
2. **New color-contrast claim was itself wrong** (P1): the design-system fix introduced `--color-accent-emphasis` with a code comment claiming it cleared 4.5:1 AA against both backgrounds it's used on — a live browser check showed it failed against one of them (4.31:1 vs 4.5:1 required). Caught, the token was darkened further and a regression test added so this specific gap (a token used as text with no contrast test) can't recur.
3. **Silent-fallback CTA edge case** (P2): the new dynamic WhatsApp CTA has no fallback UI if the RPC returns empty — documented as a known minor gap, not fixed (low severity, pre-existing risk shape).
4. **Uneven mobile-card rollout** (P3): documented as a known, non-blocking follow-up.
5. **Zero commits on the branch** (P2, process hygiene): correctly flagged — everything was uncommitted working-tree state at review time. Still true; committing is a decision for you (see Owner Decision #4), not something this mission does unilaterally.

**Critically, the same independent-review pass, plus the mission's own honest scorecard synthesis, surfaced that two confirmed P0 findings (F2 Academy routing, F4 legacy-pricing leak) had NOT actually been fixed by the workflow's implementation agents** despite being correctly identified in the audit phase — the implementation agents' own summaries simply omitted them from their file-change lists. This was caught before being reported as complete, and both were fixed directly by the orchestrating session afterward, with dedicated regression tests, following the exact same evidence trail the audit had already established. This is exactly the failure mode independent review exists to catch, and it did.

## Gate results (final, after closing F2/F4)

| Gate | Result |
|---|---|
| `npx tsc -b` | ✅ 0 errors |
| `npx eslint . --ext ts,tsx` | ✅ 0 errors, 20 warnings (19 pre-existing + 1 new, same class as 9 existing: a file exporting both a component and a plain function) |
| `npx vitest run` | ✅ 280 passed, 0 failed, 132 skipped (pre-existing) — 37 more passing than baseline (11 new tests this session: legacy-pricing filter + coach-routing; the remainder were added by workflow implementation agents earlier in the mission) |
| `npm run build` | run in background at report time — see follow-up note if not yet confirmed at delivery |

## Explicitly not done / not verified (do not treat as passed)

- Today/Academy dashboard fixes not confirmed against a real authenticated custom-role browser session (no test credentials available) — unit-tested and independently code-reviewed only.
- Platform Owner changes not live-verified this session (no platform-owner credentials available).
- Booking page's real calendar/slot-picker UI not visually re-verified (only its empty/not-found state was checked; a real seeded club slug would be needed).
- English-locale pricing page not re-verified visually this pass (Arabic was; a prior session's English toggle click didn't register before time ran out).
- Nothing has been committed, merged, or deployed. See Owner Decision #4.

## Scorecard (BEFORE → AFTER, honest, not inflated)

See the full table with per-dimension rationale in the workflow's synthesis output (preserved in the session transcript). Headline: most dimensions moved from the 3–4/10 range (multiple screens effectively broken for a real user population, failing accessibility contrast, commercial-trust-breaking pricing leak) to the 5–7/10 range (systemic fixes with regression tests, but scoped — not a full redesign, and originally two P0s were still open at first synthesis time). After this session's follow-up fixes to F2 and F4, Commercial Credibility and UX Clarity in particular should be re-scored higher than the workflow's own mid-mission snapshot reflects, since both of its blocking caveats are now closed — but that re-score is intentionally left to a fresh independent pass rather than self-assigned here.
