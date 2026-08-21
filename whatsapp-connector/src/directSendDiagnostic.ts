/**
 * directSendDiagnostic.ts -- ISOLATES the provider layer from the
 * notification_queue/QueueConsumer/Supabase-claim path entirely, per
 * explicit investigation request (2026-08-18): does a direct
 * BaileysProvider.sendMessage() call, with NO queue/claim/report_send_result
 * RPC anywhere in the path, succeed or hang the same way queue-driven
 * sends did?
 *
 * SAFETY: this restores and connects ONLY the one approved test club's
 * session, and sends to ONLY the one approved test number
 * (+971502061209) -- both hardcoded below, not read from any argument,
 * so this script cannot be pointed at a different club or number by
 * accident. Before running this, the Cloudflare-hosted container's own
 * connection for this club MUST be stopped (via the Worker's
 * /manage/:clubId/restart route) to avoid two live sockets for the
 * same WhatsApp account colliding (Baileys' own documented
 * conflict/replaced disconnect reason) -- this script does not stop it
 * for you.
 *
 * Run with: npx tsx --env-file=.env src/directSendDiagnostic.ts
 */
import { SupabaseSync } from './SupabaseSync.js'
import { BaileysProvider } from './BaileysProvider.js'
import { restoreAuthDirForClub } from './SessionStore.js'
import { getSendDiagnosticsSnapshot } from './SendDiagnostics.js'
import { getProcessDiagnosticsSnapshot } from './ProcessDiagnostics.js'

const TARGET_CLUB_ID = 'b9178c0f-00b5-4c71-abec-b8772ffb8682' // the only real WhatsApp account in this project's data, per this session's own earlier findings
const TARGET_PHONE_DIGITS_ONLY = '971502061209' // the ONE number this entire investigation is authorized to send to -- never read from an argument/env var

function nowIso(): string {
  return new Date().toISOString()
}

async function waitForConnected(provider: BaileysProvider, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (provider.getConnectionState() === 'connected') return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`did not reach 'connected' within ${timeoutMs}ms (last state: ${provider.getConnectionState()})`)
}

async function main() {
  console.log(`[directSendDiagnostic] start at=${nowIso()} pid=${process.pid}`)
  console.log('[directSendDiagnostic] SAFETY CHECK: this sends ONLY to +971502061209, and only if you have already stopped the Cloudflare container-hosted connection for this club. Proceeding in 3s...')
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const sync = new SupabaseSync()

  const loadStartedAt = Date.now()
  const encrypted = await sync.loadSession(TARGET_CLUB_ID)
  if (!encrypted) throw new Error('no persisted session found for the target club -- cannot run this diagnostic without a real, already-paired session')
  console.log(`[directSendDiagnostic] session loaded from Supabase in ${Date.now() - loadStartedAt}ms at=${nowIso()}`)

  const restoreStartedAt = Date.now()
  await restoreAuthDirForClub(TARGET_CLUB_ID, encrypted)
  console.log(`[directSendDiagnostic] session decrypted+written to local auth dir in ${Date.now() - restoreStartedAt}ms at=${nowIso()}`)

  const provider = new BaileysProvider(TARGET_CLUB_ID, {
    onStateChange: (state, detail) => {
      console.log(`[directSendDiagnostic] state=${state} at=${nowIso()}${detail?.error ? ` error=${detail.error}` : ''}`)
    },
    // No onCredsUpdate persistence here deliberately -- this is a
    // read-only diagnostic run against an EXISTING session; it must
    // never write back a mutated session over the real one mid-test.
  })

  // Independent-audit fix (2026-08-21): this script's own doc comment
  // already requires the production container to be stopped before
  // running, so it is safe to be the sole writer here -- claim a real
  // DB-allocated generation the same way the real connector does, so
  // this diagnostic's own status transitions are correctly recorded
  // (not silently refused by setState()'s guard) rather than leaving
  // whatsapp_accounts in whatever stale state the stopped production
  // process last wrote.
  await provider.claimDbGeneration((clubId) => sync.claimGeneration(clubId))

  const connectStartedAt = Date.now()
  await provider.initializeConnection()
  await waitForConnected(provider, 30_000)
  console.log(`[directSendDiagnostic] reached 'connected' in ${Date.now() - connectStartedAt}ms at=${nowIso()}`)

  console.log(`[directSendDiagnostic] sending direct plain-text message (bypassing notification_queue entirely) at=${nowIso()}`)
  const sendStartedAt = Date.now()
  const result = await provider.sendMessage(
    TARGET_PHONE_DIGITS_ONLY,
    'Mal3aby direct-provider diagnostic test (bypassing the notification queue) -- if you see this, the provider layer itself works independent of the database/queue path.',
    undefined,
    'direct-diagnostic-plain-text',
  )
  const elapsedMs = Date.now() - sendStartedAt
  console.log(`[directSendDiagnostic] sendMessage() resolved in ${elapsedMs}ms at=${nowIso()} success=${result.success} hasProviderReference=${!!result.providerReference}${result.error ? ` error=${result.error}` : ''}`)

  console.log('[directSendDiagnostic] SendDiagnostics snapshot:', JSON.stringify(getSendDiagnosticsSnapshot()))
  console.log('[directSendDiagnostic] ProcessDiagnostics snapshot:', JSON.stringify(getProcessDiagnosticsSnapshot()))

  await provider.disconnectGracefully()
  console.log(`[directSendDiagnostic] done, disconnected gracefully at=${nowIso()}`)
  process.exit(result.success ? 0 : 1)
}

main().catch((err) => {
  console.error('[directSendDiagnostic] fatal error:', err)
  process.exit(1)
})
