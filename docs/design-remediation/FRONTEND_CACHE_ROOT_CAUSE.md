# Frontend Cache Root-Cause Remediation (2026-09-06)

Supersedes the conclusion in [FRONTEND_CACHE_UPDATE_STRATEGY.md](../../FRONTEND_CACHE_UPDATE_STRATEGY.md) that the `no-store` fix "cannot recur" — it recurred **twice more** after that fix shipped (releases on 2026-09-05 and 2026-09-06), each confirmed via direct production header inspection, each resolved only by a manual "Purge Everything." This document is the honest record of why, and what actually closes the gap.

## Root cause

**Confirmed empirically, live, on real production** (not assumed):

```
$ fetch('https://mal3aby.app/', {cache:'no-store'})
cache-control: no-store
cf-cache-status: HIT          <-- should be architecturally impossible together
date: <frozen — identical across 3 requests with different, unique query strings>
etag: <identical across those same 3 requests>
```

`Cache-Control: no-store` is correctly present on the response the client receives (confirmed: `cloudflare/frontend-worker/src/index.ts`'s `cacheControlFor()` function has always set this correctly, unchanged since the 2026-08-27 fix). Despite that, Cloudflare's edge served an identical cached object across multiple distinct requests, including ones with different query strings that should defeat any query-string-insensitive cache key entirely.

**Cache layer responsible**: Cloudflare Workers Static Assets' own automatic edge caching for static assets. Cloudflare's documentation (confirmed via direct research this session) states plainly that "Cloudflare provides automatic caching for static assets across its network" as a first-class feature of the Static Assets binding itself — separate from, and evidently not fully governed by, the `Cache-Control` header a wrapping Worker script sets on its returned response. **This precise precedence (Worker-set headers vs. the Static Assets pipeline's own internal caching) is not documented anywhere Cloudflare publishes** — confirmed by exhausting the relevant doc pages (Static Assets overview, routing, HTML handling, the ASSETS binding reference, the Cache API reference) this session; none of them state whether `env.ASSETS.fetch()`'s internal caching decision is made before or independently of the Worker's subsequent header mutation.

This was verified NOT to be:
- A **Cache Rule** — confirmed zero active Cache Rules on the zone (`0 active` in the dashboard, checked directly).
- A **Page Rule** — confirmed `0 of 3` Page Rules used.
- A browser-side cache — the evidence (identical `Date`/`ETag` across requests with distinct cache-busting query strings, made via `fetch(..., {cache:'no-store'})`, which explicitly bypasses the browser's own HTTP cache) rules this out.
- The service worker — already correctly fixed (`registerType: 'prompt'`, verified unchanged this session) and does not explain edge-level `cf-cache-status: HIT` on a fresh, uncached browser context anyway.
- `run_worker_first` failing to route requests through the Worker — confirmed via direct documentation research that `run_worker_first: true` does unconditionally invoke the Worker script first; the Worker's header rewrite genuinely executes on every request.

## What could not be fully proven from documentation

Whether the specific in-Worker mitigation added in this pass (`cf.cacheTtl: 0`, `cf.cacheEverything: false` on the request passed to `env.ASSETS.fetch()`) actually changes Workers Static Assets' internal caching decision. This is a real, honest limitation:
- Cloudflare's own docs describe these `cf` options as governing a Worker's **outbound** `fetch()` calls to arbitrary origins — their effect on the ASSETS binding specifically (a different, internal fetch mechanism) is not documented.
- `wrangler dev` (Miniflare, local emulation) reports `CF-Cache-Status: HIT` **unconditionally**, confirmed by testing a nonexistent asset path locally and observing the identical simulated header regardless of these options — meaning **local testing cannot validate whether this mitigation has any real effect on Cloudflare's actual production edge**. This is disclosed here rather than silently assumed to work.

Given that gap, this code change is **defense-in-depth**, not the claimed authoritative fix. It is zero-risk (touches only non-`/assets/*` request construction, verified via 12 passing Worker-runtime tests that nothing else regressed) and may or may not have a real effect on the actual bug.

## The actual proposed authoritative fix (requires owner review before creation)

A **Cloudflare Cache Rule** at the zone level: **Bypass cache** for all requests except `/assets/*`. This is the one mechanism in this investigation that:
- Operates at Cloudflare's true edge cache-decision layer, which sits **above** both the Worker and the Static Assets serving pipeline in the request-handling order — a Cache Rule's bypass decision is made before either of those ever gets a chance to populate or serve from cache, regardless of any header either of them sets.
- Is unambiguously documented (`developers.cloudflare.com/cache/how-to/cache-rules/settings/`: "select Bypass cache if you want matching incoming requests to not be cached").
- Is confirmed available and creatable on this exact zone (`mal3aby.app`) on the Free plan — the Cache Rules dashboard page is live and functional, currently showing `0 active` rules, not gated behind a paid tier.
- Was **not created during this investigation** — this is a live, immediate, production-affecting zone configuration change, and per this session's standing rule, any such change requires the owner's explicit authorization at the moment of the action, not blanket authorization from an investigation mandate. It is documented here precisely so it can be reviewed and, if approved, created as part of the authorized release step.

**Proposed rule (exact configuration for owner review):**
- **When incoming requests match:** `not starts_with(http.request.uri.path, "/assets/")` — i.e., everything except the hashed assets directory. (Corrected 2026-09-06 by independent review: the Rules Language calls `starts_with()` as a function with the field as its first argument — `starts_with(field, substring)` — negated with the `not` operator, never as dot-notation method syntax or `eq false`. Verified against Cloudflare's own Rules Language functions reference before finalizing this expression.)
- **Then:** Cache eligibility → **Bypass cache**.
- **Zone:** `mal3aby.app` only.
- **Before creating**: paste the expression into the dashboard's own expression editor first — it validates syntax live and will reject anything it cannot parse, giving one more independent confirmation before this takes effect on production traffic.

This deliberately leaves `/assets/*` completely untouched by this rule — hashed assets keep Cloudflare's normal, efficient caching behavior (governed by the existing `public, max-age=31536000, immutable` header from `cacheControlFor()`), since a Bypass rule only needs to apply to the paths that must never be edge-stale.

## Old HTML policy vs. new HTML policy

| | Old | New |
|---|---|---|
| Worker response header | `Cache-Control: no-store` | Unchanged — still `no-store` (correct, kept as defense-in-depth for any client/proxy that does respect it) |
| Internal `env.ASSETS.fetch()` request | No `cf` cache directives set | `cf.cacheTtl: 0`, `cf.cacheEverything: false` (defense-in-depth, real-world effect unproven — see above) |
| Zone-level Cache Rule | None (0 active) | **Proposed**: Bypass cache for all non-`/assets/*` paths (requires owner authorization to create) |
| Observed real-world result | Edge served stale HTML for an unbounded period after 2 of the last 2 deploys, requiring manual Purge Everything each time | **Cannot be marked resolved until the production acceptance test below passes without any purge** |

## Cache matrix

| Resource Type | Browser Policy | Edge Policy | Reason |
|---|---|---|---|
| HTML (`/`, SPA-fallback routes, any non-`/assets/*` path) | `no-store` — browser must always refetch | Proposed Cache Rule: Bypass (never cached at edge); Worker header: `no-store` (defense-in-depth) | Discovers new hashed asset references on every deploy; must never be stale even briefly |
| Hashed JS (`/assets/*.js`) | `public, max-age=31536000, immutable` | Normal Cloudflare caching (long-lived) — unaffected by the proposed Cache Rule | Filename changes on every content change; safe to cache forever |
| Hashed CSS (`/assets/*.css`) | Same as hashed JS | Same as hashed JS | Same reason |
| `workbox-<hash>.js` (Workbox runtime, dist/ root) | Same as hashed JS | Same as hashed JS | Independent-review finding (2026-09-06): this file has its own genuine content hash (confirmed real in a build: `workbox-98f7a950.js`) despite living outside `/assets/`; previously misclassified as mutable purely by path. `sw.js` itself (which references this file by its exact hashed name) correctly stays `no-store` |
| `manifest.webmanifest` | `no-store` | Proposed Cache Rule: Bypass | Not content-hashed; referenced by the app shell, must reflect the current build |
| `sw.js` (service worker script) | `no-store` | Proposed Cache Rule: Bypass | Governs which app-shell version a returning client's browser activates; must never be edge-stale, independent of the (already-correct) `registerType: 'prompt'` install/activate lifecycle |
| Icons/fonts served from `public/` root (non-hashed) | `no-store` (current, conservative default — same branch as HTML) | Proposed Cache Rule: Bypass (same branch) | Not content-hashed; a future icon change should show up promptly. Could be made cacheable with a short/moderate TTL later if traffic patterns justify it, but no evidence currently demands that optimization, and the mission scope is fixing staleness, not squeezing extra cache-hit-rate out of low-traffic static files |
| `robots.txt`/`sitemap.xml` if present | `no-store` (same branch as HTML) | Same | Same reasoning as icons |

## PWA / service worker — verified NOT an independent cause

- `registerType: 'prompt'` (not `'autoUpdate'`) confirmed still in place in `vite.config.ts`, unchanged since the 2026-08-27 fix.
- This mode does not auto-inject `skipWaiting()`/`clientsClaim()` into the generated service worker — a new SW installs and waits until `PwaUpdatePrompt.tsx`'s explicit `updateServiceWorker(true)` call activates it.
- `sw.js` itself already receives `Cache-Control: no-store` from the existing `cacheControlFor()` branch (everything not under `/assets/*`), confirmed by the new Worker-runtime test suite (`src/index.test.ts`, "the service worker script receives no-store").
- **Conclusion**: the PWA/service-worker layer is not contributing to this specific recurrence. It was already correctly fixed in a prior pass and remains correct.

## Single source of cache policy

- **HTML / SPA fallback**: `cloudflare/frontend-worker/src/index.ts`'s `cacheControlFor()` (outbound header) + the proposed Cache Rule (edge decision, authoritative). No `_headers` file exists in this project (Workers Static Assets uses `wrangler.jsonc`'s `assets` block instead, confirmed — this is not a Cloudflare Pages project).
- **Hashed assets**: same `cacheControlFor()` function, `/assets/*` branch.
- **Mutable non-hashed assets**: same function, same `no-store` branch as HTML (grouped together deliberately — see cache matrix above).
- **PWA/service worker update lifecycle**: `vite.config.ts`'s `VitePWA({ registerType: 'prompt', ... })` config, paired with `src/app/PwaUpdatePrompt.tsx`'s explicit user-gated activation. Independent of, and does not conflict with, the HTTP-cache-layer fixes above.
- No Cache Rules, Page Rules, or Workers Cache API (`caches.default`) usage exists anywhere else in this codebase or zone that could contradict the above — confirmed by direct dashboard inspection (both rule types at `0 active`) and a full repo grep for `caches.default`/`cache.put`/`cache.match` (no matches).

## Deployment invariant

**A successful frontend deployment must NOT require manual Purge Everything for the plain `https://mal3aby.app/` URL to discover the new release.** This has been true in aspiration since 2026-08-27 and false in practice twice since. It is not considered actually true again until the production acceptance test in this mission's PRE-RELEASE report passes for real, on real production traffic, with no purge performed.

## Files changed

- `cloudflare/frontend-worker/src/index.ts` — added `isImmutableHashedAsset()` (covers both `/assets/*` and root-level `workbox-<hash>.js`), `assetsFetchInit()`/`shouldBypassAssetCache()`, wired into the `env.ASSETS.fetch()` call.
- `cloudflare/frontend-worker/vitest.config.mts` (new) — Workers-runtime test configuration.
- `cloudflare/frontend-worker/src/index.test.ts` (new) — 17 cache-contract tests running inside real Miniflare, asserting actual `Response` header/status/body behavior, including every real non-hashed `dist/` root file (`favicon.svg`, `icons.svg`, `manifest.webmanifest`, `sw.js`) and the hashed `workbox-<hash>.js` runtime file.
- `cloudflare/frontend-worker/package.json` — added `@cloudflare/vitest-pool-workers`, `vitest` as dev dependencies; added a `test` script.
- This document.

**Independent review**: a fresh reviewer (did not implement this change) ran the full test suite, deliberately broke the fix to confirm the tests catch regressions, and researched Cloudflare's Rules Language directly. Found and this pass fixed: (1) the originally-proposed Cache Rule expression used invalid syntax (`field.starts_with(...) eq false` — dot-notation method calls are not valid Rules Language; corrected to `not starts_with(http.request.uri.path, "/assets/")`, the documented function-call form); (2) `workbox-<hash>.js` was a real, genuinely content-hashed file this build produces that the original policy misclassified as mutable purely by path — fixed via `isImmutableHashedAsset()`, with 5 new tests covering it and the other real non-hashed root files.

**Not created in this pass** (documented above as the proposed authoritative fix, pending owner authorization): the zone-level Cache Rule.
