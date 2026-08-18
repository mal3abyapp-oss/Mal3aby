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

  private getOrCreateProvider(clubId: string): WhatsAppProvider {
    let provider = this.providers.get(clubId)
    if (!provider) {
      provider = new BaileysProvider(clubId, {
        onStateChange: (state, detail) => {
          void this.sync
            .reportStatus({
              clubId,
              status: state,
              qrPayload: detail?.qr ?? null,
              qrTtlSeconds: detail?.qrTtlSeconds ?? null,
              connectedPhoneNumber: detail?.connectedPhoneNumber ?? null,
              error: detail?.error ?? null,
            })
            .catch((err) => console.error(`[connector] failed to report status for club ${clubId.slice(0, 8)}:`, err.message))
        },
        onCredsUpdate: () => {
          void encryptAuthDirForClub(clubId)
            .then((encrypted) => this.sync.storeSession(clubId, encrypted))
            .catch((err) => console.error(`[connector] failed to persist session for club ${clubId.slice(0, 8)}:`, err.message))
        },
      })
      this.providers.set(clubId, provider)
    }
    return provider
  }

  async connect(clubId: string): Promise<void> {
    const provider = this.getOrCreateProvider(clubId)
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

  async send(clubId: string, toPhoneDigitsOnly: string, body: string, media?: MediaAttachment, templateKey?: string) {
    const provider = this.providers.get(clubId)
    if (!provider) {
      return { success: false as const, error: 'no active connection for this club' }
    }
    return provider.sendMessage(toPhoneDigitsOnly, body, media, templateKey)
  }

  getConnectionState(clubId: string) {
    return this.providers.get(clubId)?.getConnectionState() ?? 'disconnected'
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
        const provider = this.getOrCreateProvider(clubId)
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
