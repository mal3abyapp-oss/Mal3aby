/**
 * freshSessionQrDiagnostic.ts -- ROOT-CAUSE INVESTIGATION (2026-08-22),
 * the FRESH ISOLATED QR-LINKED SESSION control test, explicitly
 * mandated by the user as the one remaining decisive control before
 * any final root-cause conclusion: separates two possibilities the
 * rest of this investigation could not distinguish --
 *   A) the PERSISTED production Baileys session/auth state is
 *      corrupted, stale, incomplete, or protocol-incompatible.
 *   B) a completely FRESH Baileys companion session also cannot
 *      achieve real delivery.
 *
 * ISOLATION GUARANTEES (do not weaken these without explicit
 * re-authorization):
 *   - Uses a brand-new, dedicated clubId (a real `clubs` row created
 *     specifically for this diagnostic, id
 *     f0c5d667-7bb8-42e9-abcb-db0e9c576c1e, name "WHATSAPP FRESH
 *     SESSION DIAGNOSTIC (temporary, isolated)") -- NEVER the
 *     production club's id. tenantAuthDir() hashes clubId into the
 *     local auth directory path, so this alone guarantees a
 *     completely separate local auth directory with zero filesystem
 *     overlap with the production session.
 *   - whatsapp_accounts/whatsapp_connection_events rows for this
 *     diagnostic club are entirely separate rows (a real, independent
 *     FK-enforced `clubs` row), never touching the production club's
 *     own rows.
 *   - Runs as a SEPARATE LOCAL PROCESS (this dev machine, via
 *     `npx tsx --env-file=.env`), NOT inside the Cloudflare-hosted
 *     production container -- no risk of colliding with or disrupting
 *     the production socket, which keeps running entirely
 *     undisturbed throughout this test.
 *   - Sends EXACTLY ONE plain-text message via bare
 *     `sock.sendMessage(jid, { text })` semantics (BaileysProvider.
 *     sendMessage(), no media, no custom LID/participant/relay
 *     overrides) to the SAME authorized QA recipient
 *     (+971502061209) already used throughout this investigation --
 *     never a real customer number, never read from an argument.
 *   - Does NOT touch notification_queue, templates, or any business
 *     workflow -- transport isolation only, matching this
 *     investigation's established directSendDiagnostic.ts pattern.
 *
 * USAGE: run this script. It will print a QR code to the terminal and
 * wait. Scan it with the SAME WhatsApp account already linked to
 * production (Settings -> Linked Devices -> Link a Device) -- this
 * creates a SECOND, independent companion-device session for the same
 * account, not a different account, matching what the investigation
 * actually needs to test (companion/session-state isolation, not
 * account isolation). Once linked, it sends one plain-text message and
 * prints full sanitized diagnostics, then waits up to 3 minutes
 * watching for any messages.update event before exiting.
 *
 * Run with: npx tsx --env-file=.env src/freshSessionQrDiagnostic.ts
 */
import { SupabaseSync } from './SupabaseSync.js'
import { BaileysProvider } from './BaileysProvider.js'
import qrcodeTerminal from 'qrcode-terminal'

// RESULT (2026-08-22): this control test CONFIRMED the root cause --
// a message sent via this fresh, isolated session physically arrived
// on both the sender's own WhatsApp chat and the recipient's phone,
// while the persisted production session never delivered anything
// across the entire prior investigation. This proved CASE A: the
// persisted production Baileys session/auth state was itself the
// defect, not a WhatsApp-server-side or unofficial-client issue.
// Production was then safely relinked (disconnect_whatsapp() ->
// start_whatsapp_pairing() -> fresh QR scan) and real delivery was
// re-confirmed end-to-end. The diagnostic club row below was deleted
// after this test concluded (cascading whatsapp_accounts/
// whatsapp_connection_events cleanup) -- this clubId is NO LONGER A
// VALID ROW. Kept as a reference for how to reproduce this exact
// control methodology in a future investigation; re-run this script
// with a freshly-created diagnostic `clubs` row if ever needed again.
const DIAGNOSTIC_CLUB_ID = 'f0c5d667-7bb8-42e9-abcb-db0e9c576c1e' // dedicated, isolated `clubs` row created solely for this test -- NEVER the production club id. DELETED after use -- see result note above.
const TARGET_PHONE_DIGITS_ONLY = '971502061209' // the ONE number this entire investigation is authorized to send to

function nowIso(): string {
  return new Date().toISOString()
}

