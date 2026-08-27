// VERSION VISIBILITY (2026-08-27, production auth-refresh + stale-cache
// bugfix directive, item D): __MAL3ABY_BUILD_SHA__/__MAL3ABY_BUILD_TIME__
// are compile-time constants injected by vite.config.ts's `define` block
// (the real git commit + wall-clock time this specific dist/ build was
// produced from) -- not runtime values, not secrets, safe to ship in the
// public bundle. This is the one place the app reads them, so every
// consumer (the Settings page footer, the browser console log below, any
// future debug surface) stays in sync automatically.
declare const __MAL3ABY_BUILD_SHA__: string
declare const __MAL3ABY_BUILD_TIME__: string

export const BUILD_SHA = __MAL3ABY_BUILD_SHA__
export const BUILD_TIME = __MAL3ABY_BUILD_TIME__

// Logged once at module load (not on every render) so opening devtools
// on a live tab is enough to answer "is this browser actually running
// the newest build" without hunting through the UI -- the exact
// diagnostic need item D exists to serve.
// eslint-disable-next-line no-console
console.info(`[Mal3aby] build ${BUILD_SHA} (${BUILD_TIME})`)
