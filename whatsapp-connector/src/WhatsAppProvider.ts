/**
 * WhatsAppProvider -- the connector-agnostic adapter boundary.
 *
 * Per the re-integration directive: the rest of this service (the
 * Supabase sync layer, the queue consumer) must never know about
 * Baileys-specific types or behavior. Everything outside this file
 * talks to a WhatsAppProvider; only BaileysProvider.ts is allowed to
 * import @whiskeysockets/baileys.
 *
 * If Baileys is ever replaced, only a new class implementing this same
 * interface is needed -- SessionStore, TenantConnectionManager, the
 * Supabase RPC calls, and everything in the main Mala3by app (which
 * never imports anything from this directory at all) are untouched.
 */

export type ConnectionState =
  | 'disconnected'
  | 'qr_required'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'logged_out'
  | 'error'

export interface SendMessageResult {
  success: boolean
  providerReference?: string
  error?: string
}

/**
 * One WhatsAppProvider instance is scoped to exactly one tenant (club).
 * The connector service holds a Map<clubId, WhatsAppProvider> --
 * sessions are never shared or cross-referenced between tenants (see
 * SessionStore.ts for the on-disk isolation guarantee this depends on,
 * and TenantConnectionManager.ts for the in-memory isolation
 * guarantee).
 */
export interface WhatsAppProvider {
  readonly clubId: string

  /** Begins a connection attempt. Transitions disconnected -> connecting -> qr_required. */
  initializeConnection(): Promise<void>

  /**
   * Returns the current pairing QR payload if the connection is in
   * qr_required, or null otherwise. Never persisted as a rendered
   * image and never logged -- only the current in-memory value is
   * exposed, and it changes/expires as Baileys issues new codes.
   */
  getQr(): string | null

  getConnectionState(): ConnectionState

  /** Sends a single message. Never called directly by anything outside the queue consumer. */
  sendMessage(toPhoneDigitsOnly: string, body: string): Promise<SendMessageResult>

  /** Attempts to restore a previously-persisted session without requiring a new QR scan. */
  reconnect(): Promise<void>

  /** Explicit disconnect + session credential wipe (both in-memory and on the encrypted store). */
  logout(): Promise<void>
}
