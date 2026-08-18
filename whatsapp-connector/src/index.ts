import { ConnectionRequestPoller } from './ConnectionRequestPoller.js'
import { QueueConsumer } from './QueueConsumer.js'
import { SupabaseSync } from './SupabaseSync.js'
import { TenantConnectionManager } from './TenantConnectionManager.js'
import { startHealthServer } from './HealthServer.js'

/**
 * index.ts -- process entrypoint. No inbound HTTP server: this service
 * only ever calls OUT to Supabase (via SupabaseSync's narrow
 * whatsapp_connector_* RPCs, service-role key) and out to WhatsApp's
 * own servers (via Baileys). The admin app never talks to this process
 * directly -- it writes intent (start_whatsapp_pairing/
 * disconnect_whatsapp) into Postgres, and this service notices and
 * acts on it via ConnectionRequestPoller. This keeps the connector's
 * network exposure to zero inbound ports, which is a stronger security
 * posture than the prior implementation's signed-HTTP control API and
 * was possible specifically because polling Postgres for intent is
 * cheap and this is a low-frequency operation (pairing requests, not
 * per-message).
 *
 * Environment loading: no `dotenv` import here -- both `npm run dev`
 * and `npm start` invoke this file with Node's native
 * `--env-file=.env` flag (see package.json), which is a built-in
 * feature on Node 20.6+/22 and avoids an unnecessary runtime
 * dependency for a task the platform already does natively.
 */

/**
 * Safe startup validation: reports only WHETHER each required variable
 * is present and non-empty, never the value itself, and never writes
 * any of them to a log line. Exits with a clear, actionable message
 * (naming the exact missing variable) rather than letting a missing
 * credential surface later as an opaque Supabase/Baileys error.
 */
