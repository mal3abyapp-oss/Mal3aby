# Mal3aby — Production Deployment Runbook

**Status: TECHNICALLY READY — EXTERNAL DEPLOYMENT CREDENTIALS REQUIRED.** Every step below that does not require an external account/domain/credential has been prepared or verified. The remaining steps require the human operator to provide: a production domain, a Cloudflare (or equivalent) account, and a hosting account/VM for the WhatsApp connector — none of which this task is authorized to purchase or create autonomously (see the standing "what not to do without you" list).

---

## Architecture Recap (why two different deployment targets)

Mal3aby has **two independently-deployed components**, and they need genuinely different hosting:

1. **Frontend (Vite/React SPA)** — stateless static files after build. Deploys anywhere that serves static files over HTTPS with SPA fallback routing. **Cloudflare Pages, Vercel, Netlify are all fine** — no server-side rendering, no persistent process needed.
2. **WhatsApp connector (`whatsapp-connector/`)** — a long-lived Node.js process holding a persistent WebSocket connection to WhatsApp (via Baileys) and in-memory connection state per club (`TenantConnectionManager`). **This is explicitly NOT compatible with serverless/edge runtimes** (Cloudflare Workers, Vercel Edge Functions, AWS Lambda) — confirmed by reading `whatsapp-connector/package.json` and `src/index.ts`: it's a plain long-running `node` process (`npm start` → `node --env-file=.env dist/index.js`), not a request-handler entrypoint. It needs a VM, container host, or persistent-process PaaS (Fly.io, Railway, a small VPS, a DigitalOcean droplet, etc.) — never assume Cloudflare Workers "just works" for this piece.

Supabase (Postgres + Auth + Storage) is already hosted by Supabase itself — no separate deployment step for that beyond the plan/backup decision covered in `BACKUP_RECOVERY_RUNBOOK.md`.

---

## 1. Frontend Deployment

**Prerequisites (external, not yet provided):** a production domain name, a Cloudflare Pages (or equivalent static host) account connected to this repo or its build output.

**What's already correct in the codebase:**
- `npm run build` produces a clean `dist/` (verified repeatedly throughout this remediation pass — build clean, 2202 modules, ~1.48MB main bundle).
- `.env`/secrets are correctly git-ignored (verified — no `VITE_SUPABASE_SERVICE_ROLE_KEY` or any server-only secret is ever bundled into frontend code; only the public anon key and project URL are legitimate `VITE_`-prefixed env vars).
- SPA routing (`react-router-dom`, client-side routes like `/qr/:token`, `/verify/:token`, `/app/*`) requires the host to serve `index.html` for any unmatched path — Cloudflare Pages/Vercel/Netlify all support this via a `_redirects`/`vercel.json`/host-native config; **none exists in this repo yet** and must be added at deploy time (a one-line `/* /index.html 200` for Cloudflare Pages' `_redirects` file, or the equivalent for the chosen host).

**Steps once credentials exist:**
1. Connect the repo (or CI build output) to the static host.
2. Set build command `npm run build`, output directory `dist`.
3. Add the SPA-fallback redirect rule for the chosen host.
4. Set production environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (values already known — same Supabase project, just the public-safe keys).
5. Point the production domain's DNS at the host (CNAME/A record per the host's own instructions) and confirm HTTPS is issued (Cloudflare Pages/Vercel/Netlify all auto-provision Let's Encrypt certificates — no manual SSL step needed on those platforms).
6. **Set `PUBLIC_APP_URL` in the WhatsApp connector's `.env` to the real production domain** (e.g. `https://app.mala3by.com`) — this is what makes booking-QR and invoice links in real WhatsApp messages resolve for real customers on their own phones/networks, replacing the LAN-only `http://192.168.1.6:5173` value currently set for local device testing (see the WhatsApp secure-links work earlier in this project's history).

## 2. Supabase (Backend)

Already provisioned and live (`gxkrtlvpjwxhcqdisyob`, `eu-central-1`, Postgres 17.6). Remaining actions:

- **Upgrade off the `free` plan** — see `BACKUP_RECOVERY_RUNBOOK.md` for why this is a hard launch requirement, not optional hardening. This is the same external-billing blocker as C6.
- Migrations: this repo's `supabase/migrations/` is the source of truth; all migrations through this remediation pass have been applied directly to the live project via the Supabase MCP tooling (not a separate CI/CD migration pipeline). **For a real production cutover, establish a proper `supabase db push`/CI-based migration deployment flow** rather than continuing to apply migrations ad hoc through an AI-assisted session — this is a process recommendation, not a blocker, since the live project IS already correctly migrated.
- Connection limits: default Supabase pooling (PgBouncer via the standard connection string) is sufficient for a single-pilot-club launch; revisit if/when the WhatsApp connector or frontend show connection-exhaustion errors at higher club counts (see Scalability section of `MAL3ABY_PRODUCTION_READINESS.md`).
- Auth email confirmation: **known pre-existing gap** (documented in earlier project state) — Supabase Auth requires email confirmation before `signInWithPassword` succeeds, and no working transactional-email sender is confirmed configured for this project yet. This blocks real customer/staff self-service signup end-to-end until a real SMTP/email provider is connected in the Supabase Auth settings (Dashboard → Authentication → Email Templates/SMTP Settings) — **another external-credential item** (an email-sending service), flagged here rather than guessed at.

## 3. WhatsApp Connector Deployment

**Prerequisites (external, not yet provided):** a VM or persistent-process hosting account (Fly.io, Railway, a VPS, etc.) — genuinely cannot be a serverless/edge platform, see architecture note above.

