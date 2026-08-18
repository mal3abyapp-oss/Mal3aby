import { createServer, type Server } from 'node:http'
import type { SupabaseSync } from './SupabaseSync.js'
import type { TenantConnectionManager } from './TenantConnectionManager.js'

/**
 * HealthServer -- Cloudflare Containers requires the container image to
 * listen on an HTTP port (Container class' `defaultPort`/`pingEndpoint`)
 * so the platform can tell "container process started successfully" and
 * so the owning Durable Object can poll real liveness before deciding
 * whether to call renewActivityTimeout() (keep the container awake) or
 * let it sleep. This is the ONLY inbound port this service opens --
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
      if (!internalToken || provided !== internalToken) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('forbidden')
        return
      }

      const diagnostics = connections.getAllDiagnostics()
      const anyConnected = diagnostics.some((d) => d.state === 'connected')
      const anyReconnecting = diagnostics.some((d) => d.state === 'connecting' || d.state === 'reconnecting')

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

  return server
}
