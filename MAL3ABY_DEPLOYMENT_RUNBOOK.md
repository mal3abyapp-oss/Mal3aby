# Mal3aby — Production Deployment Runbook (Cloudflare-only)

**Status: FRONTEND LIVE IN PRODUCTION. WHATSAPP CONTAINER PENDING ONE MANUAL STEP.** Cloudflare Workers Paid is active, `mal3aby.app` is bound and serving real traffic over HTTPS. Every step below that does not require Docker (or a `CLOUDFLARE_API_TOKEN` GitHub Actions secret to substitute for it) has been completed and live-verified. See [MAL3ABY_CLOUDFLARE_PRODUCTION_ARCHITECTURE.md](MAL3ABY_CLOUDFLARE_PRODUCTION_ARCHITECTURE.md) for the full architecture and [MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md](MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md) for exactly what has and hasn't been empirically proven about the WhatsApp Container. This runbook supersedes all prior VPS/PM2/systemd guidance — Mal3aby's target deployment platform is Cloudflare + Supabase only, no traditional host.

Last updated: 2026-08-18

---

## Architecture recap

Two independently-deployed Cloudflare projects, plus Supabase (unchanged, already hosted by Supabase itself):

1. **`cloudflare/frontend-worker`** — Cloudflare Workers Static Assets, serving the repo root's own `npm run build` output. Pure static SPA, no server logic.
2. **`cloudflare/whatsapp-worker`** — a Cloudflare Worker + `WhatsAppAccountObject` Durable Object (one instance per club) orchestrating a Cloudflare Container running the existing `whatsapp-connector` (Baileys) unmodified.

Neither Cloudflare Pages, a VPS, PM2, nor systemd is used anywhere in this architecture. Full rationale in the architecture doc.

---

## 1. Frontend deployment

**Status: DONE, live in production.** `mal3aby.app` and `www.mal3aby.app` are both bound as Custom Domains to `cloudflare/frontend-worker`, deployed via `wrangler deploy`, and externally verified over real HTTPS.

**What's confirmed correct, live:**
- `npm run build` at the repo root produces the `dist/` directory `cloudflare/frontend-worker/wrangler.jsonc` points at (`../../dist`) — no separate build step or duplicated frontend code.
- `cloudflare/frontend-worker/wrangler.jsonc` sets `assets.not_found_handling: "single-page-application"`, which serves `index.html` (200) for any unmatched path. Verified live over real HTTPS on `https://mal3aby.app` against every deep-link route (`/login`, `/app/*`, `/portal/*`, `/qr/:token`, `/verify/:token`) — all correctly SPA-fallback with full security headers.
- `www.mal3aby.app` issues a real `308 Permanent Redirect` to the apex (`src/index.ts`) rather than becoming an independent site.
- HTTPS auto-issued by Cloudflare, no manual certificate step, confirmed valid via a real external `curl` (no `-k`/insecure flag needed).
- `PUBLIC_APP_URL` is set to the real value `https://mal3aby.app` in `cloudflare/whatsapp-worker/wrangler.jsonc`.

Kept `workers_dev: true` explicit — the `workers.dev` URL stays live as a technical fallback, never the customer-facing canonical URL.

## 2. Supabase (unchanged host, Auth URL update still pending)

Already provisioned and live (`gxkrtlvpjwxhcqdisyob`, `eu-central-1`, Postgres 17.6). This does not move — Supabase remains outside Cloudflare compute by design.