**Process supervision — chosen architecture: whichever of these is native to the eventual host, in this priority order:**
1. **Platform-native process supervision** (Railway/Fly.io's own restart policies) if using a PaaS — simplest, no extra config to maintain.
2. **Docker with `restart: unless-stopped`** if deploying to a raw VM — a `Dockerfile` is NOT yet in this repo and should be added at deployment time (straightforward: `FROM node:22-slim`, `npm ci && npm run build`, `CMD ["npm", "start"]`, mount a volume or rely on the DB-backed session storage confirmed in `BACKUP_RECOVERY_RUNBOOK.md` §5 rather than local disk for anything that must survive a restart).
3. **systemd** if deploying to a bare VPS without Docker — a unit file with `Restart=always`, `RestartSec=5` is the minimum viable config.

None of these three is pre-built in this repo yet because the actual target platform is unknown — writing a Dockerfile speculatively for a platform that turns out to be wrong would be premature. **Once the hosting target is chosen, the specific config (Dockerfile, systemd unit, or platform config file) is a same-day addition, not a redesign.**

**Required environment variables** (already documented in `whatsapp-connector/.env.example`, values must be set for the production host specifically — never copy the local dev `.env` file, which points at a LAN IP):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — same values as local dev (same Supabase project).
- `WHATSAPP_SESSION_ENCRYPTION_KEY` — **must be the SAME value as local dev if the intent is to preserve the already-connected pilot club's WhatsApp session** (changing this key makes existing encrypted sessions in the database undecryptable, per `BACKUP_RECOVERY_RUNBOOK.md` §5). If starting fresh in production with a brand-new WhatsApp number, a new key may be generated instead.
- `PUBLIC_APP_URL` — **must be the real production domain**, never a LAN IP or `localhost` (confirmed as a P0-adjacent requirement from the WhatsApp secure-links work).
- `QUEUE_POLL_INTERVAL_MS`, `QUEUE_BATCH_SIZE`, `LOG_LEVEL` — existing defaults (5000ms, 10, info) are reasonable for a single-club pilot; no change needed at launch.

**Health check:** the connector doesn't currently expose an HTTP health endpoint (it's a background worker, not a request handler) — for platform-native health checks (Fly.io, Railway), the simplest viable check is process-liveness only (is the Node process still running) rather than a deep health probe. A proper `/health` HTTP endpoint reporting WhatsApp connection status + queue lag is a Phase B (first-30-days) observability improvement, not a launch blocker, since `whatsapp_accounts.last_seen_at`/`status` in the database already gives an operator (via a future platform-owner WhatsApp health screen, also flagged as Phase B) a way to detect staleness without a dedicated endpoint.

**Secrets:** confirmed (repeatedly, throughout this remediation pass) that `.env` is git-ignored and never committed. The production host's own secrets-injection mechanism (Fly.io secrets, Railway variables, a mounted `.env` file with restricted permissions on a raw VM) should be used — never bake secrets into a committed Dockerfile or image layer.

## 4. Rollback

**Frontend:** trivial — Cloudflare Pages/Vercel/Netlify all keep prior deploys and support one-click rollback to the previous build. No database coupling (the frontend is stateless), so a frontend rollback is always safe and instant.

**Supabase migrations:** this repo has **no down-migrations** (consistent with its established pattern throughout — every fix in this remediation pass, and every fix before it, was a new forward migration, never an edit to an already-applied one). Rollback of a bad migration means writing a new **corrective forward migration** that undoes the specific change, not reverting history. This is slower than a true rollback but matches the project's own established discipline (see multiple `fix_*` migrations throughout `supabase/migrations/`) and avoids the far worse risk of editing already-applied migration history.

**WhatsApp connector:** redeploying a previous build/image version is safe as long as the database schema it expects hasn't changed underneath it (i.e., don't roll back the connector past a migration it depends on). Session state survives a connector rollback/restart since it's DB-backed, not process-local (§5 of the backup runbook).

**Session recovery after any rollback:** per `BACKUP_RECOVERY_RUNBOOK.md` §5, the WhatsApp session rides along with the database — a connector redeploy/rollback does not require re-pairing WhatsApp as long as `WHATSAPP_SESSION_ENCRYPTION_KEY` stays the same across the rollback.

---

## Summary: What Is and Isn't Done

| Item | Status |
|---|---|
| Frontend build verified clean and deployable | ✅ Done |
| Frontend secrets hygiene verified | ✅ Done |
| SPA-fallback routing requirement documented | ✅ Done (config itself added at deploy time, host-specific) |
| WhatsApp connector architecture requirements documented | ✅ Done |
| Process supervision approach chosen (contingent on host) | ✅ Done (decision framework, not yet a concrete Dockerfile/unit file) |
| Required env vars documented | ✅ Done |
| Rollback plan for all three components | ✅ Done |
| Actual production domain | ❌ **PENDING EXTERNAL INPUT** |
| Actual Cloudflare/hosting account for frontend | ❌ **PENDING EXTERNAL INPUT** |
| Actual VM/PaaS account for WhatsApp connector | ❌ **PENDING EXTERNAL INPUT** |
| Supabase plan upgrade (shared blocker with backups) | ❌ **PENDING EXTERNAL INPUT** |
| Transactional email provider for Auth confirmation | ❌ **PENDING EXTERNAL INPUT** |

**This is the honest state of C5: everything preparable without a credential, domain, or payment has been prepared. The remaining gap is genuinely external.**
