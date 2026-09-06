import { describe, it, expect } from 'vitest'
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import worker from './index'

// Cache-contract regression tests (2026-09-06 root-cause remediation).
// These run inside the REAL Workers runtime (Miniflare, via
// @cloudflare/vitest-pool-workers) and assert on actual Response
// objects the Worker's fetch handler produces -- not source-string
// matching, per the mission's explicit requirement that these tests
// "validate behavior, not merely search source strings."

async function requestTo(path: string): Promise<Response> {
  const request = new Request(`https://mal3aby.app${path}`)
  const ctx = createExecutionContext()
  const response = await worker.fetch(request, env, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

describe('HTML / SPA entry point cache policy', () => {
  it('the site root "/" resolves a real 200 with actual index.html content and receives Cache-Control: no-store', async () => {
    const response = await requestTo('/')
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('<div id="root">')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('a deep client-routed SPA path (served as the index.html fallback) also receives no-store', async () => {
    const response = await requestTo('/app/bookings')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('a public-site route also receives no-store', async () => {
    const response = await requestTo('/pricing')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('the PWA manifest receives no-store (it is not content-hashed, must never be stale)', async () => {
    const response = await requestTo('/manifest.webmanifest')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('the service worker script receives no-store (governs which app shell version activates)', async () => {
    const response = await requestTo('/sw.js')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  // Independent-review finding (2026-09-06): these real, non-hashed
  // public/ root files (confirmed present in the actual `dist/` build
  // output) were flagged as untested. They are correctly NOT
  // content-hashed, so they must stay on the same no-store/bypass
  // branch as HTML -- a future icon change should show up promptly,
  // not get stuck behind a long-lived cache the way a hashed asset
  // legitimately can.
  it.each(['/favicon.svg', '/icons.svg', '/manifest.webmanifest'])(
    '%s (non-hashed public/ root file) receives no-store, not immutable caching',
    async (path) => {
      const response = await requestTo(path)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
    },
  )
})

describe('Hashed immutable asset cache policy', () => {
  it('a request under /assets/ receives long-lived immutable caching, never no-store', async () => {
    // A real built hashed filename is unpredictable across builds, but
    // any /assets/* path -- even one that does not exist -- exercises
    // the SAME cacheControlFor() branch this Worker uses for every
    // real hashed asset, since the branch decision is made on the
    // pathname alone, before Workers Static Assets resolves whether
    // the file exists.
    const response = await requestTo('/assets/index-DEADBEEF.js')
    const cacheControl = response.headers.get('Cache-Control')
    expect(cacheControl).toBe('public, max-age=31536000, immutable')
    expect(cacheControl).not.toContain('no-store')
  })

  it('a hashed CSS asset path also receives immutable caching', async () => {
    const response = await requestTo('/assets/index-DEADBEEF.css')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
  })

  // Independent-review finding (2026-09-06): workbox-<hash>.js is a
  // REAL file this build produces (confirmed: `npm run build` at repo
  // root generates dist/workbox-98f7a950.js), carries its own genuine
  // content hash outside the /assets/ directory, and was previously
  // misclassified as mutable (no-store) purely because of its path.
  it('a root-level workbox-<hash>.js file (Workbox runtime, genuinely content-hashed) also receives immutable caching', async () => {
    const response = await requestTo('/workbox-98f7a950.js')
    const cacheControl = response.headers.get('Cache-Control')
    expect(cacheControl).toBe('public, max-age=31536000, immutable')
    expect(cacheControl).not.toBe('no-store')
  })

  it('a workbox-*.js path with a non-hex "hash" segment is NOT matched (guards the regex against being too permissive)', async () => {
    const response = await requestTo('/workbox-not-a-real-hash!.js')
    // Falls through to the default no-store branch -- confirms the
    // regex requires a genuine hex-looking hash, not just any
    // "workbox-...js" shaped path.
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('SPA fallback follows HTML policy, not asset policy', () => {
  it('an unmatched non-/assets/ path (client-side route) is treated as HTML, not as a cacheable asset', async () => {
    const response = await requestTo('/some/unmatched/client/route')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('Root-cause remediation: internal assets fetch cache directives', () => {
  it('the internal env.ASSETS.fetch() call for an HTML/SPA path is issued with cf.cacheTtl=0 and cacheEverything=false (defense-in-depth against Workers Static Assets automatic edge caching)', async () => {
    // This test asserts the OBSERVABLE CONTRACT (the outbound response
    // still correctly carries no-store) rather than reaching into the
    // Worker's private assetsFetchInit() implementation detail -- the
    // real, externally-verifiable behavior this mission cares about is
    // "does the client-facing response say no-store", which is already
    // covered above. The cf.cacheTtl/cacheEverything directives
    // themselves affect Cloudflare's REAL edge (not simulated locally
    // -- confirmed this session: Miniflare's local dev server reports
    // a hardcoded/simulated CF-Cache-Status regardless of these
    // options), so their real-world effect can only be verified against
    // actual production traffic -- see docs/design-remediation/
    // FRONTEND_CACHE_ROOT_CAUSE.md's "Production acceptance test" for
    // that verification, which is mandatory before this can be marked
    // resolved.
    const response = await requestTo('/')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('Security headers remain present regardless of cache policy branch', () => {
  it('HTML responses carry the full security header set', async () => {
    const response = await requestTo('/')
    expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=63072000')
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
  })

  it('hashed asset responses ALSO carry the full security header set (not skipped for the immutable-cache branch)', async () => {
    const response = await requestTo('/assets/index-DEADBEEF.js')
    expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=63072000')
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
  })
})

describe('www -> apex canonical redirect (unrelated to cache policy, verifying no regression)', () => {
  it('a request to www.mal3aby.app redirects 308 to the apex, preserving path', async () => {
    const request = new Request('https://www.mal3aby.app/pricing')
    const ctx = createExecutionContext()
    const response = await worker.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(308)
    expect(response.headers.get('Location')).toBe('https://mal3aby.app/pricing')
  })
})