async function main() {
  console.log(`[freshSessionQrDiagnostic] start at=${nowIso()} pid=${process.pid}`)
  console.log(`[freshSessionQrDiagnostic] ISOLATED diagnostic clubId=${DIAGNOSTIC_CLUB_ID} -- completely separate from the production club. Production connector is NOT touched by this script.`)

  const sync = new SupabaseSync()

  let qrPrinted = false
  const provider = new BaileysProvider(DIAGNOSTIC_CLUB_ID, {
    onStateChange: (state, detail) => {
      console.log(`[freshSessionQrDiagnostic] state=${state} at=${nowIso()}${detail?.error ? ` error=${detail.error}` : ''}`)
      if (state === 'qr_required' && detail?.qr && !qrPrinted) {
        qrPrinted = true
        console.log('\n[freshSessionQrDiagnostic] ==================== SCAN THIS QR ====================')
        qrcodeTerminal.generate(detail.qr, { small: true })
        console.log('[freshSessionQrDiagnostic] ======================================================\n')
        console.log('[freshSessionQrDiagnostic] Scan with the SAME WhatsApp account already linked to production: Settings -> Linked Devices -> Link a Device.')
      }
    },
    onCredsUpdate: (source) => {
      // Deliberately still persisted to Postgres via the real path (a
      // genuine, isolated club row -- see this file's own doc comment)
      // so this diagnostic session's own creds.update/keys_set
      // persistence behavior is ALSO exercised and observable, not
      // bypassed -- consistent with testing the real, complete code
      // path end-to-end, not a stripped-down variant.
      console.log(`[freshSessionQrDiagnostic] onCredsUpdate fired source=${source} at=${nowIso()}`)
    },
    onDeliveryReceipt: (messageKeyId, statusLevel) => {
      console.log(`[freshSessionQrDiagnostic] *** REAL DELIVERY RECEIPT *** messageKeyId=${messageKeyId} statusLevel=${statusLevel} at=${nowIso()}`)
    },
  })

  await provider.claimDbGeneration((clubId) => sync.claimGeneration(clubId))

  console.log('[freshSessionQrDiagnostic] initializing connection -- waiting for QR...')
  await provider.initializeConnection()

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const state = provider.getConnectionState()
    if (state === 'connected') break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  if (provider.getConnectionState() !== 'connected') {
    console.error(`[freshSessionQrDiagnostic] did not reach 'connected' within 120s (last state: ${provider.getConnectionState()}) -- QR likely not scanned in time. Exiting.`)
    process.exit(1)
  }

  console.log(`[freshSessionQrDiagnostic] CONNECTED at=${nowIso()} -- fresh companion session is live.`)
  const identity = provider.getSenderIdentity()
  console.log('[freshSessionQrDiagnostic] fresh session sender identity:', JSON.stringify(identity))

  const registration = await provider.checkRegistration(TARGET_PHONE_DIGITS_ONLY)
  console.log('[freshSessionQrDiagnostic] recipient registration check:', JSON.stringify(registration))

  console.log(`[freshSessionQrDiagnostic] sending ONE plain-text message to +${TARGET_PHONE_DIGITS_ONLY} at=${nowIso()}`)
  const sendStartedAt = Date.now()
  const result = await provider.sendMessage(
    TARGET_PHONE_DIGITS_ONLY,
    'Mal3aby FRESH ISOLATED SESSION control test -- if this arrives, the persisted production session was the defect.',
    undefined,
    'fresh-session-control-test',
  )
  console.log(
    `[freshSessionQrDiagnostic] sendMessage() resolved in ${Date.now() - sendStartedAt}ms at=${nowIso()} success=${result.success} providerReference=${result.providerReference ?? 'none'}${result.error ? ` error=${result.error}` : ''}`,
  )

  if (!result.success) {
    console.error('[freshSessionQrDiagnostic] send itself FAILED -- stopping here, no point waiting for a receipt.')
    await provider.disconnectGracefully()
    process.exit(1)
  }

  console.log('[freshSessionQrDiagnostic] waiting up to 180s for any messages.update event (real delivery receipt)...')
  const receiptDeadline = Date.now() + 180_000
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (Date.now() > receiptDeadline) {
        clearInterval(interval)
        resolve()
      }
    }, 5000)
  })

  console.log(`[freshSessionQrDiagnostic] done waiting at=${nowIso()}. If no "*** REAL DELIVERY RECEIPT ***" line appeared above, zero receipt arrived within the wait window -- same as every previous test in this investigation.`)

  await provider.disconnectGracefully()
  console.log(`[freshSessionQrDiagnostic] disconnected gracefully at=${nowIso()}. Diagnostic club/session left in Postgres for inspection -- not auto-deleted; clean up explicitly afterward if desired (DELETE FROM clubs WHERE id = '${DIAGNOSTIC_CLUB_ID}' cascades to whatsapp_accounts/whatsapp_connection_events).`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[freshSessionQrDiagnostic] fatal error:', err)
  process.exit(1)
})
