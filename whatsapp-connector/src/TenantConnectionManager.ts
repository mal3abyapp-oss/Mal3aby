import { BaileysProvider } from './BaileysProvider.js'
import { encryptAuthDirForClub, restoreAuthDirForClub } from './SessionStore.js'
import type { SupabaseSync } from './SupabaseSync.js'
import type { MediaAttachment, WhatsAppProvider } from './WhatsAppProvider.js'

/**
 * TenantConnectionManager -- holds one WhatsAppProvider per club and
 * syncs its state to Supabase via SupabaseSync.
 *
 * This is the tenant-isolation enforcement point at the service level:
 * every public method takes an explicit clubId and only ever touches
 * that club's own Map entry -- there is no code path that reads or
 * mutates a different tenant's provider instance. Combined with
 * BaileysProvider's hashed-clubId auth-dir isolation and Supabase's own
 * RLS (zero direct-table access on whatsapp_accounts, RPC-only), this
 * gives isolation at three independent layers.
 */
export class TenantConnectionManager {
  private readonly providers = new Map<string, WhatsAppProvider>()

  constructor(private readonly sync: SupabaseSync) {}

  /**
   * Async because a freshly-created provider must atomically claim its
   * DB-fencing generation (independent-audit fix, 2026-08-21) BEFORE it
   * is returned to any caller -- see BaileysProvider.claimDbGeneration()
   * and SupabaseSync.claimGeneration() for the full incident this
   * fixes. An existing (already-claimed) provider is returned
   * synchronously-fast, same as before; only the first-creation path
   * now awaits the claim RPC.
   */
  private async getOrCreateProvider(clubId: string): Promise<WhatsAppProvider> {
    let provider = this.providers.get(clubId)
    if (!provider) {
      provider = new BaileysProvider(clubId, {
        onStateChange: (state, detail, fencing) => {
          // Status-write-race fix (2026-08-18): pass this transition's
          // own (generation, stateSeq) through so the RPC can reject a
          // late-arriving stale write instead of always applying
          // whichever call happens to land last -- see
          // BaileysProviderHooks' own doc comment in BaileysProvider.ts
          // for the full proof and design. `generation` here is now
          // BaileysProvider's own atomically-claimed dbGeneration
          // (independent-audit fix, 2026-08-21), never the old
          // always-starts-at-0 in-process counter.
          void this.sync
            .reportStatus({
              clubId,
              status: state,
              qrPayload: detail?.qr ?? null,
              qrTtlSeconds: detail?.qrTtlSeconds ?? null,
              connectedPhoneNumber: detail?.connectedPhoneNumber ?? null,
              error: detail?.error ?? null,
              generation: fencing?.generation ?? 0,
              stateSeq: fencing?.stateSeq ?? 0,
            })
            .catch((err) => console.error(`[connector] failed to report status for club ${clubId.slice(0, 8)}:`, err.message))
        },
        onCredsUpdate: () => {
          void encryptAuthDirForClub(clubId)
            .then((encrypted) => this.sync.storeSession(clubId, encrypted))
            .catch((err) => console.error(`[connector] failed to persist session for club ${clubId.slice(0, 8)}:`, err.message))
        },
        // WHATSAPP DELIVERY TRUTH fix (2026-08-22) -- see
        // BaileysProviderHooks.onDeliveryReceipt's own doc comment for
        // the full incident. This is the only place a real, evidence-
        // backed delivered_at/read_at ever gets recorded.
        onDeliveryReceipt: (messageKeyId, statusLevel) => {
          void this.sync.reportDeliveryReceipt(messageKeyId, statusLevel)
        },
      })
      // Claim BEFORE registering in the map and BEFORE any caller can
      // call initializeConnection()/reconnect() on this instance --
      // guarantees no status transition can ever fire with
      // dbGeneration still null (BaileysProvider.setState() also
      // guards this defensively, but the real invariant is enforced
      // here, at construction).
      await provider.claimDbGeneration((id) => this.sync.claimGeneration(id))
      this.providers.set(clubId, provider)
    }
    return provider
  }

  async connect(clubId: string): Promise<void> {
    const provider = await this.getOrCreateProvider(clubId)
    await provider.initializeConnection()
  }

  getQr(clubId: string): string | null {
    return this.providers.get(clubId)?.getQr() ?? null
  }

  async disconnect(clubId: string): Promise<void> {
    const provider = this.providers.get(clubId)
    if (!provider) return
    await provider.logout()
    this.providers.delete(clubId)
  }

  /** See WhatsAppProvider.repairContactSession's own doc comment. Returns null (not an empty array) if this club has no active provider at all -- distinct from "provider exists but no stale session found". */
  async repairContactSession(clubId: string, toPhoneDigitsOnly: string): Promise<string[] | null> {
    const provider = this.providers.get(clubId)
    if (!provider) return null
    return provider.repairContactSession(toPhoneDigitsOnly)
  }

  async send(
    clubId: string,
    toPhoneDigitsOnly: string,
    body: string,
    media?: MediaAttachment,
    templateKey?: string,
    onTextConfirmed?: (providerReference: string) => Promise<void>,
  ) {
    const provider = this.providers.get(clubId)
    if (!provider) {
      return { success: false as const, error: 'no active connection for this club' }
    }
    return provider.sendMessage(toPhoneDigitsOnly, body, media, templateKey, onTextConfirmed)
  }

