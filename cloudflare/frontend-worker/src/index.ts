// Minimal Worker wrapping Cloudflare Workers Static Assets purely to inject
// security headers on every response. There is no other server-side logic
// here -- all real business logic/authorization remains in Supabase
// RLS/RPCs, unchanged. This file exists ONLY because static-assets-only
// config (no "main") has no request-time hook to add headers from.
//
// CSP is scoped to what this SPA actually needs: its own origin for
// scripts/styles (Vite bundles everything, no inline scripts), the
// Supabase project origin for API/auth/storage calls, and 'unsafe-inline'
// for styles only (Tailwind + some component libraries inject inline
// style attributes at runtime -- confirmed necessary by testing, not
// assumed). No third-party ad/analytics/font-CDN origins are allowed.

export interface Env {
  ASSETS: Fetcher
  SUPABASE_URL: string
}

// CACHE-CONTROL FIX (2026-08-27, production auth-refresh + stale-cache
// bugfix directive): Cloudflare Workers Static Assets' own default
// Cache-Control was confirmed live (real production response headers,
// not assumed) to be `public, max-age=0, must-revalidate` on EVERY
// response -- index.html, the hashed JS/CSS bundles, sw.js, and the
// manifest alike. `must-revalidate` on its own is not the stale-content
// bug (a conditional GET still fetches fresh content when the browser
// bothers to revalidate) -- the real bug was the service worker's
// unconditional skipWaiting()/clientsClaim() (see vite.config.ts's own
// comment on that). But this undifferentiated policy is still a real,
// separate defect: content-hashed assets (index-<hash>.js, the CSS
// bundle, any other /assets/* file) are IMMUTABLE by construction --
// a new deploy always produces a new filename, so there is zero reason
// to ever revalidate an already-cached hashed asset, and doing so on
// every load wastes a round-trip for every single asset on every page
// load. index.html/sw.js/the manifest are the opposite: they must
// NEVER be aggressively cached, since they're what a client uses to
// discover which hashed assets to request next.
//
// CORRECTION found live post-deploy: `no-cache` alone was NOT enough
// on this zone. Real Cloudflare documentation (developers.cloudflare.com
// /cache/concepts/cache-control/, confirmed via search, not assumed):
// "When setting `no-cache` with Origin Cache Control on, Cloudflare
// caches and always revalidates." Free/Pro/Business plans (this
// project is on Free, confirmed earlier this session) have Origin
// Cache Control ON by default -- so `no-cache` still lets Cloudflare's
// edge KEEP a cached copy and serve it while "revalidating", which in
// practice was observed live, immediately after deploying this exact
// fix: a bare `fetch('/', {cache:'no-store'})` (cache:'no-store' only
// controls the BROWSER's own cache, not Cloudflare's edge) kept
// returning `cf-cache-status: HIT` with the PREVIOUS deploy's HTML/JS
// reference for a period after the new deploy went live. This project
// has no cache-purge tool/API token available in this environment, so
// the fix must not depend on ever needing a manual purge again.
//
// `no-store` is unambiguous in Cloudflare's own default-cache-behavior
// docs: "Cloudflare does not cache the resource when: the Cache-Control
// header is set to ... no-store ..." -- regardless of Origin Cache
// Control. This is the correct, purge-independent directive for
// content that must never be edge-stale even for a moment.
//
//   /assets/*  (Vite's hashed output directory): immutable, 1 year --
//     unaffected by this correction, hashed filenames make revalidation
//     pointless regardless of edge caching semantics.
//   everything else (index.html, sw.js, manifest.webmanifest, icons
//     served from the public/ root, and the SPA-fallback index.html
//     Workers Static Assets serves for any unmatched path): no-store.
function cacheControlFor(pathname: string): string {
  if (pathname.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable'
  }
  return 'no-store'
}

function securityHeaders(supabaseUrl: string): Record<string, string> {
  const supabaseOrigin = new URL(supabaseUrl).origin
  return {
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      `connect-src 'self' ${supabaseOrigin} wss://${new URL(supabaseUrl).host}`,
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  }
}

// www must never become an independent site -- both mal3aby.app and
// www.mal3aby.app are bound as Custom Domains to this SAME Worker (see
// wrangler.jsonc), and this is the one piece of logic that keeps them
// from silently diverging into two origins: any request arriving on
// the www host gets a permanent redirect to the apex, preserving the
// original path/query. 308 (not 301) so a non-GET request's method and
// body are preserved across the redirect, per the HTTP spec's actual
// distinction between the two -- there is no real reason a canonical
// hostname redirect should ever downgrade a POST to a GET.
const WWW_HOST = 'www.mal3aby.app'
const APEX_HOST = 'mal3aby.app'

