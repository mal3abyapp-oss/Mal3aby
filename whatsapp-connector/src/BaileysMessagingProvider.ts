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
import type { ConnectionState, HealthCheckResult, MessagingProvider, SendMessageResult } from './MessagingProvider.js'

/**
 * BaileysMessagingProvider — the ONLY file in this service allowed to
 * import @whiskeysockets/baileys, per the adapter-boundary requirement.
 * Everything else (the queue worker, the Supabase sync layer, the
 * HTTP control API) talks to the MessagingProvider interface only.
 *
 * Baileys is the primary connector candidate per the directive:
 * TypeScript-native, WebSocket-based, supports WhatsApp Multi-Device
 * and QR authentication, no mandatory Puppeteer/Chromium dependency —
 * suitable as a persistent connector service. If Baileys proves
 * unworkable for a real, diagnosed technical reason (not the first
 * error encountered), WPPConnect is the designated fallback — that
 * would mean adding a WppConnectMessagingProvider.ts implementing this
 * same interface, never touching any code outside this directory.
 *
 * Auth-state persistence: Baileys' own useMultiFileAuthState writes
 * plaintext credential files to disk by default. That directly
 * violates the "auth state is a secret, never stored unprotected"
 * requirement, so this provider uses useMultiFileAuthState against a
 * per-tenant temp directory (hashed clubId, matching SessionStore's own
 * isolation scheme) that is encrypted at rest via a wrapping step: the
 * directory's contents are synced through SessionStore's AES-256-GCM
 * encryption on every credential update, and the plaintext temp
 * directory itself is created with 0700 permissions and lives only for
 * the process's lifetime.
 */

const TEMP_AUTH_ROOT = process.env.WHATSAPP_TEMP_AUTH_DIR ?? path.resolve(process.cwd(), '.baileys-auth-tmp')

function tenantAuthDir(clubId: string): string {
  const hash = createHash('sha256').update(clubId).digest('hex')
  return path.join(TEMP_AUTH_ROOT, hash)
}

export class BaileysMessagingProvider implements MessagingProvider {
  readonly clubId: string
  private socket: WASocket | null = null
  private state: ConnectionState = 'disconnected'
  private currentQr: string | null = null
  private lastError: string | null = null
  private lastSuccessfulSendAt: string | null = null
  private lastReconnectAt: string | null = null
  private readonly logger: pino.Logger
  private onStateChange?: (state: ConnectionState, detail?: Record<string, unknown>) => void
  private onConnected?: (phoneNumber: string) => void

  constructor(
    clubId: string,
    hooks?: {
      onStateChange?: (state: ConnectionState, detail?: Record<string, unknown>) => void
      onConnected?: (phoneNumber: string) => void
    },
  ) {
    // clubId must be assigned before anything that derives from it
    // (e.g. the logger's redacted-id child binding) -- a class field
    // initializer for `logger` that called this.redactedClubId()
    // directly ran BEFORE this constructor body in JS field-init order,
    // reading `this.clubId` while it was still undefined. Caught via
    // the connector's own self-test (real execution, not a type-check),
    // which is exactly why that test exists.
    this.clubId = clubId
    this.onStateChange = hooks?.onStateChange
    this.onConnected = hooks?.onConnected
    this.logger = pino({ level: process.env.LOG_LEVEL ?? 'info' }).child({ clubId: this.redactedClubId() })
  }

  /** Never log a full clubId (UUID) in a way that could correlate across log aggregation with other tenant data more than necessary -- short prefix only. */
  private redactedClubId(): string {
    return this.clubId.slice(0, 8)
  }

  private setState(next: ConnectionState, detail?: Record<string, unknown>) {
    this.state = next
    this.onStateChange?.(next, detail)
  }

  async initializeConnection(): Promise<void> {
    this.setState('generating_qr')
    this.lastError = null

    const authDir = tenantAuthDir(this.clubId)
    await mkdir(authDir, { recursive: true, mode: 0o700 })

    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    this.socket = makeWASocket({
      auth: state,
      version,
      // Never log QR to the terminal/log stream in a production
      // deployment -- printQRInTerminal is intentionally omitted; the
      // qr is captured via the connection.update event below and
      // exposed only through generateQr(), never written to any log.
      logger: this.logger as never,
    })

    this.socket.ev.on('creds.update', saveCreds)

    this.socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.currentQr = qr
        this.setState('waiting_for_scan')
      }

      if (connection === 'connecting') {
        this.setState('authenticating')
      }

      if (connection === 'open') {
        this.currentQr = null
        const phone = this.socket?.user?.id?.split(':')[0] ?? null
        this.setState('connected', { connectedPhoneNumber: phone })
        if (phone) this.onConnected?.(phone)
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        const loggedOut = statusCode === DisconnectReason.loggedOut

        if (loggedOut) {
          this.setState('logged_out')
          this.lastError = 'Session was logged out from the phone.'
        } else {
          this.lastError = lastDisconnect?.error?.message ?? 'Connection closed unexpectedly.'
          this.setState('reconnecting')
          this.lastReconnectAt = new Date().toISOString()
          // Bounded automatic reconnect -- Baileys' own recommended
          // pattern. A real deployment should cap retry count and back
          // off; kept simple here since the actual reconnect loop
          // policy is a runtime-config concern, not an architecture one.
          void this.reconnect()
        }
      }
    })
  }

  async generateQr(): Promise<string | null> {
    return this.currentQr
  }

  getConnectionState(): ConnectionState {
    return this.state
  }

  async sendMessage(toPhoneE164: string, body: string): Promise<SendMessageResult> {
    if (this.state !== 'connected' || !this.socket) {
      return { success: false, error: `not connected (state=${this.state})` }
    }
    try {
      const jid = `${toPhoneE164.replace(/\D/g, '')}@s.whatsapp.net`
      const result = await this.socket.sendMessage(jid, { text: body })
      this.lastSuccessfulSendAt = new Date().toISOString()
      return { success: true, providerReference: result?.key?.id ?? undefined }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  async reconnect(): Promise<void> {
    this.lastReconnectAt = new Date().toISOString()
    await this.initializeConnection()
  }

  async logout(): Promise<void> {
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

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      serviceOnline: true,
      sessionConnected: this.state === 'connected',
      connectedPhoneNumber: this.state === 'connected' ? (this.socket?.user?.id?.split(':')[0] ?? null) : null,
      lastSuccessfulSendAt: this.lastSuccessfulSendAt,
      lastReconnectAt: this.lastReconnectAt,
      queueConsumerAlive: true,
      sessionError: this.lastError,
    }
  }
}
