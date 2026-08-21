/**
 * authDirClearedOnLogoutTest.ts -- regression coverage for the
 * QR-pairing-after-logout fix (2026-08-21, real production incident):
 * a WhatsApp-side logout (connection.update's own loggedOut disconnect
 * branch, distinct from an explicit operator-initiated logout() call)
 * must clear the local auth directory, or the NEXT pairing attempt's
 * useMultiFileAuthState() call re-reads the same dead, WhatsApp-
 * invalidated creds.json and Baileys attempts to RESUME the old
 * identity instead of starting a genuinely fresh handshake --
 * WhatsApp's own servers then reject the resume with ANOTHER loggedOut
 * disconnect, before ever offering a QR. Confirmed live: 5 consecutive
 * real pairing attempts on production each cycled
 * connecting -> logged_out in 2-6 seconds, zero QR ever emitted.
 *
 * HONEST COVERAGE NOTE: the actual new code (inside
 * BaileysProvider's private connection.update handler, reached only
 * when a real Baileys socket receives a genuine loggedOut disconnect
 * from WhatsApp's servers) is not independently unit-testable without
 * a real or heavily-mocked Baileys socket -- this repo does not mock
 * @whiskeysockets/baileys anywhere, and doing so here would test the
 * mock's behavior, not the real integration. What this test DOES prove
 * with a real filesystem, no mocking: (1) tenantAuthDir()'s hashing is
 * deterministic and matches what a real pairing attempt would look up,
 * and (2) the exact same cleanup primitive the new code path calls
 * (`rm(tenantAuthDir(clubId), { recursive: true, force: true })`,
 * identical to what BaileysProvider.logout() has always correctly done)
 * genuinely removes a real directory containing files shaped like a
 * real Baileys auth dir (creds.json + a session-*.json file), proving
 * the cleanup PRIMITIVE is correct. The wiring of that call into the
 * new loggedOut branch itself was verified via direct code reading
 * (BaileysProvider.ts's connection.update handler, the loggedOut
 * branch) and via a real production pairing-attempt regression test
 * after deploy (see the WhatsApp QR pairing final acceptance report)
 * -- not by this file alone.
 *
 * Run with: npx tsx src/authDirClearedOnLogoutTest.ts
 */
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { tenantAuthDir } from './BaileysProvider.js'

let failures = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`[authDirClearedOnLogoutTest] PASS - ${name}`)
  } else {
    failures += 1
    console.error(`[authDirClearedOnLogoutTest] FAIL - ${name}${detail ? ` (${detail})` : ''}`)
  }
}

async function main() {
  // Isolate this test's filesystem effects from any real connector
  // process that might be running -- WHATSAPP_TEMP_AUTH_DIR is the same
  // env var BaileysProvider itself reads, so pointing it at a disposable
  // temp root here means this test's tenantAuthDir() calls resolve
  // under that root, never touching a real club's real auth directory.
  const testRoot = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'authdir-test-')))
  process.env.WHATSAPP_TEMP_AUTH_DIR = testRoot

  const CLUB_A = 'test-club-a'
  const CLUB_B = 'test-club-b'

  check(
    'tenantAuthDir() is deterministic -- the same clubId always resolves to the same path',
    tenantAuthDir(CLUB_A) === tenantAuthDir(CLUB_A),
  )
  check(
    'tenantAuthDir() is tenant-isolated -- two different clubIds resolve to two different paths',
    tenantAuthDir(CLUB_A) !== tenantAuthDir(CLUB_B),
  )

  // Simulate a real Baileys auth dir's shape (creds.json + a per-contact
  // session file) -- the exact class of files the incident's stale-read
  // was reading back.
  const authDir = tenantAuthDir(CLUB_A)
  await mkdir(authDir, { recursive: true })
  await writeFile(path.join(authDir, 'creds.json'), JSON.stringify({ registered: true, fake: 'stale-dead-session' }))
  await writeFile(path.join(authDir, 'session-971500000000.0.json'), JSON.stringify({ fake: 'stale-per-contact-session' }))

  const beforeCleanup = await readdir(authDir)
  check('the simulated auth dir genuinely contains files before cleanup (test setup sanity check)', beforeCleanup.length === 2, JSON.stringify(beforeCleanup))

  // The exact same primitive the new loggedOut-branch fix calls, and
  // the exact same one logout() has always correctly called --
  // BaileysProvider.ts: rm(tenantAuthDir(this.clubId), { recursive: true, force: true })
  await rm(authDir, { recursive: true, force: true })

  let afterCleanupThrew = false
  try {
    await readdir(authDir)
  } catch {
    afterCleanupThrew = true
  }
  check('the auth dir no longer exists at all after the cleanup primitive runs', afterCleanupThrew)

  // Other clubs' auth dirs must be completely unaffected -- tenant
  // isolation must hold even during cleanup, not just during normal
  // operation.
  const otherAuthDir = tenantAuthDir(CLUB_B)
  await mkdir(otherAuthDir, { recursive: true })
  await writeFile(path.join(otherAuthDir, 'creds.json'), JSON.stringify({ registered: true, fake: 'a different club entirely' }))
  await rm(authDir, { recursive: true, force: true }) // idempotent re-run, simulating a second logout event landing on an already-cleared dir
  const otherStillExists = await readdir(otherAuthDir)
  check(
    'clearing one club\'s auth dir never touches a different club\'s auth dir',
    otherStillExists.length === 1 && otherStillExists[0] === 'creds.json',
    JSON.stringify(otherStillExists),
  )

  // force:true is what makes the real code path safe to call
  // unconditionally on every loggedOut transition, even one where the
  // dir was already cleared or never existed (e.g. a fresh pairing
  // attempt that never got far enough to write anything before its own
  // loggedOut) -- must never throw.
  let idempotentRerunThrew = false
  try {
    await rm(tenantAuthDir('a-club-with-no-auth-dir-at-all'), { recursive: true, force: true })
  } catch {
    idempotentRerunThrew = true
  }
  check('clearing a non-existent auth dir (force:true) never throws', !idempotentRerunThrew)

  await rm(testRoot, { recursive: true, force: true })

  console.log(`\n[authDirClearedOnLogoutTest] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[authDirClearedOnLogoutTest] fatal error:', err)
  process.exit(1)
})
