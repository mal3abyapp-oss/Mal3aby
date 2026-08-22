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
 * Supabase RPC calls, and everything in the main Mal3aby app (which
 * never imports anything from this directory at all) are untouched.
 */

/**
 * Part M (Safe Messaging directive): the full account health state
 * set. BaileysProvider itself only ever emits the states it can
 * genuinely detect from the socket (disconnected/connecting/
 * qr_required/connected/reconnecting/logged_out/error) -- 'degraded'
 * and 'restricted' are states the policy/observability layer or a
 * staff action can reach (e.g. a circuit-breaker trip is surfaced via
 * whatsapp_accounts.circuit_breaker_open_until, not this enum, and a
 * future manual "mark restricted" staff action would use this value),
 * and 'failed' covers the case in BaileysProvider where reconnection
 * attempts are exhausted. This type is widened here (not narrowed) so
 * the whole chain -- provider, sync layer, DB check constraint --
 * shares one vocabulary without forcing every layer to reimplement the
 * same union.
 */
export type ConnectionState =
  | 'disconnected'
  | 'qr_required'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'logged_out'
  | 'restricted'
  | 'failed'
  | 'error'

export interface SendMessageResult {
  success: boolean
  providerReference?: string
  error?: string
}

/**
 * Optional media attachment for a single sendMessage() call --
 * MAL3ABY WHATSAPP QR IMAGE + INVOICE DOCUMENT DELIVERY directive.
 *
 * `buffer` is always an in-memory Buffer generated transiently by the
 * caller (QrImage.ts / InvoicePdf.ts) immediately before this call and
 * discarded immediately after -- never a file path, never anything
 * persisted to disk or object storage (directive rule 5: "الأفضل
 * توليد في الذاكرة → إرسال Buffer → تجاهل").
 */
export interface MediaAttachment {
  kind: 'image' | 'document'
  buffer: Buffer
  /** Shown under the image in the chat (image) or as the caption alongside the document bubble (document). */
  caption?: string
  /** Required for 'document' -- WhatsApp needs a real MIME type to render/preview it correctly. Ignored for 'image' (always image/png here). */
  mimetype?: string
  /** Required for 'document' -- e.g. "Mal3aby-Invoice-INV-2026-0042.pdf". Never the raw secure token (directive rule 12). */
  fileName?: string
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

  /**
   * Atomically claims this process's DB-fencing generation for this
   * club (independent-audit fix, 2026-08-21) -- MUST be awaited and
   * complete before initializeConnection()/reconnect() is ever called.
   * `claim` is the caller-supplied RPC (SupabaseSync.claimGeneration),
   * kept as an injected function here (not a direct Supabase import) so
   * this file stays free of any Supabase-specific dependency, matching
   * this interface's own "connector-agnostic adapter boundary" design
   * documented at the top of this file. See BaileysProvider's own
   * dbGeneration field doc comment for the full incident this fixes:
   * without this claim, a provider's status-write generation always
   * started at 0/1/2... in-memory, which eventually became permanently
   * fenced out by the database's own memory of a much higher
   * generation accumulated across prior process restarts.
   */
  claimDbGeneration(claim: (clubId: string) => Promise<number>): Promise<void>

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

  /**
   * Sends a single message, optionally with one media attachment
   * (image or document). Never called directly by anything outside
   * the queue consumer.
   *
   * Media idempotency (directive rule 7): Baileys/the WhatsApp
   * Multi-Device protocol give no client-side exactly-once guarantee
   * this provider can rely on -- a single sendMessage() call maps to
   * exactly one socket.sendMessage() call for the text and, if
   * present, exactly one more for the media, sequentially (text
   * first, then media, matching the directive's required delivery
   * order). If the text send succeeds but the media send throws, this
   * method returns success:false with the text's own providerReference
   * unavailable to the caller -- QueueConsumer treats the WHOLE row as
   * failed and lets the existing capped-retry policy
   * (whatsapp_connector_report_send_result) retry it. This is a
   * deliberate, documented trade-off (not a claim of exactly-once
   * delivery, which this task's own directive explicitly says not to
   * claim if it isn't true): a retry after a text-succeeded/media-failed
   * outcome CAN re-send the text a second time. There is no WhatsApp/
   * Baileys API this provider can use to suppress that -- it is not
   * silently ignored, it is documented here and covered by the real
   * crash/retry test in the acceptance report.
   *
   * Duplicate-send mitigation (20260821160000): `onTextConfirmed`, when
   * given, is invoked synchronously-awaited the MOMENT the text send
   * resolves (before any media send is attempted), with Baileys' own
   * message key id. This provider stays Supabase-agnostic -- it does
   * not know what the callback does -- but awaiting it here (not
   * fire-and-forget from the provider's side) is what actually shrinks
   * the crash window: if the process dies during media handling or the
   * final report round-trip, the fact that this text was sent is
   * already durable. A slow or failing callback only delays this send
   * by the callback's own duration; it must not throw (the caller is
   * responsible for catching its own errors, matching every other
   * best-effort write in this service).
   */
  sendMessage(
    toPhoneDigitsOnly: string,
    body: string,
    media?: MediaAttachment,
    templateKey?: string,
    onTextConfirmed?: (providerReference: string) => Promise<void>,
  ): Promise<SendMessageResult>

  /** Attempts to restore a previously-persisted session without requiring a new QR scan. */
  reconnect(): Promise<void>

  /**
   * Graceful, non-destructive close -- tells WhatsApp's servers this
   * device is going away cleanly, WITHOUT wiping session credentials.
   * Used for process shutdown/restart so the next process's reconnect
   * doesn't race a still-registered-as-live old socket (the root cause
   * of the conflict/replaced reconnect-storm defect fixed 2026-08-17
   * -- see BaileysProvider's class-level doc comment for full detail).
   * Never used for an operator-initiated logout -- that's logout()
   * below.
   */
  disconnectGracefully(): Promise<void>

  /** Explicit disconnect + session credential wipe (both in-memory and on the encrypted store). */
  logout(): Promise<void>

  /**
   * Deletes the local Signal session for one specific contact only,
   * forcing a fresh renegotiation on the next send -- the standard
   * recovery for a per-contact session that desynced from the
   * recipient's device (recipient stuck on "Waiting for this message"
   * despite a reported-successful send). Every other contact's session
   * is untouched. Returns the session file names actually removed (an
   * empty array means nothing matched -- not an error).
   */
  repairContactSession(toPhoneDigitsOnly: string): Promise<string[]>

  /**
   * WHATSAPP DELIVERY TRUTH fix (2026-08-22), directive section 10 --
   * a real, read-only query against WhatsApp's own servers (Baileys
   * onWhatsApp(), reusing this provider's already-live socket) asking
   * whether a given phone number is a currently-registered WhatsApp
   * account at all. Returns null if this club has no live connection
   * right now (distinct from a genuine "not registered" answer).
   */
  checkRegistration(
    toPhoneDigitsOnly: string,
  ): Promise<{ registered: boolean; jid: string | null; lid: string | null; rawResults: unknown } | null>

  /**
   * ROOT-CAUSE INVESTIGATION (2026-08-22), directive section 6 -- see
   * BaileysProvider.getSenderIdentity's own doc comment.
   */
  getSenderIdentity(): { id: string | null; lid: string | null; name: string | null; platform: string | null } | null

  /** Observability snapshot for a future admin health panel (review directive rule 17). */
  getDiagnostics(): {
    generation: number
    disconnectCount: number
    reconnectCount: number
    lastDisconnectReason: string | null
    lastDisconnectCode: number | null
    currentReconnectAttempt: number
    connectionUptimeMs: number | null
  }
}
