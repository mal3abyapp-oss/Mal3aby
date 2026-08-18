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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.hostname === WWW_HOST) {
      url.hostname = APEX_HOST
      return Response.redirect(url.toString(), 308)
    }

    const response = await env.ASSETS.fetch(request)
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(securityHeaders(env.SUPABASE_URL))) {
      headers.set(key, value)
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },
} satisfies ExportedHandler<Env>
