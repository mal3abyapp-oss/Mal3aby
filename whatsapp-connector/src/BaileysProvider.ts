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
import { createHash } from 'node:crypto'
import type { ConnectionState, SendMessageResult, WhatsAppProvider } from './WhatsAppProvider.js'

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
 * process. This is the same library already proven working in this
 * exact codebase in the prior (since-removed) implementation -- see
 * AUTONOMOUS_DECISION_LOG.md D-013/D-016 for the comparison against
 * Evolution API and whatsapp-web.js that was done before choosing it
 * again.
 *
 * Auth-state persistence: Baileys' own useMultiFileAuthState writes
 * plaintext credential files to disk by default. That violates "auth
 * state is a secret, never stored unprotected" -- this provider points
 * useMultiFileAuthState at a per-tenant, hashed-name temp directory
 * that exists only for the process's lifetime (0700 permissions), and
 * on every credential update immediately encrypts the directory's
 * logical state via SessionStore and pushes it to Postgres through
 * whatsapp_connector_store_session() -- the temp directory is a
 * working cache, not the system of record.
 */

const TEMP_AUTH_ROOT = process.env.WHATSAPP_TEMP_AUTH_DIR ?? path.resolve(process.cwd(), '.baileys-auth-tmp')

function tenantAuthDir(clubId: string): string {
  const hash = createHash('sha256').update(clubId).digest('hex')
  return path.join(TEMP_AUTH_ROOT, hash)
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

  async initializeConnection(): Promise<void> {
    this.explicitLogout = false
    this.setState('connecting')

    const authDir = tenantAuthDir(this.clubId)
    await mkdir(authDir, { recursive: true, mode: 0o700 })

    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    this.socket = makeWASocket({
      auth: state,
      version,
      // Never printQRInTerminal / log the QR to any log stream -- the
      // QR is captured via connection.update below and exposed only
      // through getQr(), which the caller pushes to Postgres for the
      // admin UI to render client-side (same pattern as the app's
      // existing booking/membership QR flow).
      logger: this.logger as never,
    })

    this.socket.ev.on('creds.update', async () => {
      await saveCreds()
      this.hooks.onCredsUpdate?.()
    })

    this.socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.currentQr = qr
        this.setState('qr_required', { qr, qrTtlSeconds: 60 })
      }

      if (connection === 'open') {
        this.currentQr = null
        this.reconnectAttempts = 0
        const phone = this.socket?.user?.id?.split(':')[0] ?? undefined
        this.setState('connected', { connectedPhoneNumber: phone })
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        const loggedOut = statusCode === DisconnectReason.loggedOut || this.explicitLogout

        if (loggedOut) {
          // Explicit logout (either the operator disconnected from the
          // admin UI, or the device was removed from the phone) must
          // NOT auto-reconnect -- that would silently re-request a
          // session the user deliberately ended. Transition back to
          // qr_required-eligible 'logged_out' and stop.
          this.setState('logged_out', { error: 'Session was logged out.' })
          return
        }

        // Bounded automatic reconnect for transient loss (network
        // blip, WhatsApp-side restart signal) -- capped, not an
        // infinite retry loop. TenantConnectionManager's own
        // supervising interval will pick this club back up on its next
        // scheduled restore pass if this cap is hit while still
        // disconnected.
        const message = lastDisconnect?.error?.message ?? 'Connection closed unexpectedly.'
        this.reconnectAttempts += 1
        if (this.reconnectAttempts > 5) {
          // Part M: 'failed' -- reconnect attempts genuinely exhausted,
          // a terminal state distinct from a still-in-progress
          // 'reconnecting'. Per Part M/N, this does NOT loop back into
          // initializeConnection() automatically -- a controlled
          // reconnect/re-pairing action (start_whatsapp_pairing() from
          // the admin UI, which ConnectionRequestPoller picks up) is
          // required, matching "no auto-hammer" for logged_out/failed.
          this.setState('failed', { error: `${message} (giving up after ${this.reconnectAttempts} reconnect attempts)` })
          return
        }
        this.setState('reconnecting', { error: message })
        void this.initializeConnection()
      }
    })
  }

  getQr(): string | null {
    return this.currentQr
  }

  getConnectionState(): ConnectionState {
    return this.state
  }

  async sendMessage(toPhoneDigitsOnly: string, body: string): Promise<SendMessageResult> {
    if (this.state !== 'connected' || !this.socket) {
      return { success: false, error: `not connected (state=${this.state})` }
    }
    try {
      const jid = `${toPhoneDigitsOnly}@s.whatsapp.net`
      const result = await this.socket.sendMessage(jid, { text: body })
      return { success: true, providerReference: result?.key?.id ?? undefined }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  async reconnect(): Promise<void> {
    await this.initializeConnection()
  }

  async logout(): Promise<void> {
    this.explicitLogout = true
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
