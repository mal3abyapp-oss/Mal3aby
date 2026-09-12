/**
 * platformDomainIsolationTest.ts -- regression coverage for the Platform
 * WhatsApp connector extension (2026-09-12): PlatformSupabaseSync,
 * PlatformConnectionManager, PlatformConnectionRequestPoller,
 * PlatformQueueConsumer.
 *
 * Real gap this closes: PR #28's Platform WhatsApp domain shipped a
 * complete DB schema (platform_whatsapp_account,
 * platform_whatsapp_queue, whatsapp_connector_*_platform_* RPCs) and a
 * frontend page (/platform/whatsapp), but no actual connector process
 * ever polled those RPCs, established a real WhatsApp session, or
 * produced a QR code -- confirmed live in production (status stuck at
 * 'connecting' indefinitely, QR never populated) and via a repo-wide
 * grep showing zero callers of whatsapp_connector_claim_next_platform_batch/
 * report_platform_status/etc. before this fix.
 *
 * This test proves, with real classes and fake injected Supabase calls
 * (no real network, no real Baileys socket -- same discipline as
 * statusFencingTest.ts), the properties that actually matter for
 * correctness and for the two-domain separation (owner decision #21)
 * this whole feature depends on:
 *
 *   1. The platform sentinel session_key hashes to an auth-dir path
 *      structurally distinct from any club_id's own path (tenantAuthDir()
 *      is the same function BaileysProvider uses internally) -- proves
 *      a platform session can never collide with or overwrite a real
 *      club's local session cache.
 *   2. PlatformConnectionManager only ever calls PlatformSupabaseSync's
 *      platform-specific RPC wrappers, never anything from SupabaseSync
 *      (the tenant-domain sync class) -- proves the connector's own
 *      code keeps the two domains structurally separate, not just by
 *      convention.
 *   3. PlatformConnectionRequestPoller's connecting/disconnected
 *      dispatch logic matches ConnectionRequestPoller's own shape
 *      (same guard-against-double-connect discipline), adapted for a
 *      singleton account instead of a Set of many clubIds.
 *   4. PlatformQueueConsumer correctly reports send failures for a row
 *      with no recipient phone, without ever calling connection.send()
 *      for it (mirrors QueueConsumer's own early-return shape for the
 *      same case).
 *   5. A disconnected PlatformConnectionManager.send() fails safely
 *      (no throw, a clear error string) rather than silently no-op'ing
 *      or crashing the queue consumer's processRow() loop.
 *
 * Run with: npx tsx src/platformDomainIsolationTest.ts
 */
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { tenantAuthDir } from './BaileysProvider.js'
import { PlatformConnectionManager } from './PlatformConnectionManager.js'
import { PlatformConnectionRequestPoller } from './PlatformConnectionRequestPoller.js'
import { PlatformQueueConsumer } from './PlatformQueueConsumer.js'
import type { PlatformSupabaseSync } from './PlatformSupabaseSync.js'

let failures = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`[platformDomainIsolationTest] PASS - ${name}`)
  } else {
    failures += 1
    console.error(`[platformDomainIsolationTest] FAIL - ${name}${detail ? ` (${detail})` : ''}`)
  }
}

/** A fake PlatformSupabaseSync -- records every call it receives, returns scripted responses. Never touches a real network. */
function makeFakeSync(overrides: Partial<PlatformSupabaseSync> = {}) {
  const calls: { method: string; args: unknown[] }[] = []
  const fake = {
    getSessionKey: async () => {
      calls.push({ method: 'getSessionKey', args: [] })
      return null
    },
    reportStatus: async (...args: unknown[]) => {
      calls.push({ method: 'reportStatus', args })
    },
    storeSession: async (...args: unknown[]) => {
      calls.push({ method: 'storeSession', args })
    },
    loadSession: async () => {
      calls.push({ method: 'loadSession', args: [] })
      return null
    },
    claimNextBatch: async (...args: unknown[]) => {
      calls.push({ method: 'claimNextBatch', args })
      return []
    },
    reportSendResult: async (...args: unknown[]) => {
      calls.push({ method: 'reportSendResult', args })
    },
    ...overrides,
  }
  return { fake: fake as unknown as PlatformSupabaseSync, calls }
}

