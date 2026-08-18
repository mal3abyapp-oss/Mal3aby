import { createServer, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { SupabaseSync } from './SupabaseSync.js'
import type { TenantConnectionManager } from './TenantConnectionManager.js'

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
 * listen on an HTTP port (Container class' `defaultPort`, confirmed
 * against the actual installed @cloudflare/containers@0.0.13 API --
 * there is no separate `pingEndpoint` property in this version;
 * startAndWaitForPorts() gates readiness on TCP port reachability, not
 * a specific HTTP path) so the platform can tell "container process
 * started successfully" and so the owning Durable Object can poll real
 * liveness before deciding whether to call renewActivityTimeout()
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
 *   GET /status -- the ONE endpoint with real diagnostic detail (per-club
 *     connection states, generation counters, reconnect counts, whether
 *     ANY club has a live/healthy connection). This is what the
 *     controlling Durable Object polls to decide renewActivityTimeout()
 *     vs. letting the container sleep -- gated by a shared secret
 *     (CONTAINER_INTERNAL_TOKEN) so it is not a public information-leak
 *     surface, per ops rules 25-27 (internal routing, not a public API).
 *     Never returns tokens/keys/session material/message content.
 *   WS /keepalive -- REAL BUG found live (root-cause investigation,
 *     ~184s container restart cycle): Cloudflare's own Durable Object
 *     lifecycle documentation states plain fetch() subrequests (which
 *     is exactly what the /status poll above is) NEVER prevent DO
 *     eviction -- only an active outbound TCP connect() or WebSocket
 *     does, for up to 15 minutes per connection. This endpoint exists
 *     SOLELY so the owning Durable Object (WhatsAppAccountObject.ts)
 *     can hold one such connection open per club, which is the
 *     documented, sanctioned way to keep a DO (and by extension the
 *     container it manages) alive between real health polls. Same
 *     internal-token trust boundary and gating as /status -- never a
 *     public endpoint, carries no payload beyond a heartbeat marker,
 *     no secrets ever sent either direction.
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
        }),
      )
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  // /keepalive -- see the class-level doc comment above for why this
  // exists. `noServer: true` because we're sharing ONE listening port
  // (8080, the same port the Container platform already health-checks)
  // between plain HTTP (/health, /ready, /status) and this WebSocket
  // endpoint -- the 'upgrade' handler below decides which requests to
  // hand to the WS server based on path + token, everything else stays
  // on the plain HTTP server above.
  const wss = new WebSocketServer({ noServer: true })
  let keepaliveSocket: WebSocket | null = null

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://internal')
    if (url.pathname !== '/keepalive') {
      socket.destroy()
      return
    }
    const provided = req.headers['x-internal-token']
    if (!internalToken || Array.isArray(provided) || !safeTokenEquals(provided, internalToken)) {
      // Fail closed, same as /status -- an unauthenticated upgrade
      // attempt is simply refused, never silently accepted.
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // Requirement 6: one club DO -> one keep-alive connection. This
      // container process serves exactly one club's WhatsApp session
      // (confirmed by this repo's own "one container instance per
      // WhatsApp account" architecture -- see WhatsAppAccountObject.ts),
      // so "one connection per container" is the same guarantee as
      // "one per club" here. If a NEW keepalive connection arrives
      // while an old one is still technically open (e.g. the owning DO
      // reconnected before its previous socket's close event was fully
      // processed), the old one is closed first -- this is what
      // prevents a duplicate/leaked socket accumulating across DO
      // reconnects, not just a cosmetic replace.
      if (keepaliveSocket && keepaliveSocket.readyState === keepaliveSocket.OPEN) {
        console.log(`[keepalive] keepalive_rotated pid=${process.pid} at=${new Date().toISOString()} (replacing an existing open connection)`)
        keepaliveSocket.close(1000, 'replaced by new keepalive connection')
      }
      keepaliveSocket = ws
      console.log(`[keepalive] keepalive_opened pid=${process.pid} at=${new Date().toISOString()}`)

      // Lightweight heartbeat so the connection is never a silent,
      // possibly-half-dead TCP socket -- a stale connection that
      // never gets a pong is closed and the DO's own reconnect-with-
      // backoff logic (WhatsAppAccountObject.ts) is what re-establishes
      // it, never this server reaching out on its own.
      const heartbeat = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.ping()
      }, 30_000)

      ws.on('close', (code, reason) => {
        clearInterval(heartbeat)
        if (keepaliveSocket === ws) keepaliveSocket = null
        // Never logs `reason` verbatim beyond its byte length -- it's
        // client-supplied text and, while not expected to ever carry
        // anything sensitive on this internal-only channel, there is
        // no reason to echo arbitrary caller-supplied bytes into logs.
        console.log(`[keepalive] keepalive_closed pid=${process.pid} at=${new Date().toISOString()} code=${code} reasonBytes=${reason.length}`)
      })
      ws.on('error', (err) => {
        console.error(`[keepalive] keepalive_error pid=${process.pid} at=${new Date().toISOString()}:`, err.message)
      })
      // No inbound message handling needed -- this channel exists only
      // to be an open connection Cloudflare's own platform recognizes
      // as "active", never to carry real traffic. Any inbound message
      // is acknowledged and otherwise ignored (never parsed as a
      // command channel -- this must never become an unintended second
      // management API).
      ws.on('message', () => {
        if (ws.readyState === ws.OPEN) ws.pong()
      })
    })
  })

  server.listen(port, () => {
    console.log(`[connector] health server listening on port ${port} (/health, /ready, /status, /keepalive)`)
  })

  // DIAGNOSTIC (root-cause investigation, item 9 -- "check whether
  // required port 8080 remains listening continuously until shutdown;
  // if the process stops listening before the restart, identify why").
  // A 'close' with no preceding shutdown() log line, or an 'error'
  // event at all, would be direct evidence the HTTP listener itself is
  // failing independent of the Node process's own exit path.
  server.on('close', () => {
    console.log(`[diag] health server 'close' event pid=${process.pid} at=${new Date().toISOString()}`)
    // Clean shutdown of the keepalive socket too, per requirement 9
    // ("on container shutdown / DO stop: close the keep-alive socket
    // cleanly") -- a normal close code, not an abrupt drop, so the
    // owning DO's close handler reads this as an expected shutdown
    // rather than an error to reconnect-with-backoff against.
    if (keepaliveSocket) {
      keepaliveSocket.close(1000, 'server shutting down')
      keepaliveSocket = null
    }
  })
  server.on('error', (err) => {
    console.error(`[diag] health server 'error' event pid=${process.pid} at=${new Date().toISOString()}:`, err.message)
  })

  return server
}
