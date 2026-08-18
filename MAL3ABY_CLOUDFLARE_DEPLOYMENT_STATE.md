# Mal3aby — Cloudflare Deployment State

Live tracker of what has been built, validated, and what remains pending external input, for the MAL3ABY CLOUDFLARE-ONLY PRODUCTION ARCHITECTURE & DEPLOYMENT task. Updated after each phase.

Last updated: 2026-08-18

---

## PRODUCTION DOMAIN BOUND — WORKERS PAID ACTIVE

**Workers Paid: ACTIVE**, confirmed via real official tooling, not a dashboard success message: `wrangler containers list` previously returned `401 Unauthorized: Deploying containers requires the Workers Paid plan`; it now returns `No containers found` — a genuine empty-list response from an authorized account, and a real `wrangler deploy --dry-run --containers-rollout=none` against the whatsapp-worker's container config continues to resolve cleanly. **Containers capability: AVAILABLE.**

**Domain: `mal3aby.app`, purchased and bound.** Both `mal3aby.app` and `www.mal3aby.app` are configured as Custom Domains (not plain Routes) in `cloudflare/frontend-worker/wrangler.jsonc`, deployed for real via `wrangler deploy` — Cloudflare's own deploy-time zone-ownership check is the proof the zone exists under this account (an unowned/nonexistent zone would have failed the deploy outright, not succeeded). `workers_dev: true` was kept explicit so the `workers.dev` URL remains available as a technical fallback, not the customer-facing canonical URL.

- **HTTPS**: confirmed live externally — valid certificate (no `-k` needed), full security header set present on every route.
- **www redirect**: `www.mal3aby.app` issues a real `308 Permanent Redirect` to `https://mal3aby.app/` (implemented in `cloudflare/frontend-worker/src/index.ts`, both domains route to the same Worker so www never becomes an independent origin). 308, not 301, so a non-GET request's method/body survive the redirect.
- **DNS**: both custom-domain DNS records and certificates were auto-provisioned by Cloudflare as part of the Custom Domain binding — no manual DNS record was created or edited, and no other account services' DNS was touched.
- **All deep-link routes re-verified live on `https://mal3aby.app`**: `/`, `/login`, `/app/bookings`, `/portal/bookings`, `/qr/invalid-test-token`, `/verify/invalid-test-token` — all 200, correct SPA fallback, full security headers, real Supabase RPC round-trips (invalid-token states correctly resolved), mobile viewport correct, RTL correct at default load.
- **One real, non-blocking finding**: Cloudflare's own auto-injected Web Analytics beacon script (`static.cloudflareinsights.com`) is blocked by this app's own CSP (`script-src 'self'`). This is the CSP doing exactly its job, not a bug — documented rather than silently observed, and not "fixed" by loosening the CSP for a feature nobody asked for.
- **`PUBLIC_APP_URL` updated to the real value**: `cloudflare/whatsapp-worker/wrangler.jsonc`'s `vars.PUBLIC_APP_URL` is now `https://mal3aby.app` (was the `REPLACE-WITH-PRODUCTION-DOMAIN` placeholder), redeployed live. Once the Container is deployed and actually sends a message, `templates.ts`'s `getQrUrl()`/`getVerifyUrl()` will produce `https://mal3aby.app/qr/<token>` and `https://mal3aby.app/verify/<token>` — confirmed by reading the code, not yet by a live send (no Container exists yet).

### Supabase Auth production URLs — genuinely blocked, not skipped

No tool available in this environment can write Supabase Auth's Site URL / Redirect URLs: the Supabase MCP server exposes no Auth-config write capability (confirmed by re-checking its full tool surface), and the Supabase dashboard requires an authenticated browser session this environment does not have (the browser tab opened at the Auth URL Configuration page showed a login form with credentials already present in the password field that were never entered by this session — entering or submitting that is out of scope regardless of what's pre-filled). This is a genuine, precise external/manual blocker: **the platform owner must update Supabase Dashboard → Authentication → URL Configuration → Site URL to `https://mal3aby.app` and add `https://mal3aby.app/*` to Redirect URLs** (login, email confirmation, password reset, customer portal, staff/owner auth all read from this same config). Local development `localhost` redirects were not touched and should stay for local dev.

### WhatsApp Container — Cloudflare-supported OCI build path found, one manual step remains

