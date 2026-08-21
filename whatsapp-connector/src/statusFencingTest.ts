/**
 * statusFencingTest.ts -- regression coverage for the status-write-race
 * fix (2026-08-18) AND its independent-audit correction (2026-08-21):
 * BaileysProvider's setState() must stamp every transition with a
 * strictly increasing stateSeq, and TenantConnectionManager must thread
 * (generation, stateSeq) through to reportStatus() on every single call
 * -- never omitted, since an omitted fencing value would silently
 * reintroduce the exact race this fix closes.
 *
 * 2026-08-21 correction: `generation` is no longer a bare in-process
 * counter always starting at 0 -- it must come from
 * claimDbGeneration()'s atomically-DB-allocated value, and setState()
 * must REFUSE to report (not fabricate a value) if called before that
 * claim resolves. Real incident this fixes: a fresh process's
 * always-starts-at-0 generation eventually became permanently fenced
 * out by the database's own memory of a much higher generation
 * accumulated across prior process restarts (club
 * b9178c0f-00b5-4c71-abec-b8772ffb8682, last_generation=17, a genuine
 * WhatsApp-side logout that could never be recorded).
 *
 * This does not open a real Baileys/WhatsApp connection or call
 * Supabase -- it exercises BaileysProvider's setState()/getDiagnostics()
 * directly via its internal hooks, with claimDbGeneration() given a
 * fake injected claim function (no real RPC call).
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

  // Independent-audit fix regression: a transition fired BEFORE
  // claimDbGeneration() resolves must be silently refused (no fencing
  // object emitted at all), never fabricate generation=0.
  setState('connecting')
  check(
    'a state change before claimDbGeneration() resolves emits NO transition at all (refused, not fabricated)',
    transitions.length === 0,
    `got ${transitions.length} transition(s) before claiming`,
  )

  // Simulate the DB atomically allocating generation 43 for this
  // process (e.g. a restart after 42 prior generations already
  // accumulated) -- the fake claim function stands in for
  // SupabaseSync.claimGeneration()'s real RPC call.
  const claimed: number[] = []
  await provider.claimDbGeneration(async (clubId) => {
    claimed.push(1)
    check('claimDbGeneration is called with this provider\'s own clubId', clubId === 'test-club-id')
    return 43
  })
  check('claimDbGeneration invokes the injected claim function exactly once', claimed.length === 1)

  setState('connecting')
  setState('qr_required', { qr: 'fake-qr-for-test-only' })
  setState('connected', { connectedPhoneNumber: '971500000000' })

  check('every transition after claiming carries a fencing object, never undefined', transitions.every((t) => t.fencing !== undefined))
  check(
    'every transition after claiming uses the claimed DB generation (43), never a bare in-process counter starting at 0/1',
    transitions.every((t) => t.fencing!.generation === 43),
    JSON.stringify(transitions.map((t) => t.fencing?.generation)),
  )
  check(
    'stateSeq is strictly increasing across transitions, never repeated or reset',
    transitions[0]!.fencing!.stateSeq < transitions[1]!.fencing!.stateSeq && transitions[1]!.fencing!.stateSeq < transitions[2]!.fencing!.stateSeq,
    JSON.stringify(transitions.map((t) => t.fencing?.stateSeq)),
  )
  check(
    'generation stays the same across transitions within one connection attempt (only re-claimed on a real process restart, tested separately via the live DB atomic-claim test)',
    transitions[0]!.fencing!.generation === transitions[1]!.fencing!.generation && transitions[1]!.fencing!.generation === transitions[2]!.fencing!.generation,
  )

  // A second claimDbGeneration() call must be a no-op (idempotent) --
  // this provider already has a generation for its lifetime; calling
  // it again (e.g. an accidental double-call) must never silently
  // re-claim and shift the generation mid-process.
  const secondClaimAttempts: number[] = []
  await provider.claimDbGeneration(async () => {
    secondClaimAttempts.push(1)
    return 999
  })
  check('a second claimDbGeneration() call is a no-op, never re-claims', secondClaimAttempts.length === 0)

  console.log(`\n[statusFencingTest] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[statusFencingTest] fatal error:', err)
  process.exit(1)
})