// PRODUCTION MONITORING (Phase 3, 2026-08-28): client-error beacon.
//
// Frontend errors (React render errors caught by ErrorBoundary, and
// standalone window 'error'/'unhandledrejection' events -- see
// src/lib/errorReporting.ts and src/components/ui/error-boundary.tsx)
// happen in the BROWSER. Workers Logs (the observability block above)
// only captures what happens INSIDE this Worker's own fetch handler --
// it has no visibility into browser-side JS at all, confirmed via
// Cloudflare doc search this session (Workers Logs = "logging data
// emitted from Cloudflare Workers", not from arbitrary web clients).
// The only way to get a browser-side error INTO Workers Logs without a
// third-party service is to have the browser POST a small sanitized
// report to this same-origin Worker route and log it here with
// console.error -- which Workers Logs already captures for free. That
// is exactly what this route does; nothing more.
//
// Deliberately minimal and fail-safe:
//   - same-origin only (this route is same-origin per the CSP's
//     connect-src 'self'; no CORS headers are added, so a
//     cross-origin page cannot use this as an open beacon)
//   - hard body-size cap (this Worker does no auth, so it must not
//     become an amplification/storage-abuse vector)
//   - a strict allow-list of fields, each independently length-capped
//     and coerced to string -- mirrors the sanitize*Error() discipline
//     already established across every payment gateway Edge Function
//     (never forward an arbitrary/attacker-shaped object into a log)
//   - never throws back to the caller on a malformed body -- a broken
//     error reporter must never itself become a second error the user
//     sees; always returns 204 (or 400 only for wrong method/content-type)
//   - no PII field exists in the accepted shape at all (no name/email/
//     phone/free-text-message-body -- just IDs, a build SHA, a URL
//     path, and a capped error message/stack)
const CLIENT_ERROR_MAX_BODY_BYTES = 8_192
const CLIENT_ERROR_FIELD_MAX_CHARS = 2_000

function capString(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…[truncated]` : trimmed
}

interface ClientErrorReport {
  incident_id: string
  message: string
  build_sha: string | null
  path: string | null
  stack: string | null
  component_stack: string | null
  source: string | null
}

function parseClientErrorReport(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const incidentId = capString(b.incident_id, 100)
  const message = capString(b.message, 500)
  // incident_id/message are the only two fields treated as required --
  // everything else degrades to null rather than rejecting the report,
  // since a partial report is still more useful than none.
  if (!incidentId || !message) return null
  return {
    incident_id: incidentId,
    message,
    build_sha: capString(b.build_sha, 100),
    path: capString(b.path, 300),
    stack: capString(b.stack, CLIENT_ERROR_FIELD_MAX_CHARS),
    component_stack: capString(b.component_stack, CLIENT_ERROR_FIELD_MAX_CHARS),
    source: capString(b.source, 50),
  }
}

async function handleClientErrorBeacon(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }

  const contentLength = request.headers.get('Content-Length')
  if (contentLength && Number(contentLength) > CLIENT_ERROR_MAX_BODY_BYTES) {
    return new Response(null, { status: 413 })
  }

  let raw: string
  try {
    // Read with an explicit cap even when Content-Length is absent/lied
    // about -- a streamed body without a (correct) Content-Length must
    // not be trusted to self-limit.
    const buf = await request.arrayBuffer()
    if (buf.byteLength > CLIENT_ERROR_MAX_BODY_BYTES) {
      return new Response(null, { status: 413 })
    }
    raw = new TextDecoder().decode(buf)
  } catch {
    return new Response(null, { status: 204 })
  }

  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(raw)
  } catch {
    return new Response(null, { status: 204 })
  }

  const report = parseClientErrorReport(parsedBody)
  if (!report) {
    return new Response(null, { status: 204 })
  }

  // Structured console.error -- lands in Workers Logs as a real error-
  // level entry, filterable there via `$metadata.error EXISTS` (per
  // Cloudflare's own documented filter for this exact case) or by
  // searching for "client_error_report"/a specific incident_id. Nothing
  // here is a secret, a raw provider response, or PII -- same standard
  // every gateway sanitize*Error() helper already enforces.
  console.error('client_error_report', {
    incident_id: report.incident_id,
    message: report.message,
    build_sha: report.build_sha,
    path: report.path,
    stack: report.stack,
    component_stack: report.component_stack,
    source: report.source,
  })

  return new Response(null, { status: 204 })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.hostname === WWW_HOST) {
      url.hostname = APEX_HOST
      return Response.redirect(url.toString(), 308)
    }

    if (url.pathname === '/api/client-error') {
      return handleClientErrorBeacon(request)
    }

    const response = await env.ASSETS.fetch(request)
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(securityHeaders(env.SUPABASE_URL))) {
      headers.set(key, value)
    }
    headers.set('Cache-Control', cacheControlFor(url.pathname))
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },
} satisfies ExportedHandler<Env>