Per real Cloudflare documentation (re-verified live this session, not assumed): **every path to build or push a Container image — `wrangler deploy` with a Dockerfile, `wrangler containers build`, `wrangler containers push` — requires a Docker-compatible engine wherever that command runs.** There is no Cloudflare-native remote-build service that avoids this. The requirement is a valid OCI image, not "Docker Desktop specifically" — so a **GitHub Actions workflow** (`.github/workflows/whatsapp-container-build.yml`, new) was built: a GitHub-hosted runner (real Docker, zero local dependency) builds `whatsapp-connector/Dockerfile` and pushes it to `registry.cloudflare.com` via `wrangler containers build --push`, authenticated with `CLOUDFLARE_API_TOKEN` — GitHub Actions is one of Cloudflare's own two officially-documented external CI/CD providers, not an invented workaround, and this does not touch VPS/self-hosted infrastructure.

**One remaining manual step gates this workflow**: a Cloudflare API token (scoped to this account, Containers:Edit) must be created via the Cloudflare dashboard (My Profile → API Tokens → Create Custom Token) and added as the `CLOUDFLARE_API_TOKEN` secret in the GitHub repo (Settings → Secrets and variables → Actions). Neither step is performable by this session: the `wrangler` OAuth session in use cannot mint a new scoped API token, and `gh secret list`/`gh secret set` against this repo returned `403: You must have repository read permissions or have the repository secrets fine-grained permission` — confirmed, not assumed. Creating an account-level API token is the same category of action as a credential/password entry and is correctly left to the account owner.

Docker was re-checked once this session (per the "don't loop on Docker Desktop" instruction) and remains down — not retried further.

---

## FREE PREPARATION COMPLETE

Everything closeable on the current free plans (Cloudflare Workers Free, Supabase Free — both intentionally temporary, not upgraded during this pass) has been closed. Real findings from a full static/code-level audit of the WhatsApp Container path, Durable Object, Management API, and session/queue persistence design:

