import { BaileysProvider } from './BaileysProvider.js'
import { encryptAuthDirForClub, restoreAuthDirForClub } from './SessionStore.js'
import type { PlatformSupabaseSync } from './PlatformSupabaseSync.js'
import type { SendMessageResult, WhatsAppProvider } from './WhatsAppProvider.js'

/**
 * PlatformConnectionManager -- the Platform WhatsApp domain's
 * counterpart to TenantConnectionManager.ts, holding exactly ONE
 * WhatsAppProvider (there is exactly one Platform WhatsApp account,
 * platform_whatsapp_account being a genuine singleton table with its
 * own CHECK constraint enforcing that -- see
 * 20260909200000_platform_whatsapp_domain.sql).
 *
 * Reuses BaileysProvider UNCHANGED -- confirmed by reading it in full
 * before writing this file that it treats its constructor's `clubId`
 * argument purely as an opaque identity/hashing key (SHA-256'd for the
 * local auth-dir path, sliced for redacted logging), never a validated
 * foreign key against public.clubs. Passed the platform's own sentinel
 * session_key (a real UUID from platform_whatsapp_account, resolved via
 * PlatformSupabaseSync.getSessionKey() -- never a hardcoded string, so
 * this correctly reflects whatever value the database actually holds),
 * it hashes to its own auth-dir path, structurally distinct from every
 * club's own hashed directory -- the same "opaque-key machinery"
 * whatsapp_connector_get_platform_session_key()'s own SQL doc comment
 * anticipated this connector would use.
 *
 * Deliberately a SEPARATE class from TenantConnectionManager, not a
 * generalization of it to "N named accounts including one called
 * platform" -- matches this whole feature's own two-domain-separation
 * design (owner decision #21): the connector's own code structure keeps
 * "Platform WhatsApp" and "Tenant/Club WhatsApp" as two distinct things
 * you can reason about independently, exactly like the database schema,
 * the RPC permission split, and the frontend pages already do.
 */
export class PlatformConnectionManager {
  private provider: WhatsAppProvider | null = null
  private sessionKey: string | null = null

  constructor(private readonly sync: PlatformSupabaseSync) {}

  private async getOrCreateProvider(sessionKey: string): Promise<WhatsAppProvider> {
    if (this.provider && this.sessionKey === sessionKey) return this.provider
    const provider = new BaileysProvider(sessionKey, {
      onStateChange: (state, detail, fencing) => {
        // Same status-write-race fencing discipline as
        // TenantConnectionManager's own onStateChange hook -- see that
        // file's doc comment for the full incident/proof this
        // (generation, stateSeq) pair fixes.
        void this.sync
          .reportStatus({
            status: state,
            qrPayload: detail?.qr ?? null,
            qrTtlSeconds: detail?.qrTtlSeconds ?? null,
            connectedPhoneNumber: detail?.connectedPhoneNumber ?? null,
            error: detail?.error ?? null,
            generation: fencing?.generation ?? 0,
            stateSeq: fencing?.stateSeq ?? 0,
          })
          .catch((err) => console.error('[connector] failed to report platform status:', err.message))
      },
      onCredsUpdate: () => {
        void encryptAuthDirForClub(sessionKey)
          .then((encrypted) => this.sync.storeSession(encrypted))
          .catch((err) => console.error('[connector] failed to persist platform session:', err.message))
      },
      // Ban-protection hardening (2026-09-12) -- see
      // BaileysProviderHooks.onRestrictionSignal's own doc comment. No
      // onOptOutKeyword wiring here: the Platform WhatsApp domain sends
      // to Sales Intelligence LEADS, not customers with a
      // notification_consent row -- there is nothing for a lead's
      // "stop" message to revoke in this domain's data model. A lead
      // that replies "stop" is still visible in the Sales pipeline's
      // own reply/activity timeline; a human decides whether to mark
      // that lead do_not_contact, matching how every other
      // lead-status transition in Sales Intelligence already works
      // (never automated).
      onRestrictionSignal: (detail) => {
        void this.sync
          .reportRestrictionSignal(detail)
          .catch((err) => console.error('[connector] failed to report platform restriction signal:', err.message))
      },
      // Platform WhatsApp sends genuine Sales Intelligence outreach
      // text only (sales_queue_platform_whatsapp_message) -- no media,
      // no delivery-receipt diagnostics wiring needed yet (that
      // machinery exists for the tenant/club domain's own production-
      // hardening history; adding it here is out of scope for making
      // pairing/sending work at all, and can be layered on later
      // without touching this file's core shape).
    })
    await provider.claimDbGeneration(async () => {
      // Platform WhatsApp has no per-club generation-claim RPC (there is
      // exactly one account, so there is exactly one fencing sequence to
      // claim) -- reuse whatsapp_connector_report_platform_status()'s
      // own stale-write rejection (p_generation/p_state_seq compared
      // against last_generation/last_state_seq) as the fencing
      // mechanism instead of a dedicated claim RPC. Starting at
      // generation 0 here is safe: unlike the tenant domain's
      // now-fixed history (BaileysProvider's doc comment on
      // dbGeneration explains that incident in full), the Platform
      // WhatsApp domain is brand new as of this feature -- there is no
      // accumulated prior-restart generation count in the database to
      // collide with yet, so 0 is a genuine, correct starting point,
      // not a repeat of the same bug being fixed elsewhere.
      return 0
    })
    this.provider = provider
    this.sessionKey = sessionKey
    return provider
  }

