/**
 * MessagingProvider — the connector-agnostic adapter boundary.
 *
 * Per the WhatsApp QR Connector directive: the rest of the platform
 * (Supabase Notification Core, the queue worker, the admin UI) must
 * never know about Baileys-specific types or behavior. Everything
 * outside this file talks to a MessagingProvider; only
 * BaileysMessagingProvider.ts is allowed to import @whiskeysockets/baileys.
 *
 * If Baileys ever needs to be replaced (e.g. with WPPConnect, per the
 * directive's fallback strategy), only a new class implementing this
 * same interface is needed — notification_events, whatsapp_templates,
 * whatsapp_automations, notification_queue, the booking/academy
 * integration, and reporting are never touched.
 */

export type ConnectionState =
  | 'disconnected'
  | 'generating_qr'
  | 'waiting_for_scan'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  | 'expired'
  | 'logged_out'
  | 'failed'

export interface HealthCheckResult {
  serviceOnline: boolean
  sessionConnected: boolean
  connectedPhoneNumber: string | null
  lastSuccessfulSendAt: string | null
  lastReconnectAt: string | null
  queueConsumerAlive: boolean
  sessionError: string | null
}

export interface SendMessageResult {
  success: boolean
  providerReference?: string
  error?: string
}

/**
 * One MessagingProvider instance is scoped to exactly one tenant
 * (club). The connector service holds a Map<clubId, MessagingProvider>
 * — sessions are never shared or cross-referenced between tenants (see
 * SessionStore.ts for the on-disk isolation guarantee this depends on).
 */
export interface MessagingProvider {
  readonly clubId: string

  /** Begins a connection attempt. Transitions disconnected -> generating_qr. */
  initializeConnection(): Promise<void>

  /**
   * Returns the current pairing QR payload if the connection is in
   * waiting_for_scan, or null otherwise. The QR is never persisted as
   * a rendered image and never logged — only the current in-memory
   * value is exposed, and it changes/expires as the underlying
   * provider issues new codes.
   */
  generateQr(): Promise<string | null>

  getConnectionState(): ConnectionState

  /** Sends a single message. Never called directly by business logic — only by the queue consumer. */
  sendMessage(toPhoneE164: string, body: string): Promise<SendMessageResult>

  /** Attempts to restore a previously-persisted session without requiring a new QR scan. */
  reconnect(): Promise<void>

  /** Explicit disconnect + session credential wipe (both in-memory and on the encrypted store). */
  logout(): Promise<void>

  healthCheck(): Promise<HealthCheckResult>
}
