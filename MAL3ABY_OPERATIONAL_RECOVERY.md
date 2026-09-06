# Mal3aby — Operational Recovery Posture

Written 2026-09-06, Final Sell-Readiness Mission. Consolidates the
Supabase backup/recovery posture and the Cloudflare deployment rollback
posture into one reference. This document does not re-derive facts
already established in the project's own prior recovery documentation —
it points to them and states plainly what is current, what is unconfirmed,
and what the owner should verify directly rather than take on this
document's word.

## Supabase backup / recovery posture

**Authoritative sources, read these for full detail**:
`BACKUP_RECOVERY_PLAN.md`, `BACKUP_RECOVERY_RUNBOOK.md`,
`BACKUP_RUNBOOK.md`, and `INCIDENT_RUNBOOKS.md`'s DATA RESTORE and
POST-RESTORE VERIFICATION runbooks.

### Current factual state (as last directly verified in this repo's own history)

- Supabase organization `bmqsldayximwywutofgi` was confirmed on the
  **Free** plan via `get_organization` (most recently reconfirmed
  2026-09-03, per `BACKUP_RUNBOOK.md`).
- Project `gxkrtlvpjwxhcqdisyob`, Postgres 17.6.1, `ACTIVE_HEALTHY`,
  region `eu-central-1`.
- **This document does not re-verify the plan tier itself** — no
  Supabase MCP calls were made for this sell-readiness documentation
  task, per this mission's own scope (documentation only, no production
  Supabase calls). **The owner should re-confirm the current plan tier
  directly in the Supabase Dashboard (Project Settings → Billing) before
  relying on any statement below**, since plan tier is exactly the kind
  of fact that can change between sessions without this repository's
  documentation being updated to match.

### What this means if the Free plan is still current

Per the existing analysis in `BACKUP_RECOVERY_PLAN.md`: Supabase's Free
tier has no automated daily backups and no Point-in-Time Recovery (PITR)
— both are Pro-tier-and-above features. If the plan has not been
upgraded, **there is still no platform-provided path to restore
production if the database were lost or corrupted.** This was previously
raised as a true stop condition and the owner's explicit, recorded
decision (2026-08-27) was to continue without the upgrade for now, as a
deliberate, informed, accepted risk — not a gap silently worked around.

**This decision should be revisited now that this mission has confirmed
the platform is approaching its first real paying customer.** The
calculus behind accepting the risk while every tenant was a disposable QA
fixture (nothing real to lose) changes materially once real customer
financial records exist. This document does not make the upgrade
decision on the owner's behalf — it flags that the previously-accepted
risk's own justification (no real data yet) is about to stop being true.

### The manual interim mitigation that does exist

`BACKUP_RUNBOOK.md` documents a real, working, no-new-paid-service
mitigation: a manual, operator-run SQL-introspection backup (schema DDL,
functions, constraints, indexes, RLS, grants, and full row data as
`INSERT` statements), using the Supabase MCP's `execute_sql` tool rather
than `pg_dump` (which requires Docker, confirmed unavailable in this
environment). This produces a real, checksummed backup directory under
`backups/<timestamp>/` (gitignored, single point of failure — never
copied off-machine automatically).

**Honest, current limitations of this mitigation, as already documented
in that runbook**:
- It requires a human to remember to run it — there is no automatic
  schedule.
- The FK-dependency-safe restore ordering has been verified by dry-run
  computation against the live schema (a valid topological sort, zero
  cycles, cross-checked by two independent algorithms) but **has never
  been executed end-to-end against a real Postgres restore target** —
  no actual `CREATE TABLE`/`INSERT`/`UPDATE` from any backup has been run
  against any real database. This is a genuine, still-open verification
  gap, not a completed rehearsal.
- `auth.users`/`auth.*` (Supabase Auth identities) can be exported by
  this method but cannot be correctly restored by it — a real restore
  would leave every existing user needing to reset their password via
  Supabase Auth's own normal flow, not lose access to the platform
  outright.
- Storage file contents and Cloudflare Worker secrets are never captured
  by this method, by design — see that runbook's own "what must be
  restored separately" section.

### Recommended action, restated plainly

1. **Confirm the current Supabase plan tier directly in the dashboard**
   — do not assume Free or Pro based on this document or any prior one;
   verify at the moment you need this answer.
2. If still on Free: **upgrade to Pro (minimum, ~$25/mo) before, or
   immediately upon, onboarding the first real paying customer.** This
   alone restores 7-day rolling daily backups. This is a real recurring
   cost and a business decision — this document surfaces it, it does not
   decide it.
3. Once upgraded, **rehearse an actual restore** (Supabase Dashboard →
   Database → Backups → Restore, into a disposable branch or project,
   never over production) before trusting it in a real incident — the
   manual backup method's restore ordering has been computed and
   verified on paper but never executed for real, and Supabase's own
   Pro-tier restore mechanism has not been tested in this project either.
