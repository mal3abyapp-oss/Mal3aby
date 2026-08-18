# Mal3aby — Production Deployment Runbook (Cloudflare-only)

**Status: TECHNICALLY DEPLOYABLE — EXTERNAL CREDENTIALS REQUIRED.** Every step below that does not require a Cloudflare account, a production domain, or Docker has been prepared and locally validated. See [MAL3ABY_CLOUDFLARE_PRODUCTION_ARCHITECTURE.md](MAL3ABY_CLOUDFLARE_PRODUCTION_ARCHITECTURE.md) for the full architecture and [MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md](MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md) for exactly what has and hasn't been empirically proven about the WhatsApp Container. This runbook supersedes all prior VPS/PM2/systemd guidance — Mal3aby's target deployment platform is Cloudflare + Supabase only, no traditional host.

Last updated: 2026-08-18

---

## Architecture recap

Two independently-deployed Cloudflare projects, plus Supabase (unchanged, already hosted by Supabase itself):

1. **`cloudflare/frontend-worker`** — Cloudflare Workers Static Assets, serving the repo root's own `npm run build` output. Pure static SPA, no server logic.
2. **`cloudflare/whatsapp-worker`** — a Cloudflare Worker + `WhatsAppAccountObject` Durable Object (one instance per club) orchestrating a Cloudflare Container running the existing `whatsapp-connector` (Baileys) unmodified.

Neither Cloudflare Pages, a VPS, PM2, nor systemd is used anywhere in this architecture. Full rationale in the architecture doc.

---

## 1. Frontend deployment

**Prerequisites (external, not yet provided):** a Cloudflare account, and — for a real production domain — DNS ownership of that domain.

**What's already correct and locally verified:**
- `npm run build` at the repo root produces the `dist/` directory `cloudflare/frontend-worker/wrangler.jsonc` points at (`../../dist`) — no separate build step or duplicated frontend code.
- `cloudflare/frontend-worker/wrangler.jsonc` sets `assets.not_found_handling: "single-page-application"`, which serves `index.html` (200) for any unmatched path. Verified live via `wrangler dev` against real deep-link routes (`/qr/:token`, `/verify/:token`, `/app/*`, `/portal/*`) — all correctly SPA-fallback (see validation doc §2.5).
- Static assets serve directly without Worker involvement (verified: `/favicon.svg` → 200, not a fallback).

**Steps once a Cloudflare account exists:**
1. `cd cloudflare/frontend-worker && npm install`
2. From the repo root: `npm run build` (produces `../dist` relative to this folder — actually `dist/` at repo root).
3. `npx wrangler login` (interactive OAuth — cannot be done autonomously; requires the human operator).
4. `npx wrangler deploy` from `cloudflare/frontend-worker` — deploys to `*.workers.dev` first for a smoke test, or directly to a custom domain if one is bound (next step).
5. **Custom domain**: once a real production domain is chosen and its DNS is on Cloudflare, bind it via the dashboard (Workers & Pages → `mala3by-frontend` → Settings → Domains & Routes) or `wrangler deploy --routes <domain>/*`. This repo deliberately does not invent a domain name.
6. Confirm HTTPS is auto-issued (Cloudflare provisions this automatically for any domain on its own DNS/proxy — no manual certificate step).
7. **Set `PUBLIC_APP_URL`** (used by the WhatsApp connector for QR/invoice links sent to real customers) to the real production domain — see §3 below. Never leave this as `localhost` or a LAN IP in production.

## 2. Supabase (unchanged host, updated for the new frontend origin)

Already provisioned and live (`gxkrtlvpjwxhcqdisyob`, `eu-central-1`, Postgres 17.6). This does not move — Supabase remains outside Cloudflare compute by design.

Remaining actions:
- **Upgrade off the `free` plan** before any real paid pilot — see `BACKUP_RECOVERY_RUNBOOK.md`. Do not claim "backup ready" while still on free. This is a billing action requiring the human operator; not self-purchased.
- **Once a production domain exists**, update Supabase Auth → URL Configuration: Site URL and Redirect URLs must point at the real Cloudflare-hosted domain, not `localhost`. Password-reset and email-confirmation redirect links depend on this being correct — a stale `localhost` redirect here silently breaks production auth emails.
- Migrations: `supabase/migrations/` remains the source of truth, applied via Supabase's own tooling. No change from prior state.
- Transactional email provider for Auth email confirmation: still an unresolved external dependency (no SMTP/email provider credential configured). Blocks real self-service signup until connected in Supabase Auth settings. Documented here as an External Dependency per the governing directive — does not block the rest of Cloudflare deployment.

## 3. WhatsApp connector deployment (Cloudflare Container)

**Prerequisites (external, not yet provided):** a Cloudflare account with **Workers Paid** plan (required for Containers — no free tier), and a working local Docker installation to build the container image (`wrangler deploy` currently requires Docker locally; no remote-build path exists yet per Cloudflare's own current tooling). Docker was confirmed unavailable on the development machine used for this work (`docker build` failed to reach the daemon; user confirmed "Docker doesn't work for me") — this blocks the actual image build and live prototype validation, not the code/config, which is complete.

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
| Frontend Cloudflare config (Workers Static Assets, SPA fallback) | ✅ Done, locally verified live |
| WhatsApp connector Dockerfile + health endpoints | ✅ Done |
| Worker + Durable Object orchestration code | ✅ Done, typechecked, dry-run validated |
| Secrets architecture (two-tier internal tokens, `wrangler secret put`) | ✅ Done |
| Rollback plan for all three components | ✅ Done |
| Live container build (Docker) | ❌ **BLOCKED — Docker unavailable in this environment** |
| Live Baileys-in-Container networking proof | ❌ **BLOCKED — requires Docker or Cloudflare account access** |
| Cloudflare account / `wrangler login` | ❌ **PENDING EXTERNAL INPUT** |
| Production domain + DNS | ❌ **PENDING EXTERNAL INPUT** |
| Supabase plan upgrade (backups) | ❌ **PENDING EXTERNAL INPUT** |
| Transactional email provider for Auth | ❌ **PENDING EXTERNAL INPUT** |
| Security headers (HSTS/CSP/X-Frame-Options/etc.) | ✅ Done, locally verified live on all route types |
| Rate limiting / WAF rules | ❌ **NOT YET APPLIED** — best configured against a live domain |

**Honest state:** everything preparable without a Cloudflare account, a domain, or a working local Docker install has been built and locally validated. The remaining gaps are genuinely external or require live infrastructure that does not exist in this development environment.