  getConnectionState(clubId: string) {
    return this.providers.get(clubId)?.getConnectionState() ?? 'disconnected'
  }

  /** WhatsApp Health & Root Cause Center -- whether a provider instance exists at all for this club, distinct from its connection state (a provider can exist but be disconnected/reconnecting). */
  hasProvider(clubId: string): boolean {
    return this.providers.has(clubId)
  }

  /** WhatsApp Health & Root Cause Center -- this club's own diagnostics snapshot, or null if no provider exists yet. */
  getProviderDiagnostics(clubId: string) {
    return this.providers.get(clubId)?.getDiagnostics() ?? null
  }

  /**
   * Attempts to restore every club that has a persisted (encrypted)
   * session in Postgres, without requiring a fresh QR scan -- called
   * once at process startup, and this is exactly what proves session
   * persistence survives an app/Node restart (test scenario #2 in the
   * directive's required local test suite): the encrypted blob is
   * pulled from Postgres and written back to this club's local auth
   * dir BEFORE Baileys attempts to reconnect, so persistence works even
   * if the local temp dir was wiped (fresh container/host), not only
   * within the same running process.
   *
   * A restore failure for one club (corrupted/tampered payload, wrong
   * key, transient network error) must not crash the whole service or
   * block other clubs from restoring -- logged and skipped, that club
   * simply stays disconnected until an operator initiates a fresh
   * pairing.
   */
  async restoreAllPersistedSessions(): Promise<void> {
    const accounts = await this.sync.listAccounts()
    for (const { clubId } of accounts) {
      try {
        const encrypted = await this.sync.loadSession(clubId)
        if (!encrypted) continue
        await restoreAuthDirForClub(clubId, encrypted)
        const provider = await this.getOrCreateProvider(clubId)
        await provider.reconnect()
      } catch (err) {
        console.error(`[connector] failed to restore session for club ${clubId.slice(0, 8)}:`, (err as Error).message)
      }
    }
  }

  /**
   * Self-healing watchdog (found during this review's real end-to-end
   * WhatsApp send test, not a pre-existing known gap): BaileysProvider
   * deliberately never auto-reconnects once its own bounded retry cap
   * is exhausted and it reaches the terminal 'failed' state (see the
   * comment at that call site) -- by design, so a genuinely dead
   * session doesn't hammer WhatsApp's servers forever. But nothing was
   * driving the *next* recovery step: ConnectionRequestPoller only acts
   * on rows the ADMIN flipped to 'connecting'/'disconnected'; a club
   * that was already connected and independently reached 'failed'
   * in-memory (e.g. a burst of stream:error/conflict during a session
   * restore racing an old lingering WhatsApp Web session) had no path
   * back to health short of a full process restart -- confirmed live:
   * the provider sat in 'failed' for 7+ minutes with zero recovery
   * attempts, and (worse) the DB row could still read a stale
   * 'connected' if the very status-report call that would have written
   * 'failed' itself failed during the same network hiccup, hiding the
   * outage from anything that only reads whatsapp_accounts.
   *
   * This is a bounded, one-shot recovery per detection (not a raw
   * auto-hammer loop) -- called periodically by the poller. A provider
   * that reaches 'failed' again after this attempt simply waits for the
   * next tick, same bounded cadence as the poller's own interval, not a
   * tight retry.
   */
  async recoverFailedConnections(): Promise<void> {
    for (const [clubId, provider] of this.providers) {
      if (provider.getConnectionState() !== 'failed') continue
      console.error(`[connector] self-healing: club ${clubId.slice(0, 8)} provider is 'failed', attempting reconnect`)
      try {
        await provider.reconnect()
      } catch (err) {
        console.error(`[connector] self-healing reconnect failed for club ${clubId.slice(0, 8)}:`, (err as Error).message)
      }
    }
  }

  /**
   * Graceful shutdown of every live provider -- P1 reliability fix
   * (2026-08-17): this is the missing piece that caused the
   * conflict/replaced reconnect-storm defect. Called from index.ts's
   * SIGINT/SIGTERM handler (and should be called before any other
   * process-exit path is added in the future) so WhatsApp's servers
   * are told each device is going away cleanly BEFORE the process
   * dies, instead of the old socket being abandoned mid-session and
   * fighting the next process's reconnect attempt for the same
   * account. Deliberately does NOT wipe credentials (disconnectGracefully,
   * not logout) -- this is a restart, not a deliberate session end.
   */
  async disconnectAllGracefully(): Promise<void> {
    const providers = [...this.providers.values()]
    await Promise.all(
      providers.map((provider) =>
        provider.disconnectGracefully().catch((err) => {
          console.error(`[connector] graceful disconnect failed for club ${provider.clubId.slice(0, 8)}:`, (err as Error).message)
        }),
      ),
    )
  }

  /** Observability snapshot across all live providers (review directive rule 17). */
  getAllDiagnostics(): Array<{ clubId: string; state: string } & ReturnType<WhatsAppProvider['getDiagnostics']>> {
    return [...this.providers.entries()].map(([clubId, provider]) => ({
      clubId: clubId.slice(0, 8),
      state: provider.getConnectionState(),
      ...provider.getDiagnostics(),
    }))
  }
}