Remaining actions:
- **Upgrade off the `free` plan** before any real paid pilot — see `BACKUP_RECOVERY_RUNBOOK.md`. Do not claim "backup ready" while still on free. This is a billing action requiring the human operator; not self-purchased; explicitly not requested in this pass.
- **Auth → URL Configuration must be updated manually by the platform owner**: Site URL → `https://mal3aby.app`, and `https://mal3aby.app/*` added to Redirect URLs. This session has no tool that can write Supabase Auth config (confirmed: no such capability in the Supabase MCP server's tool surface; the dashboard requires an authenticated browser session not available here — a login page with pre-filled credentials was found but neither touched nor submitted, per the standing rule against entering/submitting credentials). Local dev `localhost` redirects should stay as-is; they should just not be the production canonical.
- Migrations: `supabase/migrations/` remains the source of truth, applied via Supabase's own tooling. No change from prior state.
- Transactional email provider for Auth email confirmation: still an unresolved external dependency (no SMTP/email provider credential configured), not added in this pass. Blocks real self-service signup until connected in Supabase Auth settings. Controlled-pilot accounts can be pre-confirmed manually by the platform owner, unaffected by this gap.

## 3. WhatsApp connector deployment (Cloudflare Container)

**Status: Workers Paid ACTIVE, domain bound, one manual step remains before the Container itself can be built.**

Confirmed live via real tooling: `wrangler containers list` now returns an authorized empty-list response (was previously a `401` plan-required error), and the whatsapp-worker's container config continues to resolve cleanly via `wrangler deploy --dry-run --containers-rollout=none`.

**Remaining blocker, narrowed and precise**: every Cloudflare Container build/push path (`wrangler deploy` with a Dockerfile, `wrangler containers build`, `wrangler containers push`) requires a Docker-compatible engine wherever that command runs — confirmed against current Cloudflare documentation, no exception exists. The local dev machine's Docker daemon remains down (re-checked once this session, not retried further). A `.github/workflows/whatsapp-container-build.yml` workflow was built to provide that engine via a GitHub-hosted runner (real Docker, zero local dependency) — GitHub Actions is one of Cloudflare's own two officially-documented external CI/CD providers, a supported path, not an invented workaround, and does not touch VPS/self-hosted infrastructure. It needs exactly one manual step this session cannot perform: create a Cloudflare API token (My Profile → API Tokens → Create Custom Token, scoped to this account, Containers:Edit) and add it as the `CLOUDFLARE_API_TOKEN` secret in the GitHub repo's Actions settings. This session's `gh` token lacks the repository-secrets permission needed to do this itself (confirmed via a real `403` from `gh secret list`), and minting a new account-level API token is an account-security action, not something this session should perform even if it had a path to the dashboard.

Once that one secret is added: trigger the workflow (`gh workflow run whatsapp-container-build.yml -f tag=<something>` or via the GitHub UI), which builds and pushes the image, then update `cloudflare/whatsapp-worker/wrangler.jsonc`'s `containers[].image` to the printed `registry.cloudflare.com/...` reference and redeploy the Worker — no Docker needed on this machine at any point in that flow.

**What's already built:**
- `whatsapp-connector/Dockerfile` — multi-stage build, non-root `node` user, no `VOLUME` for the Baileys temp-auth directory (deliberate — Cloudflare Container disk is ephemeral by platform design; session state lives in Supabase, not local disk — see architecture doc §5).
- `whatsapp-connector/src/HealthServer.ts` — the one inbound port (8080) this service opens: `/health`, `/ready`, `/status` (internal-token-gated). Required by Cloudflare Containers for readiness/liveness; harmless no-op on any other host.
- `cloudflare/whatsapp-worker/` — Worker + `WhatsAppAccountObject` Durable Object orchestrating the container's lifecycle (start, idle-sleep, health polling). See architecture doc §4.

**Steps once Docker and Cloudflare account access exist:**
1. `cd cloudflare/whatsapp-worker && npm install`
2. `npx wrangler login`
3. Set secrets (never in `wrangler.jsonc`):
   ```bash
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   npx wrangler secret put WHATSAPP_SESSION_ENCRYPTION_KEY
   npx wrangler secret put CONTAINER_INTERNAL_TOKEN
   npx wrangler secret put MANAGEMENT_API_TOKEN
   ```
   `WHATSAPP_SESSION_ENCRYPTION_KEY` **must match the value already used in Postgres** for any club with an existing paired session — changing it makes existing encrypted sessions undecryptable (same rule as the prior VPS-era runbook, unchanged by the platform move).
4. Update the non-secret `vars` in `cloudflare/whatsapp-worker/wrangler.jsonc` (`SUPABASE_URL`, `PUBLIC_APP_URL`) for the target environment.
5. `npx wrangler deploy` — this is the step that requires local Docker to build the `whatsapp-connector` image; **not yet performed in this environment**.
6. **Run the full validation checklist in `MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md` §5 against the live deployment** before considering WhatsApp production-ready on Cloudflare — pairing, session restore, container replacement, queue recovery, multi-account isolation, at minimum.
7. Trigger the first account start via `POST /manage/:clubId/start` (Bearer `MANAGEMENT_API_TOKEN`) and confirm via `/manage/:clubId/status`.

**Health checks:** `/health` (liveness) and `/ready` (Supabase reachability) are real HTTP endpoints now, unlike the prior VPS-era runbook's "no health endpoint yet" state — Cloudflare Containers requires a port for readiness, which motivated finally building this.

**Secrets:** confirmed `.env`/`.env.example` pattern unchanged and still git-ignored for local dev; production secrets live exclusively in Cloudflare's own secrets store via `wrangler secret put`, never in a committed file or baked into the Docker image.

## 4. Rollback

**Frontend:** `wrangler deployments list` / `wrangler rollback` — Cloudflare Workers keeps prior deployments and supports an explicit rollback command. Stateless, no DB coupling — always safe and near-instant.

**Supabase migrations:** unchanged — no down-migrations; roll back via a new corrective forward migration, per this project's established discipline (see `supabase/migrations/`).

**WhatsApp Worker / Durable Object:** redeploy a previous `wrangler` version. **Durable Object class names must never be renamed carelessly once production state exists** — a rename changes the DO namespace identity and can orphan existing account lifecycle state. If a schema/binding change is ever needed, use `wrangler`'s migration tags (`new_sqlite_classes`, or `renamed_classes`/`deleted_classes` as appropriate) rather than an implicit rename.

**Container image:** version/tag container images explicitly (e.g. via the image reference in `wrangler.jsonc`'s `containers[]` block, or a registry tag if pushing pre-built images) so it is always known which version is running and rollback is a deploy of the previous tag, not a guess.

**Session recovery after any rollback:** unchanged from the pre-Cloudflare architecture — session state lives in Supabase, not in the container/Worker, so any rollback/redeploy of the Worker, Durable Object, or Container does not require re-pairing WhatsApp as long as `WHATSAPP_SESSION_ENCRYPTION_KEY` stays constant.

---

## 5. Observability

- **Workers Logs** (frontend Worker, whatsapp-worker) — enable via the Cloudflare dashboard or `wrangler.jsonc`'s `observability.enabled` once an account exists; not yet turned on (requires a live deployment to enable).
- **Container logs** — accessible via `wrangler tail` against the deployed Worker, or the dashboard's Container logs view.
- Never log: QR tokens, invoice tokens, JWTs, `SUPABASE_SERVICE_ROLE_KEY`, Baileys auth material, `WHATSAPP_SESSION_ENCRYPTION_KEY`, or message content — `HealthServer.ts`'s `/status` payload was specifically designed to exclude all of these (verified in validation doc §2.4).
- Baseline alerts to configure once deployed (not yet configurable without a live account): container unhealthy for >N minutes, WhatsApp disconnected too long, `notification_queue` backlog growing, repeated send failures.

## 6. Security headers & rate limiting (frontend)

**Security headers: done, locally verified live.** `cloudflare/frontend-worker/src/index.ts` is a minimal Worker fetch handler wrapping `env.ASSETS.fetch()` that injects HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy`, and a CSP scoped to `'self'` plus the real Supabase project origin (`connect-src`, including `wss://` for Supabase Realtime) on every response.

A real bug was caught and fixed during this work: Cloudflare Workers Static Assets serves a matching static file **directly, bypassing the Worker script entirely**, unless `assets.run_worker_first: true` is set — confirmed via Cloudflare's own current documentation and reproduced locally (`wrangler dev` + `curl` showed headers present on the SPA-fallback route but silently absent on `/` and `/favicon.svg` before the fix). `run_worker_first: true` is now set in `wrangler.jsonc`, and a second live verification pass confirmed all six headers present on `/`, a real static asset, and a deep-link route alike.

**Rate limiting: not yet applied.** Best configured via Cloudflare Rate Limiting Rules in the dashboard once a live domain exists, so real traffic patterns (not guesses) inform the threshold for public token-verification routes (`/qr/:token`, `/verify/:token`) — scoped tightly enough not to block real customers scanning a QR code in quick succession from the same network.

## Summary: what is and isn't done

| Item | Status |
|---|---|
| Cloudflare account / `wrangler login` | ✅ Done, authenticated |
| Cloudflare Workers Paid plan | ✅ **ACTIVE**, confirmed live via `wrangler containers list` |
| Production domain + DNS (`mal3aby.app`) | ✅ **DONE**, bound and HTTPS-verified live |
| Frontend Cloudflare config (Workers Static Assets, SPA fallback) | ✅ Done, live in production on `mal3aby.app` |
| Security headers (HSTS/CSP/X-Frame-Options/etc.) | ✅ Done, verified live on all route types, real production domain |
| `PUBLIC_APP_URL` set to real value | ✅ Done (`https://mal3aby.app`) |
| WhatsApp connector Dockerfile + health endpoints | ✅ Done |
| Worker + Durable Object orchestration code | ✅ Done, typechecked, dry-run validated, deployed live (minus Container) |
| Secrets architecture (two-tier internal tokens, `wrangler secret put`) | ✅ Done (design); actual secrets not yet set (no live Container to consume them) |
| GitHub Actions OCI build workflow | ✅ Built, Cloudflare-documented pattern — needs one `CLOUDFLARE_API_TOKEN` secret to activate |
| Rollback plan for all three components | ✅ Done |
| Live container build | ❌ **PENDING** — needs the `CLOUDFLARE_API_TOKEN` GitHub secret (one manual step) or a working local Docker |
| Live Baileys-in-Container networking proof | ❌ **PENDING** — blocked on the container build above |
| Supabase Auth Site URL / Redirect URLs → `mal3aby.app` | ❌ **PENDING EXTERNAL INPUT** — no tool in this environment can write Supabase Auth config |
| Supabase plan upgrade (backups) | ❌ **PENDING EXTERNAL INPUT** — not requested this pass, intentionally |
| Transactional email provider for Auth | ❌ **PENDING EXTERNAL INPUT** — not requested this pass, intentionally |
| Rate limiting / WAF rules | ❌ **NOT YET APPLIED** — best configured now that a live domain exists, not yet done |

**Honest state:** the frontend is genuinely live in production on the real domain. The WhatsApp Container is now blocked by exactly one thing — a Cloudflare API token needing to be created and added as a GitHub Actions secret — not by Workers Paid (active) or the domain (bound) or the architecture (complete and locally validated).
