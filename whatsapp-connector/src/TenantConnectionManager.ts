import { BaileysProvider } from './BaileysProvider.js'
import { encryptAuthDirForClub, restoreAuthDirForClub } from './SessionStore.js'
import type { SupabaseSync } from './SupabaseSync.js'
import type { WhatsAppProvider } from './WhatsAppProvider.js'

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

  async send(clubId: string, toPhoneDigitsOnly: string, body: string) {
    const provider = this.providers.get(clubId)
    if (!provider) {
      return { success: false as const, error: 'no active connection for this club' }
    }
    return provider.sendMessage(toPhoneDigitsOnly, body)
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
}
