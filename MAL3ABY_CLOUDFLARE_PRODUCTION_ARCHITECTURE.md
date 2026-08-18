# Mal3aby — Cloudflare Production Architecture

Status: **DRAFT ARCHITECTURE, PARTIALLY VALIDATED**. See [MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md](MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md) for exactly what has and has not been empirically proven. This document describes the target architecture and what has been built/verified toward it; it is not a claim that the system is deployed or that every component has been observed running live on Cloudflare's network.

Last updated: 2026-08-18

---

## 1. Why this architecture

Constraints set by the owner, non-negotiable:

- Supabase remains the **sole system of record** for all business data — bookings, invoices, payments, customers, academy, subscriptions, notification_queue, audit logs, auth, RLS, RPCs. Nothing here moves that data into D1, Durable Object storage, or R2.
- No VPS, no PM2, no systemd, no long-lived traditional Node host. Everything that isn't Supabase runs on Cloudflare.
- The WhatsApp connector (Node.js + Baileys, a persistent outbound WebSocket + on-disk session cache) is the one component that doesn't obviously fit Cloudflare's request-driven compute model. It must be **proven**, not assumed, before being called production-ready on this platform.

## 2. Component map

```
                                   ┌─────────────────────────────┐
Internet ── HTTPS ──▶ Cloudflare  │  mala3by-frontend (Worker,   │
                       DNS/Edge   │  Static Assets, SPA)          │
                                   └───────────────┬───────────────┘
                                                    │ (browser calls Supabase directly)
                                                    ▼
                                   ┌─────────────────────────────┐
                                   │           Supabase           │
                                   │  Postgres + RLS + RPC + Auth │
                                   │  Storage + notification_queue│
                                   └───────────────┬───────────────┘
                                                    ▲
                                                    │ poll (outbound HTTPS)
                        ┌───────────────────────────┴───────────────────────────┐
                        │        mala3by-whatsapp-worker (Cloudflare Worker)     │
                        │        /health  /manage/:clubId/start                  │
                        │        /manage/:clubId/status                          │
                        │                                                        │
                        │   ┌────────────────────────────────────────────────┐  │
                        │   │ WhatsAppAccountObject (Durable Object)          │  │
                        │   │  — one instance per clubId (platform-guaranteed │  │
                        │   │    single global instance == no split brain)    │  │
                        │   │  — owns container lifecycle only, never touches │  │
                        │   │    the Baileys socket itself                    │  │
                        │   │  — 60s alarm loop polls container /status,      │  │
                        │   │    calls renewActivityTimeout() only while the  │  │
                        │   │    account is connected/reconnecting            │  │
                        │   └──────────────────┬─────────────────────────────┘  │
                        │                       │ containerFetch()               │
                        │                       ▼                                │
                        │   ┌────────────────────────────────────────────────┐  │
                        │   │ Cloudflare Container (Firecracker microVM)      │  │
                        │   │  whatsapp-connector image                       │  │
                        │   │  — unmodified Baileys/queue/session logic       │  │
                        │   │  — HealthServer: /health /ready /status:8080    │  │
                        │   │  — outbound wss:// to WhatsApp (Baileys)  ──────┼──┼──▶ WhatsApp
                        │   │  — outbound HTTPS poll/write to Supabase        │  │
                        │   │  — local disk = pure ephemeral working cache    │  │
                        │   └────────────────────────────────────────────────┘  │
                        └────────────────────────────────────────────────────────┘
```

Two independent Cloudflare projects, deployed separately:

- `cloudflare/frontend-worker` — static SPA, no server logic.
- `cloudflare/whatsapp-worker` — Worker + Durable Object + Container, orchestrates the WhatsApp connector.

The rest of the app (auth, bookings, payments, invoices, academy, reports) talks to Supabase directly from the browser via RLS-scoped Supabase client calls — there is intentionally no API Worker in between for core business logic, matching the app's existing architecture (unchanged by this task).

## 3. Data ownership — explicit boundary

| Data | System of record | Cloudflare's role |
|---|---|---|
| Bookings, invoices, payments, customers, academy, subscriptions | Supabase Postgres | None — never touched by Cloudflare storage |
| Auth, RLS, RPCs | Supabase | None |
| `notification_queue` (WhatsApp send queue) | Supabase Postgres | Container polls/consumes it; Cloudflare never stores a copy |
| WhatsApp session credentials (Baileys auth state) | Supabase (`whatsapp_accounts.session_credentials_encrypted`, AES-256-GCM) | Container reads it into ephemeral local disk at startup, writes updates back to Supabase; never persisted only-in-Cloudflare |
| "Is this account's container believed to be running" | Durable Object storage (`ctx.storage`) | Pure operational/coordination state — lifecycle bookkeeping only, not business data, rebuildable from nothing at any time |
| Static frontend assets | Cloudflare Workers Static Assets | Build artifacts only, sourced from the repo's own `npm run build` |

