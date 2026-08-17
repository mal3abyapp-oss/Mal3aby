/**
 * selfTest.ts -- verifies the connector actually opens a real WebSocket
 * to WhatsApp's servers and receives a real, valid QR payload back.
 * This is the honest, fully-automatable boundary of what can be proven
 * without a physical phone: it does NOT complete pairing (that step
 * requires a real scan) but it does prove the Baileys integration
 * itself is real and functional, not a mock/stub.
 *
 * Run with: npm test (invokes this file with --env-file=.env, see
 * package.json -- no dotenv import needed).
 */
import { BaileysProvider } from './BaileysProvider.js'

const TEST_CLUB_ID = 'selftest-' + Date.now()

async function main() {
  console.log('[selfTest] Opening a real Baileys connection...')
  let qrSeen = false
  let sawQrRequired = false

  const provider = new BaileysProvider(TEST_CLUB_ID, {
    onStateChange: (state) => {
      console.log('[selfTest] state ->', state)
      if (state === 'qr_required') sawQrRequired = true
    },
  })

  await provider.initializeConnection()

  // Poll for up to 20 seconds for a real QR to arrive from WhatsApp's
  // servers -- this requires actual outbound network access to
  // WhatsApp's WebSocket endpoint, which is what makes this a genuine
  // integration test rather than a mock.
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const qr = provider.getQr()
    if (qr) {
      qrSeen = true
      console.log('[selfTest] Received a real QR payload from WhatsApp (length:', qr.length, 'chars)')
      console.log('[selfTest] First 60 chars:', qr.slice(0, 60) + '...')
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!qrSeen) {
    console.error('[selfTest] FAILED - no QR received within 20s. Check network access to WhatsApp servers.')
    process.exitCode = 1
  } else if (!sawQrRequired) {
    console.error('[selfTest] FAILED - QR was received but state never transitioned to qr_required.')
    process.exitCode = 1
  } else {
    console.log('[selfTest] PASSED - real Baileys handshake reaches qr_required with a real QR payload.')
    console.log('[selfTest] REAL PHONE QR SCAN QA PENDING - scanning this QR with an actual phone is the next step, not automatable in this environment.')
  }

  await provider.logout()
  process.exit(process.exitCode ?? 0)
}

main().catch((err) => {
  console.error('[selfTest] Unexpected error:', err)
  process.exit(1)
})
