# Safe Release Rollback Procedure — Premium UI/UX Remediation + Trial-Length Change

Covers rollback for the work on `design-remediation/premium-ui-ux-audit` (commits `f7e2ea1`, `d92fe7d`, and the release-hardening pass) if a problem is found after merge/deploy. This intentionally does **not** use `git reset --hard` or any other history-rewriting/destructive command as the recommended path — those discard state and are unsafe once a branch has been pushed, reviewed, or deployed from. Everything below is additive/reversible.

## Layer 1 — Frontend code (if the deployed frontend has a defect)

**Revert the merge commit / PR, then redeploy the previous known-good build.**

1. On `main`, identify the merge commit that introduced this change (`git log --oneline main` — the PR merge commit).
2. Create a revert commit rather than rewriting history:
   ```bash
   git revert -m 1 <merge-commit-sha>
   ```
   This produces a new commit that undoes the change while preserving full history — safe on a shared/protected branch, unlike `reset --hard`.
3. Push the revert commit through the normal PR process (or directly if the established workflow allows a fast revert PR).
4. Redeploy the frontend from the reverted `main` using the same established deploy step (`cd cloudflare/frontend-worker && npx wrangler deploy`) — this redeploys what is now, again, the previous known-good build content.
5. Verify live production matches pre-change behavior (repeat the same Arabic/English/desktop/mobile pricing checks documented in this mission's reports).

**Alternative if a redeploy needs to happen faster than a revert PR can go through review:** Cloudflare Pages/Workers deployments are individually addressable — if the deploy platform retains prior deployment artifacts (check `wrangler deployments list` for the Workers project), the previous known-good deployment can be promoted back to production directly (`wrangler rollback` or equivalent, if supported by the project's Cloudflare plan) without needing the git revert to land first. This restores production immediately; the git revert should still be done afterward so `main` and production stay in sync.

## Layer 2 — Database setting (`platform_settings.default_trial_days`)

This is **independent of the frontend rollback** — reverting the frontend code does not touch this live value, and reverting this value does not require touching any frontend code. Only do this if the 14-day trial length itself is found to be the wrong business decision after the fact (not for a frontend bug — see Layer 1 for that).

1. Confirm the current value and audit history first:
   ```sql
   select default_trial_days, updated_at from public.platform_settings;
   select * from public.audit_logs where action = 'update_platform_settings' order by created_at desc limit 5;
   ```
2. To revert to 7 days (or set any other value), use the same audited RPC path used to set it to 14 — as the platform owner, through the app's Platform Settings UI (`src/features/platform/PlatformSettingsPage.tsx`) if authenticated access is available, or via the same `update_platform_settings(p_default_trial_days)` RPC directly if operating through Supabase tooling. This keeps the audit trail intact (`before`/`after` values recorded in `audit_logs`) rather than a bare, untracked table update.
3. If reverting the live value, also revert the schema-level default via a new forward migration (never edit `20260905150000_default_trial_days_14.sql` after the fact — migrations are immutable history, same principle as Layer 1's use of `revert` instead of history rewriting):
   ```sql
   alter table public.platform_settings alter column default_trial_days set default 7;
   ```
4. If the value is reverted, the 8 i18n trial-length strings and the regression test (`src/lib/i18n/trial-length-consistency.test.ts`) must be updated in the same PR — do not let the live value and the copy/test drift apart again, which is exactly the defect this whole change fixed.

## Layer 3 — Partial rollback (frontend fix was fine, only the trial-length decision changes)

Because Layers 1 and 2 are independent, it's possible to keep the shipped UI/UX fixes (legacy-pricing filter, permission-based dashboards, discount-calculation correctness, etc.) while only reverting the trial-length number specifically — this does not require reverting the whole release, just Layer 2's steps plus a small follow-up commit updating the 8 i18n strings back to whatever length is decided, with the regression test updated to match.

## What NOT to do

- Do not `git reset --hard` any shared branch (`main` or the feature branch, once pushed) — this rewrites history other clones may already have and can silently discard work.
- Do not directly `UPDATE public.platform_settings SET default_trial_days = ...` outside the audited RPC path — this bypasses the `audit_logs` trail this whole change relied on for verification.
- Do not edit an already-applied migration file to "fix" it — always add a new forward migration, exactly as this change itself did (`20260905150000_default_trial_days_14.sql` is additive, it does not touch `20260815140000_phase3b_platform_billing.sql`).