No component under `cloudflare/` stores a second copy of anything Supabase already owns. This was a hard design constraint, not a default.

## 4. WhatsApp account lifecycle

1. Platform owner (via existing admin flow, calling the Worker's `/manage/:clubId/start`, itself gated by `MANAGEMENT_API_TOKEN`) triggers `ensureRunning()` on the club's `WhatsAppAccountObject`.
2. The Durable Object calls `startAndWaitForPorts()` — Cloudflare starts (or resumes) the club's dedicated Container instance.
3. Container boots, `TenantConnectionManager.restoreAllPersistedSessions()` (pre-existing, unmodified code) pulls the encrypted session blob from Supabase, decrypts it, writes it to local disk, and Baileys attempts to reconnect using that state — no QR re-scan needed if the session is valid.
4. `HealthServer.ts` starts listening on port 8080 (the Container's `defaultPort`), exposing `/health`, `/ready`, `/status`.
5. The Durable Object's alarm loop (`schedule(60, 'runHealthPollTick')`) polls `/status` every 60 seconds using the internal `CONTAINER_INTERNAL_TOKEN`. While the container reports `shouldStayAwake: true` (connected or actively reconnecting), the DO calls `renewActivityTimeout()` to keep the container from sleeping. When the container stops reporting a live/reconnecting state, the DO stops renewing and lets the platform's own `sleepAfter` timeout (set to 3 minutes) put the container to sleep — it will resume from the next `/manage/:clubId/start` or the next scheduled poll needing it, restoring session state from Supabase exactly as in step 3.
6. On graceful shutdown (SIGTERM from Cloudflare, e.g. sleep or redeploy), `index.ts`'s existing `disconnectAllGracefully()` runs before exit, avoiding a `conflict/replaced` reconnect storm on the next start — this predates the Cloudflare work and was verified unchanged.

The Durable Object never touches the Baileys WebSocket. That connection lives entirely inside the container's own network stack, opened directly by Node/Baileys to WhatsApp's servers. This is deliberate — the DO's only job is single-owner lifecycle coordination, which Cloudflare's own "one global instance per DO name" guarantee provides structurally (not just via application-level locking) for the "one account, one authoritative session owner" requirement.

## 5. Session persistence model

**Single source of truth: Supabase Postgres**, `whatsapp_accounts.session_credentials_encrypted` (AES-256-GCM, key = `WHATSAPP_SESSION_ENCRYPTION_KEY`).

This was a pre-existing design in `SessionStore.ts` / `TenantConnectionManager.ts`, confirmed by reading the code rather than assumed: local disk (`WHATSAPP_TEMP_AUTH_DIR`) was already treated as pure ephemeral working cache, rehydrated from Postgres on every process start. Cloudflare Containers' disk being non-durable across sleep/restart (confirmed against current Cloudflare documentation — no native snapshot support yet) requires exactly this pattern. No architecture change was needed here — only verification.

Rejected alternatives (per the directive's "pick ONE canonical source, no 3-way sync" instruction):
- **R2**: would introduce a second copy of session state outside Supabase with no operational benefit over what's already there — rejected.
- **Durable Object storage**: appropriate for the lifecycle-coordination state described in §3, but storing session credentials there would duplicate Supabase's existing encrypted column for no gain, and DO storage is scoped per-DO-instance, which is a worse fit for a value the platform owner may need to inspect/rotate via existing Supabase-based admin tooling.

## 6. Scaling model

**One Durable Object + one Container per connected WhatsApp account** (i.e., per club). This was the directive's own stated preference and is consistent with the existing `TenantConnectionManager` isolation model (hashed-clubId-scoped auth directories, no shared state between tenants). A shared-container-for-cost-savings model was explicitly rejected — it would increase blast radius (one compromised or crashed container affecting multiple clubs' WhatsApp sessions) for a cost saving that, per §8, is not large enough to justify it at the pilot scale this task targets (1 club).

`wrangler.jsonc`'s `containers[].max_instances: 1000` is a platform ceiling, not a target — actual instance count equals the number of clubs with an actively-managed WhatsApp connection at any moment, most of which will be asleep (not billed for compute) outside business hours per the idle-sleep mechanism in §4.

## 7. Failure model

- **WhatsApp/Container down → booking, payment, invoice, and all core business flows keep working.** They talk to Supabase directly from the browser and have no synchronous dependency on the WhatsApp connector. The connector only *consumes* `notification_queue`; nothing in the booking/payment path blocks on it.
- **Container crashes mid-send** (after WhatsApp accepts the message, before Supabase's queue-status update commits): this is a real, currently-uneliminated residual risk. The existing queue design's idempotency/dedup keys reduce (do not eliminate) the chance of a duplicate resend on next poll. This is documented honestly here rather than claimed solved — see [MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md](MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md) §"Crash-after-send" for the specific mechanism and its limits.
- **Container replaced entirely** (not just process restart — a genuinely new Container instance, e.g. after a sleep cycle): session is expected to restore from Supabase per §5 without a QR re-scan. This is architecturally sound based on code reading; it has **not yet been empirically observed** against a live Cloudflare Container in this environment (Docker unavailable locally — see validation doc).
- **Durable Object restart/redeploy**: DO storage (the "container believed running" flag) is Cloudflare's own durable SQLite-backed storage — survives DO eviction/restart by platform guarantee. Worst case on a stale flag is one extra unnecessary `/status` poll before the DO self-corrects; no data-loss path.
- **Worker down**: the WhatsApp Worker being unreachable only blocks new `/manage/*` calls (starting/stopping accounts) — an already-running container keeps running and keeps talking to Supabase directly; it does not depend on the Worker being up for its own operation.

## 8. Cost model (Cloudflare Containers, Aug 2026 published pricing)

Requires **Workers Paid** ($5/mo base — no free tier for Containers). Included per month: 25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours disk. Overage: $0.0000025/GiB-s memory, $0.000020/vCPU-s CPU, $0.00000007/GB-s disk.

Model: `basic` instance (1/4 vCPU, 1 GiB memory, 4 GB disk), running continuously (24/7, worst case — actual cost will be lower once idle-sleep in §4 takes effect for accounts with quiet hours):

| Clubs | vCPU overage | Memory overage | Disk overage | Total overage/mo | + $5 base | **Total/mo** |
|---|---|---|---|---|---|---|
| 1 | $12.69 | $6.35 | $0.69 | $19.72 | $5 | **≈ $24.72** |
| 10 | $126.90 | $63.45 | $6.85 | $197.20 | $5 | **≈ $202.20** |
| 100 | $1,269.00 | $634.50 | $68.50 | $1,972.00 | $5 | **≈ $1,977.04** |
| 1,000 | $12,690.00 | $6,345.00 | $685.00 | $19,720.00 | $5 | **≈ $19,725.44** |

Roughly linear at ~$20/club/month under the "always-on" assumption. The idle-sleep mechanism (§4) should reduce this meaningfully for clubs whose staff aren't sending/receiving WhatsApp traffic 24/7, but that reduction has not been measured live and is not counted in the table above — the table is intentionally the conservative/worst-case number.

This cost is a genuine per-club marginal cost that must be reflected in Mal3aby's own pricing model before scaling past a handful of paying clubs — flagged here, not a decision this document makes.

## 9. Security boundaries

- **Two distinct internal secrets, never shared**: `CONTAINER_INTERNAL_TOKEN` (Worker/DO ↔ Container `/status`) and `MANAGEMENT_API_TOKEN` (external admin caller ↔ Worker `/manage/*`). Different trust boundaries.
- Container's only inbound port (8080) serves `/health`, `/ready`, `/status` — `/status` is the only one returning any account detail, and it fails closed (403) if `CONTAINER_INTERNAL_TOKEN` is unset or doesn't match, including in an environment where the variable was never configured.
- Container is never bare-exposed publicly; all inbound traffic to it is via `containerFetch()` from the Durable Object, which is Cloudflare's own internal service binding — not a publicly routable URL guarded only by a shared secret.
- All secrets (`SUPABASE_SERVICE_ROLE_KEY`, `WHATSAPP_SESSION_ENCRYPTION_KEY`, `CONTAINER_INTERNAL_TOKEN`, `MANAGEMENT_API_TOKEN`) are set via `wrangler secret put`, never committed to `wrangler.jsonc` (confirmed absent from the committed config — only non-secret `vars` like `SUPABASE_URL` and a placeholder `PUBLIC_APP_URL` are there).
- `HealthServer.ts`'s `/status` payload is built from `TenantConnectionManager.getAllDiagnostics()`, which was already designed (pre-existing) to truncate `clubId` and carry no phone numbers, message content, tokens, or session material.
- Production traffic must be HTTPS-only end to end; this is enforced by Cloudflare's edge for the frontend and Worker by default, and the Container's outbound connections (to Supabase, to WhatsApp) are HTTPS/WSS by the existing connector code, unchanged.

## 10. What's proven vs. what's designed-but-unverified

See [MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md](MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md) for the full breakdown. Summary: the Worker/Durable Object/Container *configuration* is validated against real Cloudflare tooling (`wrangler` dry-run, typecheck, local `wrangler dev`). The single most consequential unproven claim is whether Baileys' outbound WebSocket genuinely behaves correctly from inside a live Cloudflare Container — this requires either a working local Docker daemon (confirmed unavailable in this environment) or Cloudflare account credentials with Containers access (not available in this environment), and remains the explicit gating item before this architecture can be called production-verified for WhatsApp specifically.
