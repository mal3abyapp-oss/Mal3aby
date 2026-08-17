import 'dotenv/config'
import { ConnectionRequestPoller } from './ConnectionRequestPoller.js'
import { QueueConsumer } from './QueueConsumer.js'
import { SupabaseSync } from './SupabaseSync.js'
import { TenantConnectionManager } from './TenantConnectionManager.js'

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
 */

async function main() {
  const sync = new SupabaseSync()
  const connections = new TenantConnectionManager(sync)

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

  const shutdown = () => {
    console.log('[connector] shutting down...')
    connectionPoller.stop()
    queueConsumer.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[connector] failed to start:', err)
  process.exit(1)
})
