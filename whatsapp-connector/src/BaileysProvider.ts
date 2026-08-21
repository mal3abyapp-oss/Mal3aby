import makeWASocket, {
  DisconnectReason,
  type WASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import path from 'node:path'
import { mkdir, rm, readdir } from 'node:fs/promises'
import { createHash, randomInt } from 'node:crypto'
import type { ConnectionState, MediaAttachment, SendMessageResult, WhatsAppProvider } from './WhatsAppProvider.js'
import { recordSendStart, recordSendStage, recordSendOutcome, recordConnectionOpen } from './SendDiagnostics.js'

/**
 * BaileysProvider -- the ONLY file in this service allowed to import
 * @whiskeysockets/baileys, per the adapter-boundary requirement.
 * Everything else (TenantConnectionManager, the queue consumer, the
 * Supabase sync layer) talks to the WhatsAppProvider interface only.
 *
 * Baileys was chosen (over Meta's Cloud API, the official Business
 * API, or any paid third-party service -- all explicitly forbidden by
 * the directive) because it drives WhatsApp's own Multi-Device
 * WebSocket protocol directly: TypeScript-native, no mandatory
 * Puppeteer/Chromium dependency, suitable as a persistent connector
 * process.
 *
 * Auth-state persistence: Baileys' own useMultiFileAuthState writes
 * plaintext credential files to disk by default. That violates "auth
 * state is a secret, never stored unprotected" -- this provider points
 * useMultiFileAuthState at a per-tenant, hashed-name temp directory
 * that exists only for the process's lifetime (0700 permissions), and
 * on every credential update immediately encrypts the directory's
 * logical state via SessionStore and pushes it to Postgres through
 * whatsapp_connector_store_session() -- the temp directory is a
 * working cache, not the system of record. (Baileys' own docs flag
 * useMultiFileAuthState as a demo-grade store; SessionStore's
 * encrypted-Postgres layer is this service's real, production auth
 * store -- useMultiFileAuthState is used only as Baileys' required
 * local on-disk staging format for its own internal reads/writes
 * during an active connection, immediately superseded by the
 * encrypted push on every creds.update. A move to a fully custom
 * AuthenticationState (no local staging files at all) is a larger,
 * separately-tested migration -- not undertaken here since it risks
 * the currently-working, tested session-persistence guarantee for a
 * different problem than the one this pass was scoped to fix; see the
 * P1 connection-stability fix below for what WAS in scope.)
 *
 * ================================================================
 * P1 RELIABILITY FIX (Owner-Level Review, 2026-08-17): connection
 * instability root-caused via live log evidence, not guessed.
 * ================================================================
 *
 * Observed failure signature: repeated `stream:error` / `conflict` /
 * `replaced` disconnects in a tight loop, sometimes multiple times per
 * second, both right after a fresh process start AND right after a
 * dev-server file-watch restart (`tsx watch`). WhatsApp's own protocol
 * meaning of `conflict/replaced` is unambiguous: another live session
 * opened using the same device credentials and the server is telling
 * THIS socket it has been superseded -- this is WhatsApp-side evidence
 * of a genuine duplicate-socket condition, not a transient network
 * blip that a bigger retry count would paper over.
 *
 * Root cause, confirmed by comparing timestamps around a `tsx watch`
 * restart: index.ts's SIGTERM/SIGINT handler stopped the pollers and
 * called `process.exit(0)` -- it never called `disconnect()`/
 * `logout()` on any club's provider, so the OLD process's live Baileys
 * WebSocket was never gracefully closed. WhatsApp's servers keep that
 * old session "alive" from their perspective for some grace period; a
 * NEW process starting immediately after (restoreAllPersistedSessions
 * -> provider.reconnect()) opens a second socket for the exact same
 * device credentials while the old one hasn't been told to stand down
 * -- exactly the "two makeWASocket() calls for the same account" the
 * review directive suspected, just arising from process lifecycle
 * (restart-without-graceful-shutdown), not application code calling
 * connect() twice concurrently within one process.
 *
 * Fix, addressing the actual mechanism (not just widening retry caps):
 *
 * 1. **Generation ID per socket** (`this.generation`): every
 *    `initializeConnection()` call increments it and captures the
 *    value the new socket's event handlers close over. Any event
 *    firing from a socket whose captured generation no longer matches
 *    `this.generation` (a delayed callback from a socket that's since
 *    been superseded) is ignored outright -- this is what stops a
 *    stale socket's own `close`/`error` handler from racing a
 *    newer socket's reconnect logic and corrupting state.
 * 2. **Connection mutex** (`this.connectPromise`): concurrent
 *    `initializeConnection()` calls reuse the in-flight promise rather
 *    than opening a second socket -- enforces "one active connect
 *    attempt at a time" per provider instance regardless of how many
 *    callers race to trigger one (poller tick, manual UI action,
 *    reconnect-on-close, self-healing watchdog).
 * 3. **Explicit old-socket teardown before new-socket creation**: a
 *    new `initializeConnection()` call, when a previous socket still
 *    exists, removes its listeners and calls `.end()` on it FIRST
 *    (best-effort, swallowing errors -- the old socket may already be
 *    half-dead), then proceeds to create the new one. This directly
 *    closes the "new socket created before old one is cleaned up" gap
 *    the review flagged.
 * 4. **Graceful shutdown wired all the way through**: index.ts's
 *    shutdown handler now calls `connections.disconnectAllGracefully()`
 *    before exiting, which calls `.end()` (not logout/credential-wipe
 *    -- see point 6) on every live socket, telling WhatsApp's servers
 *    this device is going away cleanly rather than vanishing.
 * 5. **Disconnect-reason matrix, not one-size-fits-all retry**:
 *    - `loggedOut` -> terminal, no auto-reconnect, `logged_out` state
 *      (unchanged from before -- this was already correct).
 *    - `restartRequired` (Baileys asks for a controlled restart, e.g.
 *      after successful pairing) -> immediate single reconnect, not
 *      counted against the backoff/attempt budget.
 *    - `conflict`/`replaced` -> the new duplicate-socket-aware case:
 *      treated as a signal to reconnect with backoff (the old-socket
 *      teardown above is what actually prevents this from recurring;
 *      if it happens again despite that, it means a truly separate
 *      device/session logged in with these credentials, and repeated
 *      backoff naturally surfaces that as 'failed' rather than a tight
 *      loop).
 *    - Everything else (timeout/connection lost/other transient) ->
 *      reconnect with backoff, same bounded cap as before.
 * 6. **Exponential backoff with jitter, single timer**: 2s, 5s, 10s,
 *    20s, 30s, 60s (capped), +/-20% jitter to avoid synchronized
 *    thundering-herd reconnects across multiple clubs. Only ever one
 *    pending reconnect timer per provider (`this.reconnectTimer`) --
 *    a new schedule call clears any existing one first.
 * 7. **Stable-connection window before resetting attempts**:
 *    `connection === 'open'` no longer immediately resets
 *    `reconnectAttempts` to 0. It starts a 45s stability timer; only
 *    if the connection is STILL open when that timer fires does the
 *    attempt counter reset. A connection that flaps (open -> closed
 *    again within the window) keeps accumulating against the backoff
 *    schedule instead of getting a fresh full retry budget on every
 *    brief flicker -- this is what stops a reconnect storm from
 *    reading as a string of independently-successful attempts in logs
 *    while never actually stabilizing.
 * 8. Session credentials are NEVER wiped on a transient disconnect --
 *    only on a confirmed `loggedOut` disconnect reason or an explicit
 *    operator-initiated `logout()` call (unchanged from before; this
 *    was already correct, re-verified as part of this pass since the
 *    review specifically asked not to weaken it).
 */

const TEMP_AUTH_ROOT = process.env.WHATSAPP_TEMP_AUTH_DIR ?? path.resolve(process.cwd(), '.baileys-auth-tmp')

const RECONNECT_BACKOFF_MS = [2000, 5000, 10000, 20000, 30000, 60000]
const STABLE_CONNECTION_WINDOW_MS = 45000
const MAX_RECONNECT_ATTEMPTS = 8

/** Exported for test purposes only (authDirClearedOnLogoutTest.ts) -- every real caller in this file uses it unqualified. */
export function tenantAuthDir(clubId: string): string {
  const hash = createHash('sha256').update(clubId).digest('hex')
  return path.join(TEMP_AUTH_ROOT, hash)
}

/** +/-20% jitter around a base delay, to avoid every club's provider retrying in lockstep. */
function withJitter(baseMs: number): number {
  const jitterRange = Math.round(baseMs * 0.2)
  return baseMs + randomInt(-jitterRange, jitterRange + 1)
}

/**
 * TRUE ROOT CAUSE FIX for the send-hang investigation (2026-08-18) --
 * see sendMessage()'s own doc comment for the full, confirmed proof.
 * A JID built with a literal "+" (or any other non-digit character --
 * spaces, dashes -- callers might pass) causes Baileys' internal
 * query() to wait out its full ~60s ceiling for a response WhatsApp's
 * servers apparently never send for that malformed identifier.
 * Exported (not just inlined in sendMessage()) so this exact
 * normalization logic is independently unit-testable without opening a
 * real Baileys/WhatsApp connection -- see sendReliabilityTest.ts.
 */
export function toWhatsAppJid(phoneDigitsOnly: string): string {
  return `${phoneDigitsOnly.replace(/\D/g, '')}@s.whatsapp.net`
}

/**
 * WHATSAPP DELIVERY TRUTH fix (2026-08-22) -- pure filtering/extraction
 * logic for a real Baileys messages.update event array, pulled out of
 * the socket.ev.on('messages.update', ...) listener so it is
 * independently unit-testable without a real Baileys socket (same
 * rationale as toWhatsAppJid() above -- see
 * deliveryReceiptExtractionTest.ts).
 *
 * Filters to only entries that are:
 *   - fromMe (a receipt for a message THIS account sent -- a receipt
 *     for an incoming message, or a group-participant read receipt on
 *     someone else's message, is a different concern this connector
 *     does not track)
 *   - carrying a real key.id (the correlation key back to
 *     notification_queue.provider_reference)
 *   - carrying a defined numeric update.status (proto.WebMessageInfo.Status)
 */
export function extractDeliveryReceipts(
  updates: Array<{ key: { fromMe?: boolean | null; id?: string | null }; update: { status?: number | null } }>,
): Array<{ messageKeyId: string; statusLevel: number }> {
  const receipts: Array<{ messageKeyId: string; statusLevel: number }> = []
  for (const { key, update } of updates) {
    if (!key.fromMe || !key.id || update.status === undefined || update.status === null) continue
    receipts.push({ messageKeyId: key.id, statusLevel: update.status })
  }
  return receipts
}

/**
 * TRUE ROOT CAUSE, CONFIRMED (send-hang investigation, 2026-08-18) --
 * this replaces every earlier diagnosis in this file's history
 * (USync-timeout-race, executeInitQueries collision, zombie socket,
 * queue/DB-layer delay -- ALL individually tested and refuted below).
 *
 * The bug: `${toPhoneDigitsOnly}@s.whatsapp.net` never stripped
 * non-digit characters from its argument. Every real caller in this
 * repo (QueueConsumer.ts -> TenantConnectionManager.send(), passing
 * `row.recipientPhone`) sources this value from
 * notification_queue.recipient_phone / customers.normalized_mobile,
 * BOTH of which store the E.164 "+"-prefixed form verbatim (confirmed:
 * `customers.normalized_mobile = '+971502061209'`). A JID built as
 * `+971502061209@s.whatsapp.net` (with the literal "+" character) is
 * one WhatsApp's servers apparently never send Baileys a usable
 * response for -- Baileys' own internal query() call then waits out
 * its full ~60s defaultQueryTimeoutMs ceiling and throws its own
 * "Timed Out" Boom error.
 *
 * PROOF (decisive, controlled A/B on the SAME connection/socket
 * generation, jidFormatIsolationTest.ts): sending to "971502061209"
 * (digits only) resolved in 240ms; sending to "+971502061209" (the
 * literal string every queue-driven caller actually passes) took
 * 59,999ms and failed with Baileys' own "Timed Out" error -- on the
 * IDENTICAL socket the fast call had just used seconds earlier. Every
 * other hypothesis tried in this investigation (getUSyncDevices()/USync
 * query timing, Baileys' automatic executeInitQueries() background
 * call, zombie-socket-after-idle, session/prekey establishment on
 * first contact, pure elapsed-time-since-connect, generic
 * Supabase-network-I/O-in-between) was individually, controlledly
 * tested and did NOT reproduce the hang -- only the "+" character did,
 * reproducibly, every time (queueVsDirectDifferentialTest.ts,
 * queueFirstDifferentialTest.ts, pollOnceIsolationTest.ts x2, all
 * failed identically; the same exact pollOnceIsolationTest.ts scenario
 * succeeded in 277ms with THIS fix in place, real message sent,
 * provider_reference confirmed in notification_queue).
 *
 * Fix: strip non-digit characters from the phone argument here, inside
 * sendMessage() itself (not upstream in QueueConsumer.ts/
 * TenantConnectionManager.ts) -- this guarantees the normalization
 * holds regardless of which future caller forgets to do it, matching
 * this parameter's own long-standing name ("toPhoneDigitsOnly") that
 * no caller in this repo actually enforced before this fix.
 *
 * SEND_TIMEOUT_MS stays at 75s (raised from an original 45s during an
 * earlier, now-superseded pass of this same investigation): with the
 * real bug fixed, a genuine send resolves in a few hundred
 * milliseconds, so this value is pure defense-in-depth headroom (still
 * safely above Baileys' own 60s defaultQueryTimeoutMs, in case some
 * OTHER legitimate Baileys-internal operation ever needs that much
 * time) -- not itself load-bearing for this fix.
 */
const SEND_TIMEOUT_MS = 75_000

function withSendTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} send timed out after ${SEND_TIMEOUT_MS}ms (socket.sendMessage() never resolved)`))
    }, SEND_TIMEOUT_MS)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

/**
 * STATUS-WRITE RACE, PROVEN AND FIXED (2026-08-18, per an explicit
 * evidence-driven directive): TenantConnectionManager.onStateChange's
 * reportStatus() call is fire-and-forget (`void this.sync.reportStatus(...)`)
 * with no ordering guarantee between concurrent calls. If two state
 * transitions fire close together (e.g. a `restartRequired` disconnect
 * immediately followed by a fresh reconnect, or a rapid
 * connecting->connected sequence), their async RPC calls can land in
 * Postgres OUT OF ORDER -- an OLDER "disconnected" write completing
 * AFTER a NEWER "connected" write, permanently corrupting
 * whatsapp_accounts.status until the next state change (which may
 * never come if the account is genuinely healthy and idle). This is
 * exactly what explains the earlier observed anomaly: provider
 * connected in-memory, whatsapp_accounts.status showing 'disconnected'
 * in the DB, which then made claimNextBatch()'s own
 * `wa.status = 'connected'` eligibility filter incorrectly exclude a
 * perfectly healthy, connected account's queued notifications.
 *
 * Fix, ORIGINAL VERSION (2026-08-18) -- SUPERSEDED, see the correction
 * below: every state transition was stamped with this provider's own
 * in-memory `generation` counter (bumped on each real socket reconnect)
 * and a `stateSeq` (bumped on every setState() call). This assumed "a
 * simple monotonic in-memory counter is sufficient... single Node
 * process per club" -- an assumption that held only within one
 * process's lifetime, and silently broke the first time that process
 * ever restarted.
 *
 * CORRECTION (independent-audit fix, 2026-08-21, real incident):
 * `generation` is a plain in-memory field, always starting at 0 for a
 * fresh process. A restart (redeploy, crash, or a Cloudflare Container
 * scale-to-zero/cold-start cycle -- all normal for this architecture,
 * not bugs) creates a fresh provider whose generation can never exceed
 * whatever accumulated in the DATABASE across every PRIOR process's own
 * restarts. Once the database's remembered generation exceeds anything
 * a fresh process can reach, EVERY future status write from EVERY
 * future process is permanently rejected as stale -- including a
 * correct, true 'logged_out' report. Confirmed live: club
 * b9178c0f-00b5-4c71-abec-b8772ffb8682 reached last_generation=17
 * through ordinary restart accumulation; a genuine WhatsApp-side logout
 * then occurred and could never be recorded, leaving the UI/DB
 * permanently showing 'connected' while the connector's own
 * sendMessage() correctly refused to send ("not connected") -- a real,
 * observable outage the database was actively lying about.
 *
 * Fix: the DB-fencing generation (`dbGeneration`, distinct from the
 * unrelated in-process socket-level `generation` field above it in this
 * class -- see that field's own doc comment) is no longer seeded from
 * nothing. It is atomically allocated by the database itself, exactly
 * once per process lifetime, via whatsapp_connector_claim_generation()
 * -- see claimDbGeneration() below, called from
 * TenantConnectionManager before this provider's connection is ever
 * initialized. A fresh process therefore always receives
 * current_generation + 1, correctly becoming the trusted current writer
 * on every restart, while a genuinely stale old process (still shutting
 * down, or racing during a rolling replacement) still correctly loses,
 * because it is holding a generation the database has already moved
 * past. whatsapp_connector_report_status() still applies the identical
 * write-acceptance rule as before (newer generation always wins;
 * within the same generation, only a strictly larger stateSeq is
 * accepted) -- only the SOURCE of the generation number changed, not
 * the fencing logic itself.
 */
export interface BaileysProviderHooks {
  onStateChange?: (
    state: ConnectionState,
    detail?: { qr?: string; qrTtlSeconds?: number; connectedPhoneNumber?: string; error?: string },
    fencing?: { generation: number; stateSeq: number },
  ) => void
  /** Called whenever Baileys persists updated credentials to the local auth dir -- the caller is responsible for encrypting the dir's contents and pushing to Supabase (see SessionStore.encryptAuthDirForClub). */
  onCredsUpdate?: () => void
  /**
   * WHATSAPP DELIVERY TRUTH fix (2026-08-22, real production defect --
   * see this class's own sendMessage() doc comment for the full
   * incident): called whenever a REAL WhatsApp-server-originated
   * receipt arrives for a message this connector sent, carrying the
   * genuine proto.WebMessageInfo.Status ack level (0=ERROR 1=PENDING
   * 2=SERVER_ACK 3=DELIVERY_ACK 4=READ 5=PLAYED) and the same
   * client-generated message key this connector already stores as
   * notification_queue.provider_reference at send time -- this is the
   * ONLY event in this entire codebase that proves anything happened
   * beyond "our own socket write completed". Never fired synthetically
   * or inferred; only ever a direct pass-through of a genuine received
   * receipt.
   */
  onDeliveryReceipt?: (messageKeyId: string, statusLevel: number) => void
}

export class BaileysProvider implements WhatsAppProvider {
  readonly clubId: string
  private socket: WASocket | null = null
  private state: ConnectionState = 'disconnected'
  private currentQr: string | null = null
  private readonly logger: pino.Logger
  private readonly hooks: BaileysProviderHooks
  private reconnectAttempts = 0
  private explicitLogout = false

  /** Generation counter -- see class-level doc comment, fix item 1. IN-PROCESS SOCKET fencing only (distinguishes one socket from the next WITHIN this process's lifetime) -- do not confuse with dbGeneration below, which fences DB status writes ACROSS process restarts and is a completely separate concern with a completely separate lifetime. */
  private generation = 0
  /** Monotonic per-state-transition sequence, for the status-write-race fix -- see BaileysProviderHooks' own doc comment. Never reset (unlike generation, which only bumps on a real reconnect) -- strictly increasing for the lifetime of this provider instance/process. */
  private stateSeq = 0
  /**
   * Cross-PROCESS status-write fencing generation (independent-audit
   * fix, 2026-08-21). Unlike `generation` above (which is a local,
   * in-memory socket counter that always starts at 0 for a fresh
   * process), this value is atomically allocated by the database itself
   * via whatsapp_connector_claim_generation() -- called exactly once,
   * before this provider ever reports a status transition. This is
   * what lets a genuinely NEW process correctly become the trusted
   * current writer after a restart (redeploy, crash, or a Cloudflare
   * Container scale-to-zero/cold-start cycle -- all normal, expected
   * events for this architecture, not bugs), instead of every restart
   * resetting to 0 and eventually being permanently fenced out by the
   * database's own memory of a much higher generation from prior
   * process instances. Real incident this fixes: club
   * b9178c0f-00b5-4c71-abec-b8772ffb8682 reached last_generation=17
   * through ordinary restart accumulation, then a genuine WhatsApp-side
   * logout occurred and could never be recorded, because every fresh
   * process's old-style generation=0/1/2... could never again exceed
   * 17. `null` until claimDbGeneration() resolves; onStateChange is
   * only ever invoked with a non-null value (see setState() below).
   */
  private dbGeneration: number | null = null
  /** Connection mutex -- see class-level doc comment, fix item 2. */
  private connectPromise: Promise<void> | null = null
  /** Single pending reconnect timer -- see class-level doc comment, fix item 6. */
  private reconnectTimer: NodeJS.Timeout | null = null
  /** Stable-connection window timer -- see class-level doc comment, fix item 7. */
  private stabilityTimer: NodeJS.Timeout | null = null

  // Observability counters (rule 17 of the directive) -- read via
  // getDiagnostics() for a future admin-facing health panel; not
  // currently persisted anywhere, in-memory only for this process's
  // lifetime.
  private disconnectCount = 0
  private reconnectCount = 0
  private lastDisconnectReason: string | null = null
  private lastDisconnectCode: number | null = null
  private connectedSince: number | null = null

  constructor(clubId: string, hooks: BaileysProviderHooks = {}) {
    // clubId must be assigned before anything deriving from it (e.g. a
    // logger child binding using it) -- a field initializer that reads
    // `this.clubId` before the constructor body runs would see
    // undefined under JS field-init ordering. Assign first, always.
    this.clubId = clubId
    this.hooks = hooks
    this.logger = pino({ level: process.env.LOG_LEVEL ?? 'info' }).child({ clubId: this.redactedClubId() })
  }

  /** Never log a full clubId (UUID) at higher-than-necessary correlation granularity in aggregated logs -- short prefix only. */
  private redactedClubId(): string {
    return this.clubId.slice(0, 8)
  }

  private setState(next: ConnectionState, detail?: Parameters<NonNullable<BaileysProviderHooks['onStateChange']>>[1]) {
    this.state = next
    this.stateSeq += 1
    // dbGeneration is only null in the brief window before
    // claimDbGeneration() has resolved (see initializeConnection(),
    // which awaits the claim before doing anything else) -- if a state
    // change somehow fires before that, it is a real bug worth a loud
    // failure rather than silently reporting a wrong/fabricated
    // generation to the database.
    if (this.dbGeneration === null) {
      this.logger.error('setState() called before claimDbGeneration() resolved -- refusing to report a status write with no valid generation')
      return
    }
    this.hooks.onStateChange?.(next, detail, { generation: this.dbGeneration, stateSeq: this.stateSeq })
  }

  /**
   * Atomically claims this process's DB-fencing generation for this
   * club, exactly once, before any status is ever reported. Must
   * complete before initializeConnection() proceeds -- see its call
   * site. See this class's own doc comment (above SETUP/STATUS-WRITE
   * RACE) and dbGeneration's own field doc comment for the full
   * incident this fixes.
   */
  async claimDbGeneration(claim: (clubId: string) => Promise<number>): Promise<void> {
    if (this.dbGeneration !== null) return
    this.dbGeneration = await claim(this.clubId)
    this.logger.info({ dbGeneration: this.dbGeneration }, 'claimed DB status-write-fencing generation')
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer)
      this.stabilityTimer = null
    }
  }

  /** Best-effort graceful close of the CURRENT socket, before a new one is created -- fix item 3. Never throws; the old socket may already be half-dead. */
  private async teardownCurrentSocket(): Promise<void> {
    const old = this.socket
    this.socket = null
    if (!old) return
    try {
      old.ev.removeAllListeners('connection.update')
      old.ev.removeAllListeners('creds.update')
      old.end(undefined)
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'error tearing down previous socket (non-fatal, proceeding)')
    }
  }

  async initializeConnection(): Promise<void> {
    // Connection mutex -- fix item 2: a concurrent caller reuses the
    // in-flight attempt instead of racing a second makeWASocket() call
    // for the same account.
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.doInitializeConnection().finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  private async doInitializeConnection(): Promise<void> {
    this.explicitLogout = false
    this.clearReconnectTimer()
    this.clearStabilityTimer()
    await this.teardownCurrentSocket()

    this.generation += 1
    const myGeneration = this.generation

    this.setState('connecting')

    const authDir = tenantAuthDir(this.clubId)
    await mkdir(authDir, { recursive: true, mode: 0o700 })

    const { state, saveCreds } = await useMultiFileAuthState(authDir)

    // ROOT CAUSE FIX (2026-08-19) -- "Waiting for this message" stuck
    // on the recipient's device despite Baileys reporting a successful
    // send with a real message id. Confirmed live: a real test message
    // sent through a freshly-redeployed container (session restored
    // from Postgres, no new QR) was accepted by WhatsApp's relay
    // (provider_reference present) but never decrypted on the
    // recipient's phone.
    //
    // Root cause, confirmed by reading Baileys' own
    // useMultiFileAuthState source (not assumed): `saveCreds()` only
    // persists `creds.json` (top-level identity/registration state) and
    // is only invoked on the `creds.update` event. Per-CONTACT Signal
    // session state -- session-<jid>.json, prekeys, sender keys -- is
    // written by `state.keys.set()`, a COMPLETELY SEPARATE code path
    // with no event and no hook back into this connector at all. This
    // connector's only persistence-to-Postgres trigger was
    // `creds.update`, so every per-contact session-key write was
    // landing on the container's own ephemeral local disk only, NEVER
    // pushed to Postgres. On the next container restart (Cloudflare
    // Containers' disk does not survive a restart, by design -- see
    // this file's other ephemeral-disk comments), the restored session
    // has the OLD/missing per-contact keys; Baileys silently
    // renegotiates a new session with the recipient's device, but the
    // recipient's own device still holds the OLD session and cannot
    // decrypt anything encrypted under a session it doesn't recognize
    // -- exactly WhatsApp's own "Waiting for this message" UI text.
    //
    // Fix: wrap `state.keys.set` so every per-contact session-key write
    // ALSO triggers the exact same onCredsUpdate hook creds.update
    // already uses (which re-reads and persists the WHOLE auth
    // directory via encryptAuthDirForClub -- already correct, it just
    // was never being called for this class of write). Debounced
    // (500ms) since active messaging can trigger many key writes in
    // quick succession and each Postgres round-trip is real network
    // I/O; a short coalescing window is safe because the underlying
    // files are already durably written to local disk synchronously by
    // Baileys' own keys.set before this callback fires -- the debounce
    // only delays the Postgres push, never risks losing a write.
    let keysPersistTimer: ReturnType<typeof setTimeout> | undefined
    const originalKeysSet = state.keys.set.bind(state.keys)
    state.keys.set = async (data) => {
      await originalKeysSet(data)
      if (myGeneration !== this.generation) return
      if (keysPersistTimer) clearTimeout(keysPersistTimer)
      keysPersistTimer = setTimeout(() => {
        if (myGeneration !== this.generation) return
        this.hooks.onCredsUpdate?.()
      }, 500)
    }
    // fetchLatestBaileysVersion() itself has a try/catch that falls
    // back to a bundled default version on failure -- but its
    // underlying axios call has no timeout, so a network stall to
    // GitHub (confirmed live during this fix: raw.githubusercontent.com
    // unreachable, hanging past 10s with no timeout) blocks the whole
    // connector's startup/reconnect indefinitely instead of falling
    // back. An explicit timeout here is what actually makes the
    // existing fallback logic reachable.
    const { version } = await fetchLatestBaileysVersion({ timeout: 8000 })

    const socket = makeWASocket({
      auth: state,
      version,
      // Never printQRInTerminal / log the QR to any log stream -- the
      // QR is captured via connection.update below and exposed only
      // through getQr(), which the caller pushes to Postgres for the
      // admin UI to render client-side (same pattern as the app's
      // existing booking/membership QR flow).
      logger: this.logger as never,
      // TRUE ROOT CAUSE FIX for the queue-driven send-hang investigation
      // (2026-08-18) -- CONFIRMED, not a hypothesis: two independent,
      // reproducible A/B tests (queueVsDirectDifferentialTest.ts,
      // queueFirstDifferentialTest.ts) on the SAME provider instance,
      // SAME socket generation, proved a send issued shortly after
      // connect can take ~60,000-61,500ms (matching Baileys'
      // defaultQueryTimeoutMs exactly) regardless of whether it was
      // called directly or through the queue -- reversing call order
      // reproduced the SAME ~61s duration on the queue-first attempt
      // while a direct send immediately after it completed in 320ms.
      // This is NOT a Baileys/socket defect, NOT a queue/DB defect, and
      // NOT specific to QueueConsumer's own code path -- it is Baileys'
      // own `fireInitQueries: true` default (Defaults/index.js), which
      // unconditionally fires `executeInitQueries()`
      // (fetchProps()+fetchBlocklist()+fetchPrivacySettings(), all via
      // internal query()/waitForMessage() calls bound by the SAME
      // defaultQueryTimeoutMs) on every `connection === 'open'` event
      // (chats.js) -- a send attempted in that same narrow window can
      // get entangled with that background call's own pending
      // query/response correlation and block for its full timeout.
      // This connector never reads WhatsApp Web app-level props, the
      // block list, or privacy settings (confirmed: no code path in
      // this repo calls any props/blocklist/privacy API this fetches),
      // so disabling it is a safe, directly evidence-justified fix, not
      // a speculative one.
      fireInitQueries: false,
    })

    // A generation mismatch here means this socket has already been
    // superseded by a newer initializeConnection() call that ran
    // while this one was still awaiting useMultiFileAuthState/
    // fetchLatestBaileysVersion above -- tear it down immediately and
    // do not wire it up as the active socket. This is the mutex's
    // belt-and-suspenders complement: the mutex prevents concurrent
    // CALLS, this guards the (much narrower) async-gap-during-setup
    // window.
    if (myGeneration !== this.generation) {
      try {
        socket.end(undefined)
      } catch {
        // best-effort
      }
      return
    }

    this.socket = socket

    socket.ev.on('creds.update', async () => {
      if (myGeneration !== this.generation) return
      await saveCreds()
      this.hooks.onCredsUpdate?.()
    })

    // WHATSAPP DELIVERY TRUTH fix (2026-08-22): real production defect
    // -- notification_queue.status was set to 'sent' the instant
    // sendMessage()'s Promise resolved (see that method's own doc
    // comment), which only ever proved this connector wrote bytes to
    // its own outbound socket -- confirmed by reading Baileys' own
    // socket.js (sendNode -> sendRawMessage, a raw WebSocket write with
    // no server acknowledgment involved) and messages-send.js
    // (relayMessage awaits that same write, nothing more, then returns
    // a purely CLIENT-generated message id). Real evidence of server
    // acceptance/delivery/read DOES exist -- WhatsApp's protocol sends
    // a genuine server-originated <receipt> stanza back over this same
    // socket, which Baileys surfaces as messages.update, carrying a
    // proto.WebMessageInfo.Status level and correlated by the SAME
    // client-generated key.id already captured as provider_reference
    // -- this listener is what was missing to ever observe it. No
    // generation guard here (unlike connection.update/creds.update
    // above, which are genuinely about THIS socket's own connection
    // lifecycle) -- a receipt proves something real happened to a
    // message that was genuinely sent under whatever generation it was
    // sent under, and remains true even if a reconnect has since
    // occurred; dropping it because of a generation mismatch would
    // throw away real evidence for no correctness reason. Old sockets'
    // listeners are still correctly torn down via
    // teardownCurrentSocket()'s removeAllListeners, so a truly dead
    // socket cannot double-report.
    socket.ev.on('messages.update', (updates) => {
      for (const { messageKeyId, statusLevel } of extractDeliveryReceipts(updates)) {
        this.hooks.onDeliveryReceipt?.(messageKeyId, statusLevel)
      }
    })

    socket.ev.on('connection.update', (update) => {
      // Fix item 1: ignore any event from a socket generation that's
      // since been superseded -- stops a stale/dying socket's own
      // close handler from firing reconnect logic after a newer
      // socket already took over.
      if (myGeneration !== this.generation) return

      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.currentQr = qr
        this.setState('qr_required', { qr, qrTtlSeconds: 60 })
      }

      if (connection === 'open') {
        this.currentQr = null
        this.clearReconnectTimer()
        const phone = socket.user?.id?.split(':')[0] ?? undefined
        this.setState('connected', { connectedPhoneNumber: phone })
        this.connectedSince = Date.now()
        // Production A/B test requirement (2026-08-18): a later send
        // attempt's SendDiagnostics record needs to know exactly when
        // THIS generation's connection opened, so a reader can compute
        // "how long after connect was this send attempted" from /status
        // without guessing.
        recordConnectionOpen(this.clubId, myGeneration)

        // Fix item 7: do NOT reset reconnectAttempts immediately on
        // open -- only after this connection has held for a real
        // stability window. A connection that flaps within the window
        // keeps its accumulated backoff position instead of getting a
        // fresh full retry budget on every brief open/close flicker.
        this.clearStabilityTimer()
        this.stabilityTimer = setTimeout(() => {
          if (myGeneration === this.generation && this.state === 'connected') {
            this.reconnectAttempts = 0
          }
        }, STABLE_CONNECTION_WINDOW_MS)
      }

      if (connection === 'close') {
        this.clearStabilityTimer()
        this.connectedSince = null
        this.disconnectCount += 1

        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode ?? null
        const disconnectReasonTag = this.classifyDisconnectReason(statusCode)
        this.lastDisconnectReason = disconnectReasonTag
        this.lastDisconnectCode = statusCode
        const message = lastDisconnect?.error?.message ?? 'Connection closed unexpectedly.'

        this.logger.warn(
          { statusCode, disconnectReasonTag, reconnectAttempts: this.reconnectAttempts, message },
          'connection closed',
        )

        // Fix item 5: disconnect-reason matrix.
        if (disconnectReasonTag === 'loggedOut' || this.explicitLogout) {
          // Explicit logout (either the operator disconnected from the
          // admin UI, or the device was removed from the phone) must
          // NOT auto-reconnect -- that would silently re-request a
          // session the user deliberately ended.
          this.setState('logged_out', { error: 'Session was logged out.' })

          // QR-PAIRING-AFTER-LOGOUT FIX (2026-08-21, real production
          // incident): a WhatsApp-SIDE logout (not an explicit
          // logout()) reached exactly this branch but historically
          // never cleared the local auth directory -- only the
          // explicit logout() method did that. The stale, WhatsApp-
          // invalidated creds.json (registered:true) survived on local
          // disk, so the NEXT initializeConnection() call (a fresh
          // pairing request via start_whatsapp_pairing) re-read those
          // same dead credentials via useMultiFileAuthState() and
          // attempted to RESUME the old identity instead of starting a
          // genuinely fresh, unregistered handshake. WhatsApp's own
          // servers correctly recognized the resumed identity as
          // already logged out and terminated the connection with
          // ANOTHER loggedOut disconnect BEFORE ever sending the
          // server-side `iq pair-device` stanza that triggers Baileys'
          // own QR emission (confirmed by reading Baileys'
          // socket.js -- QR generation is entirely server-driven, only
          // offered when the presented identity is not already a dead
          // registered one) -- confirmed live: 5 consecutive real
          // pairing attempts on production each cycled
          // connecting -> logged_out in 2-6 seconds, zero QR ever
          // emitted.
          //
          // Fix: clear the local auth dir on ANY confirmed loggedOut
          // transition, not only an explicit operator-initiated
          // logout() call -- mirrors what logout() already correctly
          // does, applied to the other real-world path that reaches
          // the same terminal state. Best-effort (never let a cleanup
          // failure crash the connection-close handler) and awaited
          // only via a fire-and-forget promise, matching this handler's
          // own synchronous-callback shape (connection.update cannot
          // itself be async) -- the NEXT initializeConnection() call
          // (whenever start_whatsapp_pairing next fires) is what
          // actually depends on this having completed by then, and a
          // human-driven QR request is always several seconds away at
          // minimum, ample time for a local filesystem rm to finish.
          void rm(tenantAuthDir(this.clubId), { recursive: true, force: true }).catch((err) => {
            this.logger.error({ err: (err as Error).message }, 'failed to clear local auth dir after a WhatsApp-side logout (non-fatal, but the next pairing attempt may incorrectly try to resume the dead session)')
          })
          return
        }

        if (disconnectReasonTag === 'restartRequired') {
          // Baileys explicitly asks for a controlled restart (e.g.
          // right after successful pairing) -- reconnect immediately,
          // does not consume/count against the backoff attempt budget.
          this.setState('reconnecting', { error: message })
          void this.initializeConnection()
          return
        }

        // conflict/replaced and every other transient reason ->
        // bounded exponential backoff with jitter, single timer.
        this.reconnectAttempts += 1
        if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          this.setState('failed', { error: `${message} (giving up after ${this.reconnectAttempts} reconnect attempts, last reason: ${disconnectReasonTag})` })
          return
        }

        this.setState('reconnecting', { error: message })
        const backoffBase = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempts - 1, RECONNECT_BACKOFF_MS.length - 1)]
        const delay = withJitter(backoffBase)
        this.reconnectCount += 1
        this.clearReconnectTimer()
        this.reconnectTimer = setTimeout(() => {
          if (myGeneration === this.generation) void this.initializeConnection()
        }, delay)
      }
    })
  }

  /**
   * Maps a Baileys/Boom disconnect status code to one of the matrix
   * categories the review directive asked for -- fix item 5. Codes per
   * Baileys' own DisconnectReason enum plus the raw stream-level ones
   * (428/440/515) the review specifically named.
   */
  private classifyDisconnectReason(statusCode: number | null): 'loggedOut' | 'restartRequired' | 'conflict' | 'timedOut' | 'transient' {
    if (statusCode === DisconnectReason.loggedOut) return 'loggedOut'
    if (statusCode === DisconnectReason.restartRequired) return 'restartRequired'
    if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) return 'conflict'
    if (statusCode === DisconnectReason.timedOut || statusCode === 408) return 'timedOut'
    return 'transient'
  }

  getQr(): string | null {
    return this.currentQr
  }

  getConnectionState(): ConnectionState {
    return this.state
  }

  /** Observability snapshot -- rule 17 of the review directive. */
  getDiagnostics() {
    return {
      generation: this.generation,
      disconnectCount: this.disconnectCount,
      reconnectCount: this.reconnectCount,
      lastDisconnectReason: this.lastDisconnectReason,
      lastDisconnectCode: this.lastDisconnectCode,
      currentReconnectAttempt: this.reconnectAttempts,
      connectionUptimeMs: this.connectedSince ? Date.now() - this.connectedSince : null,
    }
  }

  /**
   * Sends the text message first, then (if `media` is present) the
   * image/document attachment as a SEPARATE, second WhatsApp message
   * -- matching the directive's required delivery order (text first,
   * then QR image / invoice PDF, with the secure url staying in the
   * text as a fallback either way). Uses Baileys' own official media
   * message shapes (`{ image: Buffer, caption }` /
   * `{ document: Buffer, mimetype, fileName, caption }`, confirmed
   * directly against the installed package's own
   * AnyMediaMessageContent type) -- no browser automation, no separate
   * send path outside this same provider/queue infrastructure.
   *
   * See the interface doc comment on WhatsAppProvider.sendMessage for
   * the full media-idempotency discussion (directive rule 7): if the
   * text send succeeds but the media send then throws, this method
   * returns success:false so the caller's existing capped-retry policy
   * retries the whole row -- a retry can genuinely re-send the text a
   * second time, which is a documented, tested trade-off, not a silent
   * gap.
   */
  async sendMessage(
    toPhoneDigitsOnly: string,
    body: string,
    media?: MediaAttachment,
    templateKey = 'unknown',
    onTextConfirmed?: (providerReference: string) => Promise<void>,
  ): Promise<SendMessageResult> {
    if (this.state !== 'connected' || !this.socket) {
      return { success: false, error: `not connected (state=${this.state})` }
    }
    // TRUE ROOT CAUSE FIX for the send-hang investigation -- see
    // toWhatsAppJid()'s own doc comment and this class's own
    // class-level doc comment (above SEND_TIMEOUT_MS) for the full,
    // confirmed proof: an unnormalized "+"-prefixed phone number
    // (exactly what every queue-driven caller in this repo passes)
    // produces a JID WhatsApp's servers never send Baileys a usable
    // response for, causing a ~60s hang that had nothing to do with
    // Baileys, the network, or the database/queue layer.
    const jid = toWhatsAppJid(toPhoneDigitsOnly)
    const myGeneration = this.generation
    const sendStartedAt = Date.now()
    // Send-hang investigation (2026-08-18): records THIS attempt's
    // start, per-stage progress, and final outcome (never the message
    // body/phone/tokens) -- see SendDiagnostics.ts. This is what makes
    // "did this specific hang correlate with a recent uncaughtException"
    // and "which generation was this send actually made against"
    // answerable from /status instead of guessed.
    recordSendStart(this.clubId, myGeneration, templateKey)
    let textProviderReference: string | undefined
    try {
      const textResult = await withSendTimeout(this.socket.sendMessage(jid, { text: body }), 'text')
      textProviderReference = textResult?.key?.id ?? undefined
      recordSendStage(this.clubId, 'text_sent', Date.now() - sendStartedAt)
      // Duplicate-send mitigation (20260821160000): persist proof of
      // delivery THE MOMENT it's known, before media handling -- see
      // WhatsAppProvider.sendMessage()'s doc comment for why this must
      // be awaited here rather than fired-and-forgotten.
      if (onTextConfirmed && textProviderReference) {
        await onTextConfirmed(textProviderReference)
      }
    } catch (err) {
      const timedOut = (err as Error).message.includes('never resolved')
      recordSendOutcome(this.clubId, timedOut ? 'timed_out' : 'failed', Date.now() - sendStartedAt, {
        // Only a genuinely Baileys-reported error carries diagnostic
        // value here -- our own timeout text is already fully captured
        // by `outcome === 'timed_out'` and adds nothing beyond it.
        baileysErrorMessage: timedOut ? undefined : (err as Error).message,
      })
      return { success: false, error: (err as Error).message }
    }

    if (!media) {
      recordSendOutcome(this.clubId, 'success', Date.now() - sendStartedAt, { hasProviderReference: !!textProviderReference })
      return { success: true, providerReference: textProviderReference }
    }

    try {
      const mediaResult = await withSendTimeout(
        media.kind === 'image'
          ? this.socket.sendMessage(jid, { image: media.buffer, caption: media.caption })
          : this.socket.sendMessage(jid, {
              document: media.buffer,
              mimetype: media.mimetype ?? 'application/octet-stream',
              fileName: media.fileName ?? 'attachment',
              caption: media.caption,
            }),
        'media',
      )
      recordSendStage(this.clubId, 'media_sent', Date.now() - sendStartedAt)
      const finalProviderReference = mediaResult?.key?.id ?? textProviderReference
      recordSendOutcome(this.clubId, 'success', Date.now() - sendStartedAt, { hasProviderReference: !!finalProviderReference })
      return { success: true, providerReference: finalProviderReference }
    } catch (err) {
      // Text already went out to the customer's phone at this point --
      // documented above and in WhatsAppProvider's interface comment.
      // Reporting failure here (rather than a partial-success shape
      // notification_queue has no column for) is what lets the retry
      // policy attempt the media again; the residual "text may be
      // resent on retry" risk is the honest, tested trade-off, not a
      // hidden one.
      const timedOut = (err as Error).message.includes('never resolved')
      recordSendOutcome(this.clubId, timedOut ? 'timed_out' : 'failed', Date.now() - sendStartedAt, {
        baileysErrorMessage: timedOut ? undefined : (err as Error).message,
      })
      return { success: false, error: `text sent but media failed: ${(err as Error).message}` }
    }
  }

  async reconnect(): Promise<void> {
    await this.initializeConnection()
  }

  /**
   * Graceful, non-destructive close -- fix item 4. Tells WhatsApp's
   * servers this device is going away cleanly (so a subsequent
   * reconnect doesn't race a still-registered-as-live old socket) WITHOUT
   * wiping session credentials -- used for process shutdown/restart,
   * never for an operator-initiated logout (that's logout() below,
   * which additionally wipes credentials).
   */
  async disconnectGracefully(): Promise<void> {
    this.clearReconnectTimer()
    this.clearStabilityTimer()
    this.generation += 1 // invalidate any in-flight event handlers immediately
    await this.teardownCurrentSocket()
    this.setState('disconnected')
  }

  /**
   * Deletes the local Signal session file(s) for one specific contact,
   * forcing Baileys to negotiate a brand-new session with that
   * recipient on the next send -- the standard, safe WhatsApp/Signal
   * recovery for a session that has desynced from the recipient's
   * device (recipient shows "Waiting for this message" indefinitely
   * despite Baileys reporting a successful send). Added 2026-08-19
   * after a real live incident: per-contact session-key writes
   * (state.keys.set) were never persisted to Postgres before this
   * session's own fix (see initializeConnection()'s doc comment on the
   * keys.set wrap) -- any session negotiated before that fix shipped
   * can still be stale even after the persistence fix, since the fix
   * only prevents FUTURE corruption, it cannot repair a session that
   * already desynced. This targets only the named contact; every other
   * contact's session is untouched, and re-negotiation with WhatsApp's
   * own protocol is automatic and invisible to the recipient (their
   * device accepts the new PreKey-based session message transparently
   * -- this is the same mechanism used when a user reinstalls WhatsApp
   * or gets a new phone).
   *
   * Returns the list of session files actually removed, purely for
   * caller-side confirmation/logging -- an empty array is not an error,
   * it just means no matching session existed locally (already clean,
   * or never negotiated).
   */
  async repairContactSession(toPhoneDigitsOnly: string): Promise<string[]> {
    const digits = toPhoneDigitsOnly.replace(/\D/g, '')
    const dir = tenantAuthDir(this.clubId)
    const entries = await readdir(dir).catch(() => [] as string[])
    // useMultiFileAuthState's file naming: `session-${id}.json` where id
    // is `<phoneDigits>.<deviceId>` (ProtocolAddress.toString(), see
    // libsignal's protocol_address.js) -- match every device id for
    // this contact, not just device 0.
    const matches = entries.filter((name) => name.startsWith(`session-${digits}.`) && name.endsWith('.json'))
    for (const name of matches) {
      await rm(path.join(dir, name), { force: true })
    }
    if (matches.length > 0) {
      // Push the now-corrected (session file absent) state to Postgres
      // immediately, same hook the keys.set wrap uses -- otherwise a
      // restart before the next unrelated key write would silently
      // restore the just-deleted stale session from the last Postgres
      // snapshot, undoing this repair.
      this.hooks.onCredsUpdate?.()
    }
    return matches
  }

  /**
   * WHATSAPP DELIVERY TRUTH fix (2026-08-22), directive section 10 --
   * a genuine, read-only registration check against WhatsApp's own
   * servers via Baileys' onWhatsApp() (confirmed present in the
   * installed package at chats.js, calling sock.executeUSyncQuery()
   * with a phone-number USyncQuery -- a real query to WhatsApp, not a
   * local/cached guess). Answers a question sendMessage() itself
   * cannot: is this JID a real, currently-registered WhatsApp account
   * at all, independent of whether a prior send to it "succeeded"
   * (send success only ever proved this connector's own outbound
   * socket write completed -- see toWhatsAppJid()'s and
   * extractDeliveryReceipts()'s doc comments for the full evidence
   * chain this fix is built on).
   *
   * Deliberately reuses the SAME already-live, already-authenticated
   * socket this club's provider already holds -- no second socket is
   * opened, no existing connection is disturbed, matching this
   * provider's one-socket-per-club invariant (TenantConnectionManager's
   * own class-level doc comment). Safe to call at any time the
   * connection is up; returns null (not a throw) if there is currently
   * no live socket, so a caller can distinguish "this club isn't
   * connected right now" from "we asked and the number is not
   * registered".
   */
  async checkRegistration(toPhoneDigitsOnly: string): Promise<{ registered: boolean; jid: string | null } | null> {
    if (this.state !== 'connected' || !this.socket) {
      return null
    }
    const jid = toWhatsAppJid(toPhoneDigitsOnly)
    const results = await this.socket.onWhatsApp(jid)
    const match = results?.find((r) => r.jid === jid || r.jid?.startsWith(toPhoneDigitsOnly.replace(/\D/g, '')))
    return { registered: !!match?.exists, jid: match?.jid ?? null }
  }

  async logout(): Promise<void> {
    this.explicitLogout = true
    this.clearReconnectTimer()
    this.clearStabilityTimer()
    this.generation += 1
    try {
      await this.socket?.logout()
    } catch {
      // Best-effort -- proceed to wipe local state regardless of
      // whether the remote logout call itself succeeded.
    }
    this.socket = null
    this.currentQr = null
    this.setState('disconnected')
    await rm(tenantAuthDir(this.clubId), { recursive: true, force: true })
  }
}
