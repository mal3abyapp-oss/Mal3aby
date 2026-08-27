# Frontend Cache & Update Strategy

Root-cause record and fix for the "deployed updates hidden until manual cache clear" production report, investigated and fixed 2026-08-27.

## Root cause #1 (the real bug): service worker silently force-swapped code on every deploy

`vite.config.ts` set `registerType: 'autoUpdate'`. This project's own prior code comment on that line claimed *"silent skipWaiting()/clientsClaim() was deliberately NOT used here"* — that claim was true of the hand-written `src/app/PwaUpdatePrompt.tsx` UI, but not of what the build actually produced.

Confirmed by reading `vite-plugin-pwa`'s own source (`node_modules/vite-plugin-pwa/dist/index.js`, the `registerType` handling): `registerType: 'autoUpdate'` unconditionally sets `workbox.skipWaiting = true` and `workbox.clientsClaim = true` on the **generated** service worker — a build-time injection independent of anything `PwaUpdatePrompt.tsx` does at runtime. Confirmed live against the actual deployed `https://mal3aby.app/sw.js` before the fix: its compiled body called `self.skipWaiting()` and `clientsClaim()` unconditionally at top level.

**Effect**: every new deploy's service worker installed and took over every open tab's network requests immediately and silently. `PwaUpdatePrompt.tsx`'s "new version available — reload" toast had nothing meaningful left to prompt for by the time a user would see it, because the swap had already happened. A tab left open across a deploy could have its active service worker (and therefore its resolution of `index.html`/assets) change out from under it mid-session with zero visible warning — also a plausible contributor to intermittent refresh-related session symptoms, since a mid-navigation SW takeover can race the app's own hydration.

**Fix**: `registerType: 'prompt'` (`vite-plugin-pwa`'s own default). This does **not** auto-inject `skipWaiting`/`clientsClaim` — the new service worker now installs and waits (Workbox's normal, safe behavior) until an explicit `postMessage({type: 'SKIP_WAITING'})` activates it, which is exactly what `PwaUpdatePrompt.tsx`'s `updateServiceWorker(true)` call sends when the user clicks "Reload." No change was needed to `PwaUpdatePrompt.tsx` itself — it was already written correctly for `'prompt'` semantics (60s periodic `update()` polling, a `visibilitychange` re-check, explicit reload-on-click); it was only ever paired with the wrong `registerType`.

**Verified**: rebuilt `dist/sw.js` was confirmed to only call `self.skipWaiting()` inside a `message` event listener gated on `data.type === 'SKIP_WAITING'` — never unconditionally.

## Root cause #2: Cloudflare's zone-level cache did not treat `no-cache` as "never cache" on this plan

After fixing #1, real production response headers (checked directly, not assumed) showed Cloudflare Workers Static Assets applying the same `Cache-Control: public, max-age=0, must-revalidate` to **every** response alike — `index.html`, hashed JS/CSS, `sw.js`, and the manifest. This is inefficient for hashed assets (which are immutable by filename construction and gain nothing from ever revalidating) but on its own is not the staleness bug, since `must-revalidate` should still fetch fresh content on the next check.

Fixed via `cloudflare/frontend-worker/src/index.ts` (the one request-time hook available in this static-assets-only Worker setup), differentiating:
- `/assets/*` (Vite's hashed output directory) → `public, max-age=31536000, immutable`
- everything else (`index.html`, `sw.js`, `manifest.webmanifest`, the SPA-fallback `index.html`) → initially set to `no-cache, must-revalidate`

**This first fix was insufficient**, discovered live immediately after deploying it: real Cloudflare documentation (`developers.cloudflare.com/cache/concepts/cache-control/`, confirmed via direct doc search, not assumed) states *"When setting `no-cache` with Origin Cache Control on, Cloudflare caches and always revalidates."* Free/Pro/Business plans (this project is on Free — confirmed earlier this session) have **Origin Cache Control on by default**. So `no-cache` still let Cloudflare's edge keep and serve a cached copy while nominally "revalidating" — observed live via a bare `fetch('/')` that kept returning `cf-cache-status: HIT` with the *previous* deploy's HTML/JS reference, reproducing the exact reported symptom in real time immediately after the supposed fix went live.

**Final fix**: switched `index.html`/`sw.js`/manifest/SPA-fallback from `no-cache` to **`no-store`**, which Cloudflare's own default-cache-behavior docs confirm is never cached regardless of Origin Cache Control. `/assets/*` keeps its immutable 1-year policy, unaffected.

```ts
function cacheControlFor(pathname: string): string {
  if (pathname.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable'
  }
  return 'no-store'
}
```

## The one-time residue: a manual purge was required

`no-store` prevents Cloudflare from caching a response **going forward** — it does not retroactively invalidate an entry Cloudflare had already cached under the *old* `max-age=0, must-revalidate` policy from before this fix deployed. Live testing after the code fix (and after a fresh redeploy) still showed at least one edge location (Marseille, `-MRS`) serving a byte-identical stale response — same `cf-ray`, same `Date` header — to every new client, including a brand-new browser tab that had never touched the app before (ruling out browser-side caching).

No cache-purge API token/credential was available in this environment to clear it programmatically. Two purge mechanisms were researched and ruled out:
- **`ctx.cache.purge()`** — this is a *separate* opt-in "Workers Caching" layer (requires an explicit `cache: {enabled: true}` block in `wrangler.jsonc`, not present in this project) and would not have touched the actual stale zone-cache entry.
- **Zone-level Purge Cache API** — requires a Cloudflare API token with cache-purge permission on this zone; none was available.

**Resolved**: the user performed a manual "Purge Everything" via the Cloudflare dashboard (Caching → Configuration → Purge Cache). Verified immediately after via two independent, direct HTTP requests (bypassing any session-local testing infrastructure) — both returned a fresh `Date`, a new `cf-ray`, `Cache-Control: no-store`, and the current build's JS bundle reference. Real production traffic is confirmed unaffected by this residue going forward, and — because the fix is `no-store`, not merely a shorter TTL — this specific failure mode (a deploy's `index.html` getting stuck cached at the edge) cannot recur; no future deploy will ever need another manual purge for this reason.

## Version visibility

Added a lightweight, build-time-only version identifier (`src/lib/version.ts`, wired via `vite.config.ts`'s `define` block): the real git commit SHA and build timestamp the running `dist/` was produced from, embedded as compile-time constants (no secrets, no runtime computation). Logged once to the browser console on app load, and shown quietly in the Settings page footer. This is what makes "is this browser actually running the newest build" answerable without guessing — check the console log or Settings footer against `git rev-parse --short HEAD` on `main`.

## Summary of files changed

- `vite.config.ts` — `registerType: 'autoUpdate'` → `'prompt'`; added the build-SHA/build-time `define` block.
- `cloudflare/frontend-worker/src/index.ts` — added `cacheControlFor()`, differentiated `no-store`/`immutable` Cache-Control, applied on every response.
- `src/lib/version.ts` (new) — reads and logs the build constants.
- `src/main.tsx` — imports `./lib/version` once on load.
- `src/features/settings/SettingsPage.tsx` — shows the build version footer.
- `src/lib/i18n/resources/{en,ar}/common.json` — `settings.buildVersion` translation key.

No changes were made to `PwaUpdatePrompt.tsx` (already correct) or to the Workbox `runtimeCaching` rule for Supabase API calls (`NetworkOnly` — unaffected by any of this, and correct: API responses must never be served from a stale service-worker cache).