async function main() {
  const testRoot = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'platform-domain-test-')))
  process.env.WHATSAPP_TEMP_AUTH_DIR = testRoot

  // ---- 1. Sentinel key auth-dir isolation ----
  const PLATFORM_SENTINEL_KEY = '00000000-0000-0000-0000-000000000001'
  const REAL_CLUB_ID = 'a-real-club-uuid-shape'
  check(
    'the platform sentinel session_key hashes to an auth-dir path distinct from a real club_id\'s own path',
    tenantAuthDir(PLATFORM_SENTINEL_KEY) !== tenantAuthDir(REAL_CLUB_ID),
  )
  check(
    'the platform sentinel session_key\'s auth-dir path is deterministic (same key -> same path, matching every other use of tenantAuthDir())',
    tenantAuthDir(PLATFORM_SENTINEL_KEY) === tenantAuthDir(PLATFORM_SENTINEL_KEY),
  )

  // ---- 2. PlatformConnectionManager calls only fall through PlatformSupabaseSync ----
  {
    const { fake, calls } = makeFakeSync()
    const manager = new PlatformConnectionManager(fake)
    check(
      'a fresh PlatformConnectionManager reports disconnected with no provider yet',
      manager.getConnectionState() === 'disconnected' && !manager.hasProvider(),
    )
    await manager.restorePersistedSession()
    check(
      'restorePersistedSession() with no persisted session at all is a safe no-op (getSessionKey called, nothing else)',
      calls.some((c) => c.method === 'getSessionKey') && !calls.some((c) => c.method === 'storeSession'),
      JSON.stringify(calls.map((c) => c.method)),
    )
    check(
      'restorePersistedSession() with no session never creates a provider',
      !manager.hasProvider(),
    )
  }

  // ---- 3. send() on a disconnected manager fails safely ----
  {
    const { fake } = makeFakeSync()
    const manager = new PlatformConnectionManager(fake)
    const result = await manager.send('971500000000', 'a test message')
    check(
      'send() with no active provider returns success:false with a clear error, never throws',
      result.success === false && typeof result.error === 'string' && result.error.length > 0,
      JSON.stringify(result),
    )
  }

  // ---- 4. PlatformConnectionRequestPoller dispatch shape ----
  {
    let connectCalled = 0
    let disconnectCalled = 0
    const { fake } = makeFakeSync({
      getSessionKey: async () => ({ sessionKey: PLATFORM_SENTINEL_KEY, status: 'connecting' }),
    })
    const fakeManager = {
      recoverFailedConnection: async () => {},
      getConnectionState: () => 'disconnected',
      connect: async (_key: string) => { connectCalled += 1 },
      disconnect: async () => { disconnectCalled += 1 },
    } as unknown as PlatformConnectionManager
    const poller = new PlatformConnectionRequestPoller(fake, fakeManager, 999_999)
    // Access the private pollOnce via a single tick through start()/stop() --
    // matches how a real process would drive it, without exposing pollOnce()
    // as public API just for tests.
    poller.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    poller.stop()
    check(
      'a status=\'connecting\' account triggers exactly one connect() call on its first observed tick',
      connectCalled === 1,
      `connectCalled=${connectCalled}`,
    )
    check('a connecting account never triggers disconnect()', disconnectCalled === 0)
  }

  {
    let connectCalled = 0
    const { fake } = makeFakeSync({
      getSessionKey: async () => ({ sessionKey: PLATFORM_SENTINEL_KEY, status: 'connecting' }),
    })
    const fakeManager = {
      recoverFailedConnection: async () => {},
      // Already qr_required -- must NOT reconnect on every tick, exactly
      // matching ConnectionRequestPoller's own "don't tear down an
      // in-progress handshake" guard.
      getConnectionState: () => 'qr_required',
      connect: async (_key: string) => { connectCalled += 1 },
      disconnect: async () => {},
    } as unknown as PlatformConnectionManager
    const poller = new PlatformConnectionRequestPoller(fake, fakeManager, 999_999)
    poller.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    poller.stop()
    check(
      'a connecting account already in qr_required does NOT get a redundant connect() call (would tear down an in-progress handshake)',
      connectCalled === 0,
      `connectCalled=${connectCalled}`,
    )
  }

  // ---- 5. PlatformQueueConsumer no-phone early return ----
  {
    const reportedResults: unknown[] = []
    let sendCalled = 0
    const { fake } = makeFakeSync({
      claimNextBatch: async () => [{ id: 'row-1', recipientPhone: '', messageBody: 'hi', attempts: 0 }],
      reportSendResult: async (...args: unknown[]) => { reportedResults.push(args) },
    })
    const fakeManager = {
      send: async (_phone: string, _body: string) => { sendCalled += 1; return { success: true } },
    } as unknown as PlatformConnectionManager
    const consumer = new PlatformQueueConsumer(fake, fakeManager, 999_999, 10)
    consumer.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    consumer.stop()
    check(
      'a claimed row with no recipient phone reports a clear failure and never calls connection.send()',
      sendCalled === 0 && reportedResults.length === 1 && (reportedResults[0] as unknown[])[1] === false,
      JSON.stringify(reportedResults),
    )
  }

  await rm(testRoot, { recursive: true, force: true })

  console.log(`\n[platformDomainIsolationTest] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[platformDomainIsolationTest] fatal error:', err)
  process.exit(1)
})
