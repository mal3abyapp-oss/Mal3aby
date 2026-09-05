# Mal3aby UI/UX Scorecard — Before / After

Honest, non-inflated scores (1–10) from the remediation mission's synthesis pass, updated to reflect the two P0 gaps (F2 Academy routing, F4 legacy-pricing leak) that were closed and independently re-verified *after* the workflow's own first synthesis — the original synthesis correctly refused to score those dimensions higher while they were still open; this final version reflects them now being closed.

| Dimension | Before | After | Why |
|---|---|---|---|
| Brand Identity | 5 | 6 | Hardcoded hex duplicates consolidated into named accent tokens. No broader brand overhaul was in scope. |
| Color System | 4 | 7 | Status-color WCAG failures fixed with regression tests; accent-token drift closed; one new token's own false "passes contrast" claim was caught live and corrected. |
| Typography | 5 | 5 | No typography defects found or changed. |
| Layout | 3 | 7 | Both P0 layout defects (Today dashboard and Academy page rendering effectively broken/misrouted for custom-role and coach-equivalent users) are now fixed and independently verified against live `role_permissions` data. |
| Spacing | 4 | 6 | Touch-target sizing fixed on the Academy quick-action button (28×28px → 44×44px), both table and mobile-card renders. |
| Component Consistency | 4 | 7 | The permission-key-derivation pattern is now applied consistently across navigation, Today dashboard, Academy routing, and Employee360 — closing the 3-different-wrong-patterns problem found at audit time. |
| RTL | 4 | 6 | Contrast fixed with tests; icon mirroring confirmed already correct; one physical-direction class leak fixed; DataTable mobile-card variant reduces scroll dependence. |
| Mobile | 4 | 6 | Cards-on-mobile shipped on Academy (3 tables) + Platform Owner (3 tables); rollout not yet swept to every table (tracked, not blocking). |
| Accessibility | 3 | 6 | Contrast and touch-target fixes are real and test-backed; this was a targeted pass, not a full WCAG audit (no ARIA/screen-reader sweep). |
| UX Clarity | 3 | 7 | Both P0 clarity-breaking defects (empty dashboards, legacy pricing confusion) are now closed. |
| Premium Perception | 3 | 6 | Token hygiene, contrast, dynamic contact info, and closed P0s meaningfully raise the polish floor. |
| Commercial Credibility | 3 | 7 | The legacy-pricing leak — the single most severe trust defect found — is fixed on all 3 commercial surfaces with regression tests. The trial-length inconsistency (7 vs. 14 days) remains a genuine, disclosed open question (see [FINAL_OWNER_DECISIONS_REQUIRED.md](FINAL_OWNER_DECISIONS_REQUIRED.md)), capping this below a higher score. |

**Overall**: from a product with two live, customer-facing P0 defects (broken dashboards for a real user population; a genuine pricing-integrity leak) to one where those are fixed, tested, and independently verified — with the remaining gaps honestly disclosed rather than hidden (trial-length policy conflict, Platform Owner not live-tested, nothing yet committed/merged/deployed).