4. Until the plan is upgraded, continue the manual `BACKUP_RUNBOOK.md`
   procedure on some regular human-run cadence, and copy the resulting
   backup directory to at least one independent location (not just this
   machine's disk) after each run.

### RPO / RTO — stated honestly, not asserted as guarantees

- **Today, if still on Free**: RPO and RTO are both undefined/not
  achievable via any automated path — only whatever the manual backup's
  last run captured, restorable only via an unverified procedure.
- **After a Pro-plan upgrade** (per Supabase's own published tiering,
  re-confirm at upgrade time rather than trusting this document's
  numbers as still current): RPO improves to approximately 24 hours with
  daily backups alone, or to a much smaller window with the PITR add-on.
  RTO becomes whatever Supabase's own dashboard-driven restore process
  takes — Supabase does not publish a fixed RTO figure; re-confirm
  against their current documentation at upgrade time.

## Cloudflare deployment rollback posture

**Authoritative sources**: `docs/design-remediation/ROLLBACK_PROCEDURE.md`
(the cache-remediation mission's own rollback learnings) and
`INCIDENT_RUNBOOKS.md`'s DEPLOY and ROLLBACK (frontend) runbooks.

### Confirmed setup

`cloudflare/frontend-worker/wrangler.jsonc` deploys the Vite SPA build
(`../../dist`) as Cloudflare Workers Static Assets, fronted by a minimal
Worker script (`src/index.ts`) whose only job is injecting security
headers and a differentiated `Cache-Control` policy per path:
`/assets/*` (Vite's hashed output) gets `public, max-age=31536000,
immutable`; everything else (`index.html`, `sw.js`, the manifest, the SPA
fallback) gets `no-store` — the fix that closed the "stale HTML after
deploy" defect documented in `FRONTEND_CACHE_UPDATE_STRATEGY.md`. Custom
domains `mal3aby.app` and `www.mal3aby.app` are both bound to this one
Worker (`mala3by-frontend`); `www` issues a 308 redirect to the apex.

### Rollback mechanism — deployment-level (fastest path)

Per both existing rollback documents:

```bash
cd cloudflare/frontend-worker
npx wrangler deployments list      # identify the previous known-good version
npx wrangler rollback [deployment-id]
```

This is **stateless and near-instant** — it has no coupling to the
database, since the frontend is a pure client-side SPA with all real
authorization enforced by Supabase RLS/RPCs, not by anything server-side
in this Worker. After rolling back, verify in a fresh browser session
(cleared service worker + cache) that the console build tag
(`[Mal3aby] build <sha>`) now matches the commit being rolled back to.

### Rollback mechanism — source-level (if a git-history-consistent revert is needed)

Per `ROLLBACK_PROCEDURE.md`: prefer `git revert -m 1 <merge-commit-sha>`
over `git reset --hard` on any shared branch. A revert commit undoes the
change while preserving full history, safe on `main` even after it has
been pushed/reviewed/deployed from. Redeploy from the reverted `main`
using the same established deploy step
(`cd cloudflare/frontend-worker && npx wrangler deploy`).
**`wrangler rollback` and a git revert are independent** — the deployment
rollback restores production immediately; the git revert keeps `main`
and production in sync afterward and should still be done even if the
deployment rollback already fixed the live symptom.

### What NOT to do (repeated from existing project discipline, because it matters)

- Never `git reset --hard` a shared/pushed branch (`main` or a feature
  branch already reviewed/deployed from) — this can silently discard
  work other clones already have.
- Never edit an already-applied Supabase migration file to "fix" it —
  always add a new forward migration (per this project's own established
  practice throughout its migration history).
- A frontend rollback does not undo a database migration that shipped in
  the same release — treat frontend and database rollback as
  independent operations, per `INCIDENT_RUNBOOKS.md`'s explicit note on
  this.

### One-time residue risk, already understood and now closed

`FRONTEND_CACHE_UPDATE_STRATEGY.md` documents a real prior incident where
Cloudflare's edge cache held a stale `index.html` even after a
code-level fix deployed, requiring one manual "Purge Everything" via the
Cloudflare dashboard. The `no-store` policy now in place is confirmed
(per that document) to prevent this specific failure mode from recurring
for `index.html`/`sw.js`/the manifest going forward — `/assets/*` remains
cached long-term by design, which is safe because its filenames are
content-hashed and therefore never reused for different content.

## Summary posture statement

- **Cloudflare rollback**: real, tested, fast (`wrangler rollback`),
  documented in two independent places, and low-risk because the
  frontend carries no server-side state.
- **Supabase backup/recovery**: the manual mitigation is real but
  operator-dependent and has never been restore-tested end-to-end;
  the platform-provided automated path (Pro-tier daily backups/PITR)
  depends entirely on a plan tier this document did not re-verify —
  **confirm it directly before relying on any RPO/RTO number above**,
  and treat the decision to upgrade (or not) as materially more urgent
  now that a real first paying customer is imminent than it was while
  every tenant was a disposable QA fixture.
