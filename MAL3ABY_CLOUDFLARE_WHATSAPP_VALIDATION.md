# Mal3aby — Cloudflare WhatsApp Container Validation

Status: **PARTIAL — proxy validation complete, live in-container Baileys networking NOT yet empirically proven.**

Last updated: 2026-08-18

This document exists to give an honest, evidence-separated account of what has actually been tested against real tooling versus what is architecturally reasoned but unverified. Every claim below is labeled with how it was established.

---

## 1. Environment constraints (why some tests could not run)

Two blockers were hit and confirmed, not assumed:

1. **Docker Desktop daemon unavailable on this dev machine.** `docker build` failed: `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine ... The system cannot find the file specified.` An attempt to launch Docker Desktop and poll for readiness hung past a 2-minute timeout. The user then explicitly confirmed: **"دوكر لا يعمل لدي"** (Docker doesn't work for me). This is treated as a confirmed environmental fact, not retried further.
2. **No Cloudflare account credentials in this environment.** `wrangler deploy` (real, non-dry-run) requires interactive OAuth login or an API token, neither available here. Remote validation against a live Cloudflare account (staging or production) could not be performed.

Researched whether `wrangler` can build/deploy Containers without local Docker (e.g., a remote-build service): confirmed via current documentation search that it currently **cannot** — Docker (or an OCI-compatible builder) is required locally today for `wrangler deploy` to build a container image. This is a genuine current limitation of the Cloudflare Containers product, not specific to this machine.

Given both blockers, validation below used every method that does NOT require Docker or Cloudflare account access, and is explicit about the one thing that remains unproven.

## 2. What WAS validated, with evidence

### 2.1 Worker + Durable Object + Container config is structurally valid

`npx wrangler deploy --dry-run --containers-rollout=none` in `cloudflare/whatsapp-worker` completed successfully: bundled the Worker, resolved the `WHATSAPP_ACCOUNT` Durable Object binding, located and parsed the referenced Dockerfile path (`../../whatsapp-connector/Dockerfile`), and validated the `containers[]` config block (image reference, `max_instances`, `instance_type`) without error. This proves the wiring between Worker, Durable Object class, and Container image reference is syntactically and structurally correct per Cloudflare's own tooling — it does not prove the image builds or runs.

### 2.2 TypeScript compiles clean against the real installed `@cloudflare/containers` API

`npx tsc --noEmit` in `cloudflare/whatsapp-worker` was run to completion with zero errors after a real fix (see §4, "getState() finding"). This means `WhatsAppAccountObject.ts` and `index.ts` are type-correct against `@cloudflare/containers@0.0.13` as actually installed (verified by reading `node_modules/@cloudflare/containers/dist/index.d.ts` directly, not by trusting documentation prose, which was found to be stale/inaccurate on this exact point).

### 2.3 whatsapp-connector build/typecheck/tests pass unmodified

The existing connector's own test suite and typecheck were run after adding `HealthServer.ts` and wiring it into `index.ts` — all passed, confirming the new health-server code doesn't regress any existing Baileys/queue/session behavior. (Exact numbers reported in the final status report.)

### 2.4 `HealthServer.ts` HTTP contract verified live via a standalone smoke test

Ran the built `dist/HealthServer.js` directly under plain Node (no container, no Cloudflare — just proving the HTTP server code itself is correct) and issued real HTTP requests against it:
- `GET /health` → 200 `ok`, no dependencies checked, as designed.
- `GET /ready` → exercised against a live/mocked `sync.listAccounts()` — 200 on success path.
- `GET /status` without `x-internal-token` → 403 `forbidden` (fails closed, confirmed).
- `GET /status` with correct token → 200 with the expected JSON shape (`accounts`, `anyConnected`, `anyReconnecting`, `shouldStayAwake`), no secret fields present.
- Unknown path → 404 `not found`.

This proves the HTTP contract the Durable Object depends on (§4 of the architecture doc) behaves exactly as designed. It does **not** prove this server runs correctly inside an actual Cloudflare Container network namespace — only that the Node.js HTTP code itself is correct.

### 2.5 Frontend SPA deployment config verified live via real local Workers runtime

`npx wrangler dev --port 8788` in `cloudflare/frontend-worker` started a genuine local `workerd` runtime (not a mock) serving the real repo-root `dist/` build output. Live `curl` requests confirmed:

| Route | Result |
|---|---|
| `/` | 200, real app shell HTML |
| `/app/bookings` | 200, SPA fallback |
| `/qr/abc123` | 200, SPA fallback (directive's own required deep-link test) |
| `/verify/xyz789` | 200, SPA fallback |
| `/portal/bookings` | 200, SPA fallback |
| `/favicon.svg` | 200, served as a real static asset, not fallback |

Fallback responses carried `Content-Type: text/html; charset=utf-8` and real app content (`<html lang="ar" dir="rtl">`, title "ملعبي | Mala3by", real bundled asset filename). This is genuine proof that `not_found_handling: "single-page-application"` in `wrangler.jsonc` correctly serves every deep-link route Mal3aby needs, achieved entirely without Cloudflare account credentials.

### 2.6 Session persistence architecture confirmed correct by reading, not assuming

`SessionStore.ts` and `TenantConnectionManager.ts` were read directly. Both already implement exactly the pattern Cloudflare's ephemeral-disk model requires: Postgres (`whatsapp_accounts.session_credentials_encrypted`) as the durable source of truth, local disk as pure rehydratable cache, restored on every process start via `restoreAllPersistedSessions()`. This is a genuine finding — it means the single most consequential Cloudflare-Containers architectural risk (disk not surviving sleep/restart) was already solved by the existing codebase before this task began, and required zero code changes, only verification.

### 2.7 Graceful shutdown confirmed correct

`index.ts` already handles `SIGTERM`/`SIGINT` via `disconnectAllGracefully()` (a pre-existing fix from an earlier remediation pass addressing a `conflict/replaced` reconnect storm). The Dockerfile's `CMD ["node", "dist/index.js"]` uses exec form specifically so Node runs as PID 1 and receives `SIGTERM` directly from Cloudflare's container lifecycle without a wrapper process swallowing the signal — confirmed by reading Docker's own documented exec-vs-shell CMD signal behavior.

## 3. What has NOT been validated — the honest gap

**Not proven: a real Baileys instance, running inside an actual Cloudflare Container (Firecracker microVM), successfully opening and sustaining an outbound `wss://` connection to WhatsApp's servers.**

This is the single most important unresolved empirical question for the whole Cloudflare-only WhatsApp architecture, and it has not been answered live in this environment. What exists instead is a *reasoned hypothesis*: Cloudflare Containers run on Firecracker microVMs with a genuine Linux kernel network stack, which is architecturally distinct from the Workers V8-isolate runtime's WebSocket restrictions (some external documentation/discussion conflates the two — they are not the same product). A standard Node.js `ws`-based outbound connection on port 443, of the kind Baileys makes, should work the same way it does on any ordinary Linux VPS. This is plausible and worth prototyping — it is not proof.

Also not tested, all blocked by the same two constraints (§1):

- **Session restore across real container replacement** (pair → connect → kill container → new container instance → restore from Supabase → reconnect without QR). Architecturally sound per §2.6; not observed live.
- **Queue recovery** (container down → recovers → delivers pending notifications exactly once). Existing idempotency/dedup mechanisms are the intended safeguard; not exercised against a live crash/recovery cycle in a container.
- **Crash-after-send, before-DB-update.** If the container is killed in the narrow window after Baileys confirms a WhatsApp send but before the Supabase queue-status update commits, the message could be resent on next poll. The existing dedup/idempotency keys reduce this window's blast radius but do not eliminate it — this residual risk is real and is documented here rather than hidden, per the directive's own requirement.
- **Multi-account isolation** (≥2 clubs' containers/sessions never cross-contaminate). Architecturally guaranteed by the one-DO-one-Container-per-clubId model (§6 of the architecture doc) and the existing hashed-clubId-scoped auth directories — not exercised with two live containers simultaneously.
- **Multi-hour soak test** (reconnects, disconnect reasons, memory/CPU drift, socket duplication, session-write frequency). Not run — requires a live container.
- **Restart-storm test** (repeated disconnect/reconnect never causes an infinite loop, duplicate sockets, or message storm). Not run live; the existing `disconnectAllGracefully()` and Baileys' own reconnect backoff are the intended safeguards, unchanged from the pre-Cloudflare codebase where they were already relied upon.

## 4. Real findings produced by attempting validation

These are genuine defects/gaps this validation work surfaced, not invented for completeness:

- **Workers Static Assets bypasses the Worker script by default.** When adding a minimal Worker to `cloudflare/frontend-worker` purely to inject security headers, an initial config had headers present on SPA-fallback routes but silently ABSENT on `/` and on real static assets (`/favicon.svg`) — confirmed live via `wrangler dev` + `curl`, not assumed. Root cause (confirmed against current Cloudflare documentation): Cloudflare serves a request that matches a real static file directly, without invoking the Worker at all, unless `assets.run_worker_first: true` is set. Fixed by adding that flag; re-verified live that all security headers are now present on every route type (root, static asset, SPA-fallback deep link). This is exactly the kind of silent-gap defect this validation process exists to catch before it reaches production.

- **`getState()` does not exist.** `@cloudflare/containers` documentation prose describes a `getState()` method on `Container`. The actually-installed package (`0.0.13`) does not export it — confirmed by reading `node_modules/@cloudflare/containers/dist/index.d.ts` directly. An initial draft of `WhatsAppAccountObject.ts` called this nonexistent method and was caught by a real `tsc --noEmit` TS2339 error, not by inspection. Fixed by tracking "container believed started" via the Durable Object's own `ctx.storage` instead. This is itself useful validation output: current Cloudflare documentation for this package is ahead of (or inconsistent with) what's actually published to npm, and any future Cloudflare Containers work on this project should verify against the installed `.d.ts`, not docs, before relying on a method signature.
- **`@cloudflare/workers-types` version mismatch.** The initially guessed version (`^4.20250101.0`) conflicted with `wrangler@4.123.0`'s actual peer dependency (`^5.20260811.1`). Fixed by correcting the version. Confirms the documentation's implied compatibility matrix was stale at the time of writing.
- **Local Docker builds are a hard current requirement for `wrangler deploy` with Containers**, with no documented remote-build fallback as of this writing — worth tracking as a deployment-process risk independent of Mal3aby specifically, since it means whoever deploys this Worker in the future needs a working local Docker install.

## 5. Acceptance gate status

Per the governing directive, the explicit gate before committing to Cloudflare-only WhatsApp:

| Gate item | Status |
|---|---|
| Container runs Baileys | **NOT TESTED** (blocked: no Docker, no Cloudflare account) |
| WhatsApp connection succeeds | **NOT TESTED** |
| Existing session restore works | **NOT TESTED** (architecturally sound per §2.6, unverified live) |
| Container replacement recovery | **NOT TESTED** |
| Queue recovery | **NOT TESTED** |
| No duplicate socket | **NOT TESTED** (architecturally prevented by design, per §4 of architecture doc — unverified live) |
| No duplicate sends in tested scenarios | **NOT TESTED** (no scenarios could be run live) |
| Session state durable | **PARTIALLY VALIDATED** — durable by design (Supabase-backed), confirmed via code reading, not via a live kill-and-restore cycle |
| Secrets protected | **VALIDATED** — two-tier token model, fail-closed `/status`, no secrets in committed config (§2.3–2.4, §9 of architecture doc) |

**Conclusion: the acceptance gate is not met.** Per the directive's own explicit instruction, this is stated plainly rather than claimed as a pass. The correct framing, carried into the final status report, is that the WhatsApp Container prototype is **architecturally complete and locally/structurally validated to the maximum extent possible without Docker or Cloudflare account access**, and that the live networking question remains the single blocking external dependency before Cloudflare-only WhatsApp can be declared production-ready. This does **not** trigger a fallback to a VPS — that option remains explicitly out of scope per the governing directive — and does not block the rest of the Cloudflare deployment work (frontend, Worker config, documentation, runbooks), which proceeds independently.