  async connect(sessionKey: string): Promise<void> {
    const provider = await this.getOrCreateProvider(sessionKey)
    await provider.initializeConnection()
  }

  getQr(): string | null {
    return this.provider?.getQr() ?? null
  }

  async disconnect(): Promise<void> {
    if (!this.provider) return
    await this.provider.logout()
    this.provider = null
    this.sessionKey = null
  }

  send(toPhoneDigitsOnly: string, body: string): Promise<SendMessageResult> {
    if (!this.provider) {
      return Promise.resolve({ success: false, error: 'no active platform connection' })
    }
    return this.provider.sendMessage(toPhoneDigitsOnly, body)
  }

  getConnectionState() {
    return this.provider?.getConnectionState() ?? 'disconnected'
  }

  hasProvider(): boolean {
    return this.provider !== null
  }

  getProviderDiagnostics() {
    return this.provider?.getDiagnostics() ?? null
  }

  /**
   * Restores the platform account's persisted session on process
   * startup -- mirrors TenantConnectionManager.restoreAllPersistedSessions()
   * but for the single platform account. A restore failure must not
   * crash the whole service; the platform account simply stays
   * disconnected until an operator initiates a fresh pairing from
   * /platform/whatsapp, exactly matching the tenant domain's own
   * failure-handling discipline.
   */
  async restorePersistedSession(): Promise<void> {
    try {
      const account = await this.sync.getSessionKey()
      if (!account) return
      const encrypted = await this.sync.loadSession()
      if (!encrypted) return
      await restoreAuthDirForClub(account.sessionKey, encrypted)
      const provider = await this.getOrCreateProvider(account.sessionKey)
      await provider.reconnect()
    } catch (err) {
      console.error('[connector] failed to restore platform session:', (err as Error).message)
    }
  }

  /**
   * Self-healing watchdog -- mirrors
   * TenantConnectionManager.recoverFailedConnections()'s own bounded,
   * one-shot-per-detection recovery for the single platform provider.
   */
  async recoverFailedConnection(): Promise<void> {
    if (!this.provider || this.provider.getConnectionState() !== 'failed') return
    console.error('[connector] self-healing: platform WhatsApp provider is \'failed\', attempting reconnect')
    try {
      await this.provider.reconnect()
    } catch (err) {
      console.error('[connector] self-healing reconnect failed for platform WhatsApp:', (err as Error).message)
    }
  }

  /** Graceful shutdown -- mirrors TenantConnectionManager.disconnectAllGracefully() for the single platform provider. */
  async disconnectGracefully(): Promise<void> {
    if (!this.provider) return
    await this.provider.disconnectGracefully().catch((err) => {
      console.error('[connector] graceful disconnect failed for platform WhatsApp:', (err as Error).message)
    })
  }
}
