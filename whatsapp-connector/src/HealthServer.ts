import { createServer, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { SupabaseSync } from './SupabaseSync.js'
import type { TenantConnectionManager } from './TenantConnectionManager.js'
import { getProcessDiagnosticsSnapshot } from './ProcessDiagnostics.js'
import { getSendDiagnosticsSnapshot } from './SendDiagnostics.js'
import { getIncomingMessageDiagnosticsSnapshot } from './IncomingMessageDiagnostics.js'

/**
 * Constant-time token comparison. The /status endpoint is internal-only
 * (Worker<->Container via containerFetch(), never public-internet-
 * reachable per the architecture), so a practical timing attack over
 * Cloudflare's own internal routing is not a realistic threat given a
 * 32-byte random token -- but defense-in-depth costs nothing here, so a
 * plain `!==` string comparison (timing-variable) is avoided in favor of
 * this. Falls back to false on any length mismatch or non-string input
 * without leaking length via the comparison itself.
 */
function safeTokenEquals(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false
  const providedBuf = Buffer.from(provided)
  const expectedBuf = Buffer.from(expected)
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}

/**
 * HealthServer -- Cloudflare Containers requires the container image to
 * listen on an HTTP port (Container class' `defaultPort`) so the
 * platform can tell "container process started successfully" and so
 * the owning Durable Object can poll real liveness before deciding
 * whether to call renewActivityTimeout()
 * (keep the container awake) or let it sleep. This is the ONLY inbound
 * port this service opens --
 * every other capability (queue consumption, pairing requests) remains
 * pure outbound polling against Supabase, exactly as before this file
 * was added. This does not change the local/VPS deployment story either
 * -- index.ts starts this server unconditionally, but nothing calls it
 * on a bare Node host, so it's a strict addition, not a behavior change
 * for the existing non-Cloudflare deployment path.
 *
 * Endpoints:
 *   GET /health -- liveness only. Always 200 while the process event
 *     loop is responsive at all (the mere fact this handler ran proves
 *     that). Body is deliberately minimal ('ok') -- ops rule 25: a
 *     PUBLIC health endpoint must never leak account/tenant detail.
 *   GET /ready -- readiness for the Container class' pingEndpoint
 *     during startup: confirms Supabase is reachable (a quick
 *     listAccounts() call) before the platform considers this instance
 *     ready to receive traffic/lifecycle decisions.
 *   POST /check-registration -- WHATSAPP DELIVERY TRUTH fix (2026-08-22):
 *     real, read-only WhatsApp-server query for whether a phone number
 *     is a genuinely registered account (Baileys onWhatsApp(), same
 *     internal-token gate and body shape as /repair-session).
 *   GET /status -- the ONE endpoint with real diagnostic detail (per-club
 *     connection states, generation counters, reconnect counts, whether
 *     ANY club has a live/healthy connection). This is what the
 *     controlling Durable Object polls to decide renewActivityTimeout()
 *     vs. letting the container sleep -- gated by a shared secret
 *     (CONTAINER_INTERNAL_TOKEN) so it is not a public information-leak
 *     surface, per ops rules 25-27 (internal routing, not a public API).
 *     Never returns tokens/keys/session material/message content.
 *
 * REMOVED: a /keepalive WebSocket endpoint was added, deployed
 * (commit 514758f, image tag v5-keepalive), and live-tested here as a
 * workaround for a ~184s container restart cycle, on the theory that
 * Cloudflare's documented "outbound WebSocket prevents DO eviction"
 * behavior would apply. Live `wrangler tail` monitoring showed the
 * WebSocket opening successfully but NOT preventing the next eviction
 * -- the actual root cause turned out to be the Worker-side
 * `@cloudflare/containers` package being 46 versions out of date and
 * missing the real fix, `onActivityExpired()` (see
 * WhatsAppAccountObject.ts). Once that override was in place, this
 * endpoint was no longer needed and was removed rather than left as
 * unused parallel machinery. Full history in git (commit 514758f) and
 * WhatsAppAccountObject.ts's class-level doc comment.
 */
export function startHealthServer(sync: SupabaseSync, connections: TenantConnectionManager, port: number): Server {
  const internalToken = process.env.CONTAINER_INTERNAL_TOKEN ?? null

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal')

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }

    if (url.pathname === '/ready') {
      sync
        .listAccounts()
        .then(() => {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('ready')
        })
        .catch((err) => {
          console.error('[connector] readiness check failed (Supabase unreachable):', (err as Error).message)
          res.writeHead(503, { 'content-type': 'text/plain' })
          res.end('not ready')
        })
      return
    }

    if (url.pathname === '/repair-session' && req.method === 'POST') {
      // Same internal-only gate as /status -- never public. See
      // BaileysProvider.repairContactSession's own doc comment for
      // what this does and why it exists (2026-08-19 live incident:
      // per-contact Signal sessions negotiated before this session's
      // persistence fix can still be stale even after that fix ships,
      // since the fix only prevents FUTURE corruption).
      const provided = req.headers['x-internal-token']
      if (!internalToken || Array.isArray(provided) || !safeTokenEquals(provided, internalToken)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('forbidden')
        return
      }
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        void (async () => {
          try {
            const { clubId, phone } = JSON.parse(body) as { clubId?: string; phone?: string }
            if (!clubId || !phone) {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'clubId and phone are required' }))
              return
            }
            const removed = await connections.repairContactSession(clubId, phone)
            if (removed === null) {
              res.writeHead(404, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'no active connection for this club' }))
              return
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, sessionFilesRemoved: removed.length }))
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: (err as Error).message }))
          }
        })()
      })
      return
    }

    if (url.pathname === '/check-registration' && req.method === 'POST') {
      // Same internal-only gate as /status and /repair-session -- never
      // public. WHATSAPP DELIVERY TRUTH fix (2026-08-22), directive
      // section 10: a real, read-only WhatsApp-server query (Baileys
      // onWhatsApp(), reusing the already-live socket -- no second
      // connection opened) for whether a phone number is a genuinely
      // registered WhatsApp account. Never logs the phone number itself
      // to stdout (only the club prefix, matching every other endpoint
      // here), and returns no message content.
      const provided = req.headers['x-internal-token']
      if (!internalToken || Array.isArray(provided) || !safeTokenEquals(provided, internalToken)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('forbidden')
        return
      }
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        void (async () => {
          try {
            const { clubId, phone } = JSON.parse(body) as { clubId?: string; phone?: string }
            if (!clubId || !phone) {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'clubId and phone are required' }))
              return
            }
            const result = await connections.checkRegistration(clubId, phone)
            if (result === null) {
              res.writeHead(404, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'no active connection for this club' }))
              return
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: (err as Error).message }))
          }
        })()
      })
      return
    }

    if (url.pathname === '/sender-identity' && req.method === 'POST') {
      // ROOT-CAUSE INVESTIGATION (2026-08-22), directive section 6.
      // Same internal-only gate as every other /manage-proxied route.
      const provided = req.headers['x-internal-token']
      if (!internalToken || Array.isArray(provided) || !safeTokenEquals(provided, internalToken)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('forbidden')
        return
      }
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          const { clubId } = JSON.parse(body) as { clubId?: string }
          if (!clubId) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'clubId is required' }))
            return
          }
          const result = connections.getSenderIdentity(clubId)
          if (result === null) {
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'no active connection for this club' }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: (err as Error).message }))
        }
      })
      return
    }

    if (url.pathname === '/status') {
      // Internal-only: requires the shared token the owning Durable
      // Object was provisioned with (Container class' envVars), not a
      // public credential. Absent token config (e.g. running bare on a
      // non-Cloudflare host where nothing ever calls this) fails closed
      // -- the endpoint simply refuses rather than defaulting open.
      const provided = req.headers['x-internal-token']
      if (!internalToken || Array.isArray(provided) || !safeTokenEquals(provided, internalToken)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('forbidden')
        return
      }

      const diagnostics = connections.getAllDiagnostics()
      const anyConnected = diagnostics.some((d) => d.state === 'connected')
      const anyReconnecting = diagnostics.some((d) => d.state === 'connecting' || d.state === 'reconnecting')
      // DIAGNOSTIC (root-cause investigation, item 8 -- "check memory
      // usage and whether the process exceeds the configured Container
      // instance limits"): process.memoryUsage() has no secret content,
      // safe to expose on this already-internal-token-gated endpoint.
      const mem = process.memoryUsage()

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          // Never a full clubId, never a phone number, never a token --
          // getAllDiagnostics() already truncates clubId to 8 chars
          // (see TenantConnectionManager) and carries no secret fields.
          accounts: diagnostics,
          anyConnected,
          anyReconnecting,
          shouldStayAwake: anyConnected || anyReconnecting,
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          memoryMb: {
            rss: Math.round(mem.rss / 1024 / 1024),
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
            external: Math.round(mem.external / 1024 / 1024),
          },
          // Send-hang investigation additions (2026-08-18) -- see
          // ProcessDiagnostics.ts and SendDiagnostics.ts for why these
          // exist. No message content, no phone numbers, no tokens.
          processDiagnostics: getProcessDiagnosticsSnapshot(),
          sendDiagnostics: getSendDiagnosticsSnapshot(),
          // ROOT-CAUSE INVESTIGATION (2026-08-22) -- see
          // IncomingMessageDiagnostics.ts's own doc comment. Safe
          // metadata only (no content, no phone numbers).
          incomingMessageDiagnostics: getIncomingMessageDiagnosticsSnapshot(),
        }),
      )
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  server.listen(port, () => {
    console.log(`[connector] health server listening on port ${port} (/health, /ready, /status)`)
  })

  // DIAGNOSTIC (root-cause investigation, item 9 -- "check whether
  // required port 8080 remains listening continuously until shutdown;
  // if the process stops listening before the restart, identify why").
  // A 'close' with no preceding shutdown() log line, or an 'error'
  // event at all, would be direct evidence the HTTP listener itself is
  // failing independent of the Node process's own exit path.
  server.on('close', () => {
    console.log(`[diag] health server 'close' event pid=${process.pid} at=${new Date().toISOString()}`)
  })
  server.on('error', (err) => {
    console.error(`[diag] health server 'error' event pid=${process.pid} at=${new Date().toISOString()}:`, err.message)
  })

  return server
}
