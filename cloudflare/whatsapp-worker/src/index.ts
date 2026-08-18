import { WhatsAppAccountObject, getAccountObject, type Env } from './WhatsAppAccountObject.js'

export { WhatsAppAccountObject }

/**
 * Worker entrypoint -- this is the ONLY piece of this architecture with
 * a public-facing route (aside from the frontend itself, deployed
 * separately). Per directive rule 26 ("no bare public container
 * exposure without cause") and rule 27 ("internal binding / secure
 * routing between Worker and Container"), the container is NEVER
 * reachable directly from the internet -- every request here either:
 *   (a) is a management/orchestration call, authorized by an internal
 *       admin token (this Worker's own secret, distinct from the
 *       per-account CONTAINER_INTERNAL_TOKEN the Container itself
 *       checks), or
 *   (b) is a public, unauthenticated health probe returning ONLY
 *       ok/degraded/down (directive rule 25 -- no detail leak).
 *
 * The actual WhatsApp connector process has NO route to it from this
 * Worker for message content, tokens, or session data at all -- it
 * never needed one even before Cloudflare (see whatsapp-connector's
 * own index.ts: "no inbound HTTP server ... only ever calls OUT to
 * Supabase"). This Worker's job is exclusively container lifecycle: is
 * this club's connector supposed to be running, and if so, is it
 * healthy.
 */

function unauthorized(): Response {
  return new Response('unauthorized', { status: 401 })
}

const textEncoder = new TextEncoder()

/**
 * Constant-time comparison for the Management API token. Unlike
 * CONTAINER_INTERNAL_TOKEN (internal Worker<->Container routing only),
 * /manage/* is this architecture's ONE genuinely public-internet-facing
 * route -- a timing side-channel here is a real, not merely
 * theoretical, threat surface. Uses the Workers runtime's native
 * crypto.subtle.timingSafeEqual (documented Cloudflare pattern), and
 * -- per that same documented pattern -- never short-circuits on a
 * length mismatch, since an early return there would itself leak the
 * secret's length via timing.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBytes = textEncoder.encode(a)
  const bBytes = textEncoder.encode(b)
  if (aBytes.byteLength !== bBytes.byteLength) {
    return crypto.subtle.timingSafeEqual(aBytes, aBytes) && false
  }
  return crypto.subtle.timingSafeEqual(aBytes, bBytes)
}

async function handleManage(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('authorization')
  const expected = env.MANAGEMENT_API_TOKEN ? `Bearer ${env.MANAGEMENT_API_TOKEN}` : null
  if (!expected || !auth || !timingSafeStringEqual(auth, expected)) {
    return unauthorized()
  }

  const url = new URL(request.url)
  // /manage/:clubId/start | /manage/:clubId/status
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 3 || parts[0] !== 'manage') {
    return new Response('not found', { status: 404 })
  }
  const [, clubId, action] = parts

  const stub = getAccountObject(env, clubId)

  if (action === 'start') {
    await stub.ensureRunning()
    return Response.json({ ok: true, clubId, action: 'start' })
  }

  if (action === 'status') {
    const result = await stub.pollHealthAndDecide()
    return Response.json({ clubId, ...result })
  }

  return new Response('unknown action', { status: 400 })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Public, unauthenticated, zero-detail health probe -- safe for an
    // external uptime monitor to poll. Deliberately does NOT reach into
    // any specific club's container (that requires the management
    // token) -- it only confirms the Worker itself is alive and
    // Durable Objects are reachable, which is the layer a customer-
    // facing incident would actually be caused by if this returns
    // anything but 200.
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 })
    }

    if (url.pathname.startsWith('/manage/')) {
      return handleManage(request, env)
    }

    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
