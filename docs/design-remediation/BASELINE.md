# Baseline — Mal3aby Premium UI/UX Remediation Mission

Recorded before any code changes in this mission.

- **Branch created:** `design-remediation/premium-ui-ux-audit` (off `main`)
- **Baseline HEAD:** `1712371eb8857067c5abfa94f703f6e473c71264` — "docs: MAL3ABY V1 commercial packaging final deliverables (#21)"
- **Pre-existing untracked files at session start (NOT part of this mission, do not touch/commit):**
  - `MAL3ABY_SALES_DECK_MASTER_BLUEPRINT.md`
  - `design-assets/`
  - `design-audit-evidence/`
  - `public/images/`
  - `sales-deck-rebuild/`
  - `sales-deck/`
  - `scripts/`

## Baseline gates (all green)

| Gate | Result |
|---|---|
| `tsc -b` (typecheck) | ✅ 0 errors |
| `eslint . --ext ts,tsx` | ✅ 0 errors, 19 pre-existing warnings (react-refresh/only-export-components ×9, react-hooks/exhaustive-deps ×2, no-unused-vars ×3 in supabase edge functions) |
| `vitest run` | ✅ 25 test files passed, 15 skipped (40 total); 243 tests passed, 132 skipped (375 total) |
| `npm run build` | ✅ builds cleanly; pre-existing warning: `index-BJuoPwkp.js` chunk is 796.56 kB (pre-existing bundle-size issue, not introduced by this mission) |

Pre-existing warnings above are **not in scope** to silently fix as part of this mission unless a specific phase's evidence calls for it — recorded here so later gate runs can be diffed against this baseline rather than assumed to be regressions.

## Live production reference (verified 2026-09-05, same day, prior session)
`mal3aby.app` pricing page already serves the correct new commercial model (Starter 1,790/18,000, Growth 2,990/30,000 "الأكثر طلبًا", Pro 4,990/50,000, Enterprise custom) with a single شهري/سنوي toggle driving all three cards. No legacy 499/4,499 found live or in `src/` grep. This is the reference truth for Codex seed finding #3/#4/#5 verification in this mission — expect NOT REPRODUCED unless a different surface (e.g. landing page proper, vs. pricing page) shows otherwise.
