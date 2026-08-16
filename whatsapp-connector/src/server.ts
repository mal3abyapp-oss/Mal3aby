import 'dotenv/config'
import http from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { TenantConnectionManager } from './TenantConnectionManager.js'
import { ensureSessionsDir } from './SessionStore.js'

/**
 * server.ts — the connector service's internal HTTP control API.
 *
 * Security requirements (per the directive):
 *   - No public/unauthenticated endpoint. Every request must carry a
 *     valid HMAC signature computed with a shared secret
 *     (CONNECTOR_INTERNAL_SECRET) that only Supabase-side callers (an
 *     Edge Function or a trusted backend job, never the Vite client)
 *     possess. The Vite admin app never calls this service directly —
 *     it calls Supabase RPCs (start_whatsapp_pairing, etc.), and a
 *     Supabase-side integration is what actually calls this API,
 *     keeping the shared secret out of any browser-reachable code path.
 *   - clubId always comes from the signed request body, itself
 *     produced server-side from an already-authenticated+authorized
 *     Supabase RPC call -- the client never sends a raw session_id or
 *     chooses which session to act on directly.
 *   - Strict allowlisted operations only (connect/qr/disconnect/send/
 *     health) -- no generic passthrough endpoint.
 */

const PORT = Number(process.env.PORT ?? 8787)
const INTERNAL_SECRET = process.env.CONNECTOR_INTERNAL_SECRET

if (!INTERNAL_SECRET) {
  throw new Error('CONNECTOR_INTERNAL_SECRET must be set -- this service must never accept unauthenticated requests.')
}

function verifySignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false
  const expected = createHmac('sha256', INTERNAL_SECRET as string).update(rawBody).digest('hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  const providedBuf = Buffer.from(signatureHeader, 'hex')
  if (expectedBuf.length !== providedBuf.length) return false
  return timingSafeEqual(expectedBuf, providedBuf)
}

const manager = new TenantConnectionManager()

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const ALLOWED_ROUTES = new Set(['/connect', '/qr', '/disconnect', '/send', '/health'])

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')

  if (!req.url || !ALLOWED_ROUTES.has(req.url)) {
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }

  const rawBody = await readBody(req)
  const signature = req.headers['x-connector-signature'] as string | undefined

  if (!verifySignature(rawBody, signature)) {
    // Deliberately generic error -- never reveal whether the failure
    // was a missing header, a bad secret, or a tampered body.
    res.writeHead(401)
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  let payload: { clubId?: string; toPhoneE164?: string; body?: string }
  try {
    payload = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    res.writeHead(400)
    res.end(JSON.stringify({ error: 'invalid json' }))
    return
  }

  const clubId = payload.clubId
  if (!clubId || typeof clubId !== 'string') {
    res.writeHead(400)
    res.end(JSON.stringify({ error: 'clubId required' }))
    return
  }

  try {
    switch (req.url) {
      case '/connect': {
        await manager.connect(clubId)
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true }))
        return
      }
      case '/qr': {
        const qr = await manager.getQr(clubId)
        res.writeHead(200)
        // The raw QR payload is returned here to the SIGNED, TRUSTED
        // Supabase-side caller only -- never directly to a browser.
        // That caller is responsible for handing it to the frontend
        // over the already-authenticated Supabase RPC response, never
        // logging it.
        res.end(JSON.stringify({ qr }))
        return
      }
      case '/disconnect': {
        await manager.disconnect(clubId)
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true }))
        return
      }
      case '/send': {
        if (!payload.toPhoneE164 || !payload.body) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'toPhoneE164 and body required' }))
          return
        }
        const result = await manager.send(clubId, payload.toPhoneE164, payload.body)
        res.writeHead(result.success ? 200 : 502)
        res.end(JSON.stringify(result))
        return
      }
      case '/health': {
        const health = await manager.healthCheck(clubId)
        res.writeHead(200)
        res.end(JSON.stringify(health))
        return
      }
    }
  } catch (err) {
    res.writeHead(500)
    res.end(JSON.stringify({ error: (err as Error).message }))
  }
})

async function main() {
  await ensureSessionsDir()

  // Restore any club with a persisted session at startup, so a service
  // restart doesn't force every connected club to re-scan a QR code.
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (supabaseUrl && serviceKey) {
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
    const { data } = await supabase.from('whatsapp_connections').select('club_id').eq('status', 'connected')
    const clubIds = (data ?? []).map((r) => r.club_id as string)
    await manager.restoreAllPersistedSessions(clubIds)
  }

  server.listen(PORT, () => {
    console.log(`WhatsApp connector service listening on :${PORT} (internal, signed-request only)`)
  })
}

main().catch((err) => {
  console.error('WhatsApp connector service failed to start:', err)
  process.exit(1)
})
