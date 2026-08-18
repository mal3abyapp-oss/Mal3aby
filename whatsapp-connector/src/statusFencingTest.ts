/**
 * statusFencingTest.ts -- regression coverage for the status-write-race
 * fix (2026-08-18): BaileysProvider's setState() must stamp every
 * transition with a strictly increasing stateSeq, and TenantConnectionManager
 * must thread (generation, stateSeq) through to reportStatus() on every
 * single call -- never omitted, since an omitted fencing value would
 * silently reintroduce the exact race this fix closes.
 *
 * This does not open a real Baileys/WhatsApp connection or call
 * Supabase -- it exercises BaileysProvider's setState()/getDiagnostics()
 * directly via its internal hooks.
 *
 * Run with: npx tsx src/statusFencingTest.ts
 */
import { BaileysProvider } from './BaileysProvider.js'

let failures = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`[statusFencingTest] PASS - ${name}`)
  } else {
    failures += 1
    console.error(`[statusFencingTest] FAIL - ${name}${detail ? ` (${detail})` : ''}`)
  }
}

async function main() {
  const transitions: Array<{ state: string; fencing: { generation: number; stateSeq: number } | undefined }> = []

  const provider = new BaileysProvider('test-club-id', {
    onStateChange: (state, _detail, fencing) => {
      transitions.push({ state, fencing })
    },
  })

  // Directly exercise the private setState() via the same mechanism a
  // real connection.update handler would -- accessing the private
  // method deliberately, same pattern as the other diagnostic test
  // files in this investigation, since setState() has no public
  // trigger without a real socket.
  const setState = (provider as unknown as { setState: (s: string, d?: unknown) => void }).setState.bind(provider)

  setState('connecting')
  setState('qr_required', { qr: 'fake-qr-for-test-only' })
  setState('connected', { connectedPhoneNumber: '971500000000' })

  check('every transition carries a fencing object, never undefined', transitions.every((t) => t.fencing !== undefined))
  check(
    'stateSeq is strictly increasing across transitions, never repeated or reset',
    transitions[0]!.fencing!.stateSeq < transitions[1]!.fencing!.stateSeq && transitions[1]!.fencing!.stateSeq < transitions[2]!.fencing!.stateSeq,
    JSON.stringify(transitions.map((t) => t.fencing?.stateSeq)),
  )
  check(
    'generation stays the same across transitions within one connection attempt (only bumps on a real reconnect, tested separately)',
    transitions[0]!.fencing!.generation === transitions[1]!.fencing!.generation && transitions[1]!.fencing!.generation === transitions[2]!.fencing!.generation,
  )

  console.log(`\n[statusFencingTest] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[statusFencingTest] fatal error:', err)
  process.exit(1)
})
