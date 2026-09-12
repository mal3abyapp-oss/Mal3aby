import type { PlatformSupabaseSync } from './PlatformSupabaseSync.js'
import type { PlatformConnectionManager } from './PlatformConnectionManager.js'

/**
 * PlatformConnectionRequestPoller -- the Platform WhatsApp domain's
 * counterpart to ConnectionRequestPoller.ts, watching for the platform
 * account's own row (platform_whatsapp_account, a genuine singleton)
 * being flipped to 'connecting' (via platform_start_whatsapp_own_pairing()/
 * platform_retry_whatsapp_own_connection(), called from
 * /platform/whatsapp) or 'disconnected' (via
 * platform_disconnect_whatsapp_own()), and driving the actual
 * PlatformConnectionManager action -- same "no inbound HTTP API, this
 * service only ever calls OUT to Supabase and notices intent by
 * polling" design as the tenant domain's own poller.
 */
export class PlatformConnectionRequestPoller {
  private timer: NodeJS.Timeout | null = null
  private knownConnecting = false

  constructor(
    private readonly sync: PlatformSupabaseSync,
    private readonly connection: PlatformConnectionManager,
    private readonly pollIntervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return
    const tick = () => {
      void this.pollOnce()
        .catch((err) => console.error('[connector] platform connection-request poll failed:', (err as Error).message))
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
    // Self-healing pass first -- same rationale as
    // ConnectionRequestPoller.pollOnce()'s own recoverFailedConnections()
    // call: a provider that reached 'failed' in-memory has no other
    // trigger back to health, since the rest of this method only reacts
    // to a row an owner action flipped.
    await this.connection.recoverFailedConnection()

    const account = await this.sync.getSessionKey()
    if (!account) {
      this.knownConnecting = false
      return
    }

    if (account.status === 'connecting') {
      // Only kick off connect() once per pairing request, not on every
      // poll tick while it's in progress -- otherwise every 3s we'd
      // tear down and restart an in-progress handshake, same guard
      // shape as ConnectionRequestPoller's own knownConnecting Set.
      if (!this.knownConnecting && this.connection.getConnectionState() !== 'qr_required') {
        this.knownConnecting = true
        void this.connection.connect(account.sessionKey).catch((err) => console.error('[connector] connect() failed for platform WhatsApp:', (err as Error).message))
      }
    } else if (account.status === 'disconnected' && this.connection.getConnectionState() !== 'disconnected') {
      // platform_disconnect_whatsapp_own() flipped the row -- tear down
      // the real socket/session to match.
      this.knownConnecting = false
      void this.connection.disconnect().catch((err) => console.error('[connector] disconnect() failed for platform WhatsApp:', (err as Error).message))
    } else {
      this.knownConnecting = false
    }
  }
}
