import type { SupabaseSync } from './SupabaseSync.js'
import type { TenantConnectionManager } from './TenantConnectionManager.js'

/**
 * ConnectionRequestPoller -- watches for clubs whose whatsapp_accounts
 * row was flipped to 'connecting' (via start_whatsapp_pairing(), called
 * from the admin UI) or 'disconnected' with an active in-memory
 * provider still running (via disconnect_whatsapp()), and drives the
 * actual TenantConnectionManager action.
 *
 * This exists because this service deliberately has NO inbound HTTP
 * API (see README -- the prior implementation's signed HTTP control
 * API was dropped as unnecessary attack surface once the app never
 * needs to reach the connector directly, only through Supabase state).
 * Polling whatsapp_connector_list_accounts() is the connector's only
 * way to learn "the admin UI asked for a new pairing" -- a few seconds
 * of latency to notice a click is an acceptable trade for zero inbound
 * network exposure on this service.
 */
export class ConnectionRequestPoller {
  private timer: NodeJS.Timeout | null = null
  private readonly knownConnecting = new Set<string>()

  constructor(
    private readonly sync: SupabaseSync,
    private readonly connections: TenantConnectionManager,
    private readonly pollIntervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return
    const tick = () => {
      void this.pollOnce()
        .catch((err) => console.error('[connector] connection-request poll failed:', (err as Error).message))
        .finally(() => {
          this.timer = setTimeout(tick, this.pollIntervalMs)
        })
    }
    tick()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async pollOnce(): Promise<void> {
    // Self-healing pass first (see TenantConnectionManager.
    // recoverFailedConnections doc comment) -- a provider that reached
    // 'failed' in-memory has no other trigger back to health, since the
    // rest of this method only reacts to rows an admin action flipped.
    await this.connections.recoverFailedConnections()

    const accounts = await this.sync.listAccounts()
    const stillConnecting = new Set<string>()

    for (const { clubId, status } of accounts) {
      if (status === 'connecting') {
        stillConnecting.add(clubId)
        // Only kick off initializeConnection() once per pairing
        // request, not on every poll tick while it's in progress --
        // otherwise every 5s we'd tear down and restart an in-progress
        // handshake.
        if (!this.knownConnecting.has(clubId) && this.connections.getConnectionState(clubId) !== 'qr_required') {
          this.knownConnecting.add(clubId)
          void this.connections.connect(clubId).catch((err) => console.error(`[connector] connect() failed for club ${clubId.slice(0, 8)}:`, (err as Error).message))
        }
      } else if (status === 'disconnected' && this.connections.getConnectionState(clubId) !== 'disconnected') {
        // disconnect_whatsapp() flipped the row -- tear down the real
        // socket/session to match.
        void this.connections.disconnect(clubId).catch((err) => console.error(`[connector] disconnect() failed for club ${clubId.slice(0, 8)}:`, (err as Error).message))
      }
    }

    this.knownConnecting.clear()
    for (const clubId of stillConnecting) this.knownConnecting.add(clubId)
  }
}