- **Two real (low-severity) findings fixed**: (1) both `whatsapp-connector/Dockerfile` and `HealthServer.ts` carried a stale comment claiming a `pingEndpoint`/"/ready" override that does not exist in the actually-installed `@cloudflare/containers@0.0.13` API (`startAndWaitForPorts()` gates on TCP port reachability only) — corrected to describe the real mechanism. (2) Both the Container's `/status` endpoint (`HealthServer.ts`) and the Worker's public `/manage/*` endpoint (`index.ts`) used a plain `!==` string comparison for their bearer tokens — timing-variable. Replaced with `node:crypto`'s `timingSafeEqual` (Container, internal-only, defense-in-depth) and the Workers runtime's native `crypto.subtle.timingSafeEqual` (Worker, genuinely public-internet-facing — the real threat surface of the two). Both typechecked clean, redeployed live, and the Management API auth gate re-verified live (401/401/404 for no-token/wrong-token/unknown-route).
- **Session persistence design confirmed sound by direct code reading** (`SessionStore.ts`): AES-256-GCM encryption, per-club SHA-256-hashed auth-directory isolation, `0o700`/`0o600` file permissions, throws (never silent no-op) on a corrupted/tampered payload, and `TenantConnectionManager.restoreAllPersistedSessions()` pulls the encrypted blob from Postgres and writes it to local disk **before** Baileys attempts reconnect at every process start — the exact pattern needed for Cloudflare's ephemeral-disk container model. No architecture change was needed, only verification.
- **Queue recovery confirmed already solved, with real evidence of a prior live bug and its fix**: `whatsapp_connector_claim_next_batch()` uses `FOR UPDATE ... SKIP LOCKED` (concurrency-safe claim). A genuine crash-recovery gap (a connector crash mid-send left a queue row permanently stuck in `processing`, invisible to every existing diagnostic) was found live during an earlier Safe Messaging test and fixed in `whatsapp_connector_expire_stale()` — already called every `QueueConsumer` poll tick — which reclaims any row stuck in `processing` for >10 minutes back to `retrying` without double-counting the attempt. Confirmed live in the current deployed function source, not assumed from a migration filename.
- **Duplicate-delivery protection confirmed real**: a partial unique index (`notification_queue_dedup_active_idx`) on `dedup_key` scoped to active statuses prevents a second queue row for the same logical event while one is in flight. The one remaining residual risk — a crash in the narrow window between WhatsApp accepting a send and `reportSendResult()` committing — is not eliminable without idempotent send-confirmation from WhatsApp itself (Baileys doesn't provide one); this is documented honestly, not hidden, and is bounded by the same 10-minute stuck-processing recovery above.
- **Durable Object club isolation confirmed real**: `getAccountObject()` derives the DO instance name directly from the request's `clubId` path segment via Cloudflare's own `getContainer()`/`idFromName` mechanism — there is no code path where a request authenticated for one club's management action can reach another club's DO instance except by an authorized caller explicitly supplying a different `clubId` (which is the intended platform-admin capability, not a leak).
- **Git secrets audit: PASS.** Full repo-wide scan (this pass and cumulative across prior passes) found no real `.env`, JWT, service-role key, private key, Baileys session file, Cloudflare token, WhatsApp encryption key, or management token ever committed. Only `.env.example` (placeholder values) and the documented `PUBLIC_APP_URL` placeholder (`https://REPLACE-WITH-PRODUCTION-DOMAIN`, a non-secret `var`, not a fake secret) exist in tracked files.
- **Production frontend re-verified live, no regression**: all deep-link routes, security headers, and Supabase connectivity confirmed unchanged and correct on `https://mala3by-frontend.moustafa-elsafy2.workers.dev`.

**READY FOR WORKERS PAID ACTIVATION: YES.**

### Production Secrets Matrix (names only — code-derived, no values shown)

| Name | Secret or non-secret | Used by | Where configured | Required before deploy? | Rotation impact |
|---|---|---|---|---|---|
| `SUPABASE_URL` | Non-secret | Connector + Worker + Durable Object | `wrangler.jsonc` `vars` (both projects); connector `.env` | Yes | None — public project URL, safe to change anytime |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** | Connector (all Supabase reads/writes: queue claim, session load/store, account status) | `wrangler secret put` (whatsapp-worker, passed to Container via `envVars`); connector `.env` for local/VPS | Yes | Rotating requires updating both the Cloudflare secret and Supabase's own key — a stale value fails every Supabase call, not just auth |
| `WHATSAPP_SESSION_ENCRYPTION_KEY` | **Secret** | Connector (`SessionStore.ts` — encrypts/decrypts the Baileys auth-state blob) | `wrangler secret put`; connector `.env` | Yes | **Must match the value already used for any club with an existing paired session** — changing it makes existing encrypted sessions permanently undecryptable, forcing a fresh QR pair for every affected club |
| `CONTAINER_INTERNAL_TOKEN` | **Secret** | Container's `/status` endpoint (`HealthServer.ts`) checks it; Durable Object (`WhatsAppAccountObject.ts`) presents it via `containerFetch()` | `wrangler secret put` (whatsapp-worker) — flows to the Container via the Container class' own env passthrough; connector `.env` for local testing | Yes | Rotating requires updating the Worker secret and the value the Container reads — a mismatch makes `/status` fail closed (403), which only affects idle-sleep cost optimization, not correctness (the container keeps running, just never sleeps until fixed) |
| `MANAGEMENT_API_TOKEN` | **Secret** | Worker's public `/manage/*` routes (`index.ts`) | `wrangler secret put` (whatsapp-worker) | Yes | Rotating requires updating whatever authorized caller (platform-owner admin action, ops tooling) presents it — a mismatch makes all `/manage/*` calls 401 until fixed; does not affect an already-running container |
| `PUBLIC_APP_URL` | Non-secret | Connector (`templates.ts` — builds QR/invoice links in WhatsApp messages); Worker `vars` | `wrangler.jsonc` `vars` (currently the placeholder `https://REPLACE-WITH-PRODUCTION-DOMAIN` — intentionally not filled with a fake value while no Container is deployed); connector `.env` | Yes, once a real domain exists | Changing it only affects newly-generated links; already-sent WhatsApp messages keep their original (now possibly stale) link — no security impact, only a UX one if changed after messages are already in customers' hands |
| `HEALTH_PORT` | Non-secret | Connector (`HealthServer.ts`) | Connector `.env` / Dockerfile `ENV` (defaults to `8080`, matches `defaultPort` in `WhatsAppAccountObject.ts`) | No (has a safe default) | None |
| `QUEUE_POLL_INTERVAL_MS`, `QUEUE_BATCH_SIZE`, `LOG_LEVEL`, `WHATSAPP_TEMP_AUTH_DIR` | Non-secret | Connector | Connector `.env` (all have safe defaults) | No | None |

**PUBLIC_APP_URL production value**: unknown until a real Cloudflare custom domain is bound (external blocker, unchanged from the prior report). No placeholder secret was invented for this — the config correctly documents the gap rather than guessing.

### Observability preparation (free tier only, nothing purchased)

Workers Logs (`observability.enabled: true`) is live on both `mala3by-frontend` and `mala3by-whatsapp-worker` — confirmed via the redeploy in the prior phase, free tier, no plan upgrade. Container health/connection-status/queue-pending/queue-failed/last-error/last-seen visibility already exists at the data layer (`whatsapp_accounts` table, `HealthServer.ts`'s `/status` diagnostics) and requires no additional purchase to view once the Container itself is deployed — the platform-owner-facing WhatsApp health screen remains a Phase B item per `MAL3ABY_PRODUCTION_READINESS.md`, not built in this pass (no scope creep).

### Supabase Free / Transactional Email — explicitly not changed

Per this task's own instruction, no Supabase upgrade was requested and none is pending action here. **`BACKUP = NOT PRODUCTION READY ON CURRENT PLAN`** remains the accurate, undisguised status — it is not reframed as PASS. This gap does not block technically testing the WhatsApp Container once Workers Paid + Docker are available; it only blocks the "FIRST PAID CLUB" commercial gate. Similarly, no transactional email provider was added: **`OPEN SELF-SERVICE SIGNUP = BLOCKED/WARN`**, while **`CONTROLLED PILOT WITH PRE-CONFIRMED ACCOUNTS = POSSIBLE`** (the platform owner can pre-confirm pilot accounts manually, unaffected by this gap).

### Only remaining requirements to test the WhatsApp Container live

1. Activate Cloudflare Workers Paid ($5/mo — not activated in this pass, requires explicit approval)
2. Have a working Docker/OCI builder (local Docker daemon still down, re-confirmed once, not looped)
3. Configure the production secrets listed in the matrix above via `wrangler secret put`
4. Build the container image
5. Deploy the Container
6. Execute the live acceptance tests already specified in `MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md` §5

No other internal/code blocker remains.

---

## Account discovery (real, live, verified — not assumed)

- **Cloudflare**: authenticated via `wrangler whoami` — account `Moustafa.elsafy2@gmail.com's Account`, ID `35ac10727701095866b16c276b4a33d1`. Token scope includes `containers (write)`, `workers (write)`, `d1 (write)` — full deploy capability. **Workers plan: Free.** Confirmed live via `wrangler containers list` → `401 Unauthorized: ... Deploying containers requires the Workers Paid plan.` No existing zones/custom domains found in the account (4 pre-existing unrelated Workers: `nfc-platform-web-preview`, `local-commerce-platform`, `ems-v2`, `ghezaa` — none conflict with `mala3by-*` naming). R2 not enabled (separate dashboard opt-in required — not needed by this architecture anyway). D1: 0 databases (correctly unused — Supabase remains sole business-data store).
- **Docker**: daemon unreachable (`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`), re-checked once this session per the "don't loop forever" instruction, confirmed still down. `wrangler deploy` on the whatsapp-worker independently confirms Docker is required before it would even reach the Workers-Paid-plan check — **two independent, stacked blockers** on the Container specifically.
- **Supabase**: org `mal3abyapp-oss's Org` (`bmqsldayximwywutofgi`), **plan: free**. Project `gxkrtlvpjwxhcqdisyob`, `ACTIVE_HEALTHY`, Postgres 17.6.1, `eu-central-1`. 118 local migration files; live migration history shows 125 entries (9 extra are legitimate applied-then-reverted transient/regression-test migrations — e.g. `temp_grant_academy_manager_for_smoke_test`, `drop_orphaned_activate_subscription_overload` — confirmed NOT real drift by directly checking live schema: `_activate_subscription_if_due_internal` exists as expected, no orphaned function overloads, `unfreeze_subscription` present). Security advisors: 0 CRITICAL/ERROR, 90 WARN (mostly the intentional SECURITY DEFINER RPC pattern this app's authorization model relies on — each RPC does its own `has_permission()`/`is_platform_owner()` check internally, confirmed by design, not re-audited function-by-function in this session), 1 INFO (`whatsapp_accounts` RLS-enabled-no-policy — verified live as a deliberate deny-all lockdown via `FORCE ROW LEVEL SECURITY`, confirmed `anon` role sees 0 rows; NOT a vulnerability).

## Live production verification performed (real, external, not local-only)

- **Frontend deployed and externally verified**: `https://mala3by-frontend.moustafa-elsafy2.workers.dev` (Version `2dc074f7-08ff-40a0-ac8b-59480c36d6d1` as of this write, observability enabled). Verified via real `curl`+browser: `/`, `/app/bookings`, `/qr/:token`, `/verify/:token`, `/portal/bookings` all 200 with correct SPA fallback and full security-header set (HSTS/CSP/X-Frame-Options/etc.) on every route including static assets. Mobile viewport (375px) renders correctly, RTL Arabic renders correctly, zero console errors. Live login attempt against production Supabase correctly rejected invalid credentials with a graceful bilingual-ready error — proves the real Auth round-trip works end-to-end from the deployed frontend. Live `/qr/:token` and `/verify/:token` with invalid tokens both correctly resolve to "invalid code" states after a real Supabase RPC round-trip (visible as an expected 400 in console, correctly caught and rendered, not a crash).
- **WhatsApp Worker + Durable Object deployed** (Container excluded via `--containers-rollout=none`, since Docker+Paid-plan block the container specifically, not the Worker/DO code): `https://mala3by-whatsapp-worker.moustafa-elsafy2.workers.dev`. Verified live: `/health` → 200 `ok`; `/manage/:clubId/start` with no token → 401; with wrong token → 401; unknown route → 404. Confirms the Management API auth gate fails closed correctly in real production, even with `MANAGEMENT_API_TOKEN` unset (no secret has been configured yet — intentionally deferred until the Container itself is deployable, to avoid provisioning production secret material for a binding that can't be exercised yet).
- **Database-level integrity confirmed live** (read-only checks against real production data): double-booking is blocked by a Postgres `EXCLUDE USING gist` constraint on `bookings` (not just application logic — immune to race conditions); payment idempotency is enforced by a real partial unique index `payments_club_idempotency_key_unique`; RLS tenant isolation confirmed live — a session with a random/unaffiliated `auth.uid()` sees 0 bookings for a real club with real data.
- **No LAN/localhost values found in any deployed/tracked production config** — repo-wide search found only expected dev-only defaults (`.env.example`, `supabase/config.toml`'s local CLI config, `templates.ts`'s documented last-resort fallback) and the real local `.env` (git-ignored, never deployed).

### Phase 1 — WhatsApp Container prototype (code + config)
**Status: COMPLETE (code), NOT EMPIRICALLY PROVEN LIVE (blocked)**

- `whatsapp-connector/src/HealthServer.ts` — new, /health /ready /status endpoints. Build/typecheck/live smoke-test all pass.
- `whatsapp-connector/Dockerfile`, `.dockerignore` — new, multi-stage, non-root, no VOLUME for ephemeral auth dir.
- `cloudflare/whatsapp-worker/` — new Worker + `WhatsAppAccountObject` Durable Object. Typechecks clean against the real installed `@cloudflare/containers@0.0.13` API (a documented-but-nonexistent `getState()` was caught by `tsc` and fixed). `wrangler deploy --dry-run --containers-rollout=none` validates the full binding/container wiring.
- Blocked: Docker daemon unavailable locally (confirmed by the user), no Cloudflare account access in this environment. Live Baileys-in-Container networking is unproven — see `MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md`.
- Committed: `6955078`.

### Phase 2 — Frontend deployment config
**Status: COMPLETE, locally verified live**

- `cloudflare/frontend-worker/` — Workers Static Assets config pointing at the repo root's own `dist/`. SPA fallback verified live via `wrangler dev` against every required deep-link route.
- Committed: `4edeca0`.

### Phase 3 — Architecture/validation documentation + security headers + runbook rewrite
**Status: COMPLETE**

- `MAL3ABY_CLOUDFLARE_PRODUCTION_ARCHITECTURE.md` — new.
- `MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md` — new, evidence-labeled.
- `MAL3ABY_DEPLOYMENT_RUNBOOK.md` — rewritten Cloudflare-only, VPS/PM2/systemd guidance removed.
- `cloudflare/frontend-worker/src/index.ts` — new, security headers Worker. Real bug caught and fixed (`run_worker_first` requirement) — see validation doc §4.
- Full safety gate run: root build/lint/tests, connector typecheck/build, both Cloudflare projects typecheck/dry-run — all clean.
- Committed: `adc871d`.

### Phase 4 — Documentation, Phase 5 — Real production deployment
**Status: COMPLETE (for everything not blocked by Docker/Workers-Paid-plan)**

Committed the account-discovery findings and observability config: `cloudflare/frontend-worker/wrangler.jsonc` and `cloudflare/whatsapp-worker/wrangler.jsonc` both now have `observability.enabled: true` (free-tier, no plan upgrade needed).

**Real, live production deployments performed this phase:**
- `cloudflare/frontend-worker` deployed for real via `wrangler deploy` (not dry-run) → `https://mala3by-frontend.moustafa-elsafy2.workers.dev`. Externally verified: all deep-link routes, security headers, mobile viewport, RTL, live Supabase Auth round-trip (rejected bad credentials correctly), live QR/Invoice invalid-token pages (correct error states from real Supabase RPC calls).
- `cloudflare/whatsapp-worker` deployed for real via `wrangler deploy --containers-rollout=none` (Container excluded — blocked by Docker+Workers-Paid-plan, Worker/DO code is not) → `https://mala3by-whatsapp-worker.moustafa-elsafy2.workers.dev`. Externally verified: `/health` 200, Management API auth gate correctly returns 401 for missing/wrong tokens, 404 for unknown routes.
- Database-level integrity re-confirmed against real production data (read-only): double-booking blocked by a Postgres exclusion constraint, payment idempotency enforced by a real partial unique index, RLS tenant isolation confirmed live (unaffiliated `auth.uid()` sees 0 rows on a real club's bookings).
- Production secrets for the WhatsApp Worker (`SUPABASE_SERVICE_ROLE_KEY`, `WHATSAPP_SESSION_ENCRYPTION_KEY`, `CONTAINER_INTERNAL_TOKEN`, `MANAGEMENT_API_TOKEN`) intentionally **not yet set** — no live Container exists yet to consume them, so provisioning real secret material now would sit unused; correctly sequenced to happen alongside the actual Container deploy once Docker/Workers-Paid-plan are resolved.
- Supabase Auth Site URL / Redirect URLs **not yet updated** — no production custom domain exists yet (still on `workers.dev`), and no Auth-config tool is available in this environment (Supabase Auth settings require dashboard/Management-API access this session doesn't have); correctly sequenced to happen once a real domain is bound.

### Phase 6 — Final status report
**Status: COMPLETE** — see the `MAL3ABY CLOUDFLARE PRODUCTION STATUS` report delivered in chat.

---

## External blockers (precise, not a vague catch-all)

| Blocker | Blocks | Where it's resolved | Costs money? | What proceeds without it |
|---|---|---|---|---|
| Docker Desktop daemon not running on dev machine (re-confirmed this session, still down) | Building the `whatsapp-connector` container image; live Baileys-in-Container validation; `wrangler secret put` for the Container's own runtime secrets (deferred until deployable) | Start Docker Desktop on this machine, or provide any Docker/OCI-compatible builder machine `wrangler` can reach | No | Everything else — frontend, Worker/DO code, all non-Container infra |
| **Cloudflare account is on the Workers Free plan** — Containers requires Workers Paid (confirmed live via `wrangler containers list` → 401) | Deploying the WhatsApp Container even if Docker were available | dash.cloudflare.com → Workers & Pages → Plans → upgrade to Workers Paid | **Yes — $5/mo base** | Same as above; this is the second, independent blocker stacked on top of Docker |
| No production domain / DNS zone in the Cloudflare account | Binding a custom domain to the frontend Worker; updating Supabase Auth Site URL/Redirect URLs; `PUBLIC_APP_URL` still a placeholder | Purchase/assign a domain, add it as a Cloudflare zone | Only if a new domain must be purchased | Everything continues on the real `workers.dev` URLs already live |
| Supabase org still on the free plan | Cannot claim backup-ready for a paid pilot (per `BACKUP_RECOVERY_RUNBOOK.md`); confirmed live via `get_organization` → `"plan":"free"` | Supabase dashboard → Organization → Billing → upgrade | Yes | Technical pilot can proceed; only the "FIRST PAID CLUB" commercial gate is blocked |
| No transactional email provider configured in Supabase Auth | Real self-service signup (email confirmation) — confirmed live: both QA test-owner accounts show `email_confirmed_at: null` | Supabase dashboard → Authentication → SMTP Settings | Only if a paid provider is chosen (some have free tiers) | Pilot accounts can be pre-confirmed manually by the platform owner without this |

None of these are in-code problems — every in-code/config item achievable without these four external dependencies has been built, deployed where possible, and live-verified.
