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
//   /assets/*  (Vite's hashed output directory): immutable, 1 year --
//     hashed filenames make revalidation pointless regardless of edge
//     caching semantics.
//   workbox-<hash>.js (independent-review finding, 2026-09-06): this
//     Workbox-generated runtime file also carries a genuine content
//     hash in its OWN filename (confirmed live in a real `dist/`
//     build: workbox-98f7a950.js), the exact same immutability
//     property as /assets/* -- a content change always produces a new
//     hash/filename -- but it is written to the dist/ ROOT (Vite's
//     PWA plugin output location, not the assets/ subdirectory), so it
//     was previously falling into the `no-store` branch below purely
//     because of its path, not its actual (im)mutability. sw.js itself
//     (which references this file by its exact hashed name, the same
//     way index.html references hashed /assets/* files) correctly
//     stays no-store below -- only the hashed runtime file it points
//     to is safe to cache long-term.
//   everything else (index.html, sw.js, manifest.webmanifest, icons
//     served from the public/ root, and the SPA-fallback index.html
//     Workers Static Assets serves for any unmatched path): no-store.
function isImmutableHashedAsset(pathname: string): boolean {
  return pathname.startsWith('/assets/') || /^\/workbox-[0-9a-f]+\.js$/.test(pathname)
}

function cacheControlFor(pathname: string): string {
  if (isImmutableHashedAsset(pathname)) {
    return 'public, max-age=31536000, immutable'
  }
  return 'no-store'
}

// ROOT-CAUSE REMEDIATION (2026-09-06): the `no-store` fix above was
// necessary but NOT sufficient -- it correctly controls what
// Cache-Control value the CLIENT sees on the outbound response, but
// this recurred live TWICE more after that fix shipped (2026-09-05,
// 2026-09-06), each time confirmed via direct production header
// inspection: `cf-cache-status: HIT` alongside `cache-control:
// no-store` on the SAME response, with an identical `Date`/`ETag`
// across repeated requests (including ones with different, unique
// query strings) minutes apart. That combination is only possible if
// Cloudflare's edge cached this exact response BEFORE this Worker's
// `headers.set('Cache-Control', ...)` line ever ran, or if the
// Workers Static Assets serving pipeline (env.ASSETS.fetch()) performs
// its own automatic edge caching independently of the final
// Cache-Control header the wrapping Worker returns to the client --
// Cloudflare's own docs describe "automatic caching for static assets
// across its network" as a first-class feature of Static Assets
// itself, separate from standard Cache-Control-driven caching, but do
// not document its exact precedence relative to a wrapping Worker's
// header rewrite (confirmed via direct doc research this session --
// this precise interaction is not covered).
//
// Given that gap, this applies EVERY defense-in-depth lever Cloudflare
// documents for a Worker to influence caching of its own internal
// fetch(), on top of (not instead of) the existing outbound-header
// fix: `cf.cacheTtl: 0` and `cf.cacheEverything: false` on the REQUEST
// object passed into env.ASSETS.fetch() for any non-hashed-asset path,
// so the internal fetch itself is marked non-cacheable at the point
// Cloudflare's edge makes its caching decision, not only on the
// resulting client-facing response headers.
//
// This is still not a complete fix on its own -- see
// docs/design-remediation/FRONTEND_CACHE_ROOT_CAUSE.md for the full
// evidence trail and why a zone-level Cache Rule (bypass cache for all
// non-/assets/* paths) is the actual authoritative mechanism proposed
// alongside this code change, since Cache Rules operate at Cloudflare's
// true edge cache-decision layer, upstream of both the Worker and the
// Static Assets serving pipeline -- unlike this in-Worker mitigation,
// whose effect on Workers Static Assets' specific internal caching
// behavior is not fully documented and could not be exhaustively
// proven from documentation alone.
function shouldBypassAssetCache(pathname: string): boolean {
  return !isImmutableHashedAsset(pathname)
}

function assetsFetchInit(pathname: string): RequestInit {
  if (!shouldBypassAssetCache(pathname)) return {}
  return {
    cf: {
      cacheTtl: 0,
      cacheEverything: false,
    },
  } as RequestInit
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

    const response = await env.ASSETS.fetch(request, assetsFetchInit(url.pathname))
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
