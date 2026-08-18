import makeWASocket, {
  DisconnectReason,
  type WASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
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

function tenantAuthDir(clubId: string): string {
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

export interface BaileysProviderHooks {
  onStateChange?: (state: ConnectionState, detail?: { qr?: string; qrTtlSeconds?: number; connectedPhoneNumber?: string; error?: string }) => void
  /** Called whenever Baileys persists updated credentials to the local auth dir -- the caller is responsible for encrypting the dir's contents and pushing to Supabase (see SessionStore.encryptAuthDirForClub). */
  onCredsUpdate?: () => void
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

  /** Generation counter -- see class-level doc comment, fix item 1. */
  private generation = 0
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
    this.hooks.onStateChange?.(next, detail)
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
  async sendMessage(toPhoneDigitsOnly: string, body: string, media?: MediaAttachment, templateKey = 'unknown'): Promise<SendMessageResult> {
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