function validateRequiredEnv(): void {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'WHATSAPP_SESSION_ENCRYPTION_KEY'] as const
  const missing = required.filter((name) => !process.env[name] || process.env[name]!.length === 0)

  if (missing.length > 0) {
    console.error('[connector] EXTERNAL CONFIGURATION REQUIRED -- missing required environment variable(s):')
    for (const name of missing) console.error(`  - ${name}`)
    console.error('[connector] Copy whatsapp-connector/.env.example to whatsapp-connector/.env and fill in the missing value(s), then retry.')
    process.exit(1)
  }

  const keyBytes = Buffer.from(process.env.WHATSAPP_SESSION_ENCRYPTION_KEY!, 'base64').length
  if (keyBytes !== 32) {
    console.error(`[connector] WHATSAPP_SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256) -- got ${keyBytes} bytes. Regenerate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
    process.exit(1)
  }

  console.log('[connector] environment check: SUPABASE_URL present, SUPABASE_SERVICE_ROLE_KEY present, WHATSAPP_SESSION_ENCRYPTION_KEY present and valid (32 bytes).')
}

/**
 * Real bug found live (Safe Messaging test #105): an unhandled
 * exception from deep inside Baileys' own retry-message handling
 * (`sendRetryRequest` hitting a closed WebSocket, Boom "Connection
 * Closed") crashed this entire Node process, silently abandoning every
 * club's queue processing and leaving in-flight rows stuck in
 * 'processing' -- not a graceful reconnect, a hard process exit.
 *
 * This is NOT a change to the pairing/session logic itself (untouched,
 * per the resume directive) -- it's process-level resilience so a
 * single unhandled internal library error can never silently kill the
 * whole service. Logged and swallowed at the process boundary; the
 * specific club's BaileysProvider will surface its own real connection
 * state (reconnecting/failed/etc.) through the normal state-change
 * path regardless -- this handler exists only to stop an OS-level
 * process death, not to hide or suppress a real per-club failure.
 */
function installCrashGuards(): void {
  process.on('uncaughtException', (err) => {
    console.error('[connector] uncaught exception (process kept alive):', err instanceof Error ? err.message : err)
    if (err instanceof Error && err.stack) console.error('[connector] stack:', err.stack)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[connector] unhandled promise rejection (process kept alive):', reason instanceof Error ? reason.message : reason)
    if (reason instanceof Error && reason.stack) console.error('[connector] stack:', reason.stack)
  })
}

/**
 * DIAGNOSTIC (root-cause investigation into the ~3-minute container
 * restart cycle observed live during the MAL3ABY WHATSAPP QR IMAGE +
 * INVOICE DOCUMENT DELIVERY task, per the explicit methodology
 * requested): full process-lifecycle logging -- start timestamp, PID,
 * every signal received, beforeExit, and the final exit code. No
 * secrets logged. This is what lets a live `wrangler tail`/container
 * log capture answer, definitively: does this Node process exit on its
 * own (and if so, via what exact path/signal), or is it killed
 * externally with no signal ever observed at the process level (which
 * would point at the underlying Firecracker microVM/container runtime
 * being torn down out from under the process, not the process itself
 * choosing to exit)?
 */
function installLifecycleDiagnostics(): void {
  const startedAt = new Date().toISOString()
  console.log(`[diag] process start pid=${process.pid} at=${startedAt}`)

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
    process.on(signal, () => {
      console.log(`[diag] received signal=${signal} pid=${process.pid} at=${new Date().toISOString()}`)
    })
  }
  process.on('beforeExit', (code) => {
    console.log(`[diag] beforeExit code=${code} pid=${process.pid} at=${new Date().toISOString()}`)
  })
  process.on('exit', (code) => {
    console.log(`[diag] exit code=${code} pid=${process.pid} at=${new Date().toISOString()}`)
  })
}

async function main() {
  installLifecycleDiagnostics()
  validateRequiredEnv()
  installCrashGuards()

  const sync = new SupabaseSync()
  const connections = new TenantConnectionManager(sync)

  // Cloudflare Containers requires the image to listen on an HTTP port
  // (see MAL3ABY_CLOUDFLARE_PRODUCTION_ARCHITECTURE.md) so the platform
  // and the owning Durable Object can check liveness/readiness and
  // decide whether to keep this container instance awake. Harmless
  // no-op capability on a bare Node/VPS host -- nothing calls it there.
  const healthServer = startHealthServer(sync, connections, Number(process.env.HEALTH_PORT ?? 8080))

  console.log('[connector] restoring persisted sessions...')
  await connections.restoreAllPersistedSessions()
  console.log('[connector] session restore pass complete.')

  const connectionPoller = new ConnectionRequestPoller(sync, connections, 3000)
  connectionPoller.start()

  const queueConsumer = new QueueConsumer(
    sync,
    connections,
    Number(process.env.QUEUE_POLL_INTERVAL_MS ?? 5000),
    Number(process.env.QUEUE_BATCH_SIZE ?? 10),
  )
  queueConsumer.start()

  console.log('[connector] running: watching for pairing requests and polling the WhatsApp notification queue.')

  // P1 reliability fix (2026-08-17): the previous version of this
  // handler stopped the pollers and exited immediately -- it never
  // told WhatsApp's servers any club's live socket was closing. That
  // left the OLD process's session looking "still active" from
  // WhatsApp's side, so the NEXT process's reconnect (whether a real
  // restart or a tsx-watch dev-server file-change restart) opened a
  // second socket for the same device credentials while the first one
  // hadn't been told to stand down -- WhatsApp's own servers then
  // reject one of them with `stream:error / conflict / replaced`,
  // observed live as a tight reconnect-storm loop. Calling
  // disconnectAllGracefully() here (bounded, awaited, before exit)
  // closes every socket cleanly first, which is what actually stops
  // the storm at its root cause rather than just widening retry caps
  // on the receiving end.
  const shutdown = (signal: string) => {
    console.log(`[connector] shutting down (triggered by ${signal})...`)
    connectionPoller.stop()
    queueConsumer.stop()
    healthServer.close()
    void connections
      .disconnectAllGracefully()
      .catch((err) => console.error('[connector] error during graceful shutdown (exiting anyway):', (err as Error).message))
      .finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[connector] failed to start:', err)
  process.exit(1)
})
