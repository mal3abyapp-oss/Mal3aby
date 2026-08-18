# Mal3aby — Cloudflare Deployment State

Live tracker of what has been built, validated, and what remains pending external input, for the MAL3ABY CLOUDFLARE-ONLY PRODUCTION ARCHITECTURE & DEPLOYMENT task. Updated after each phase.

Last updated: 2026-08-18

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
