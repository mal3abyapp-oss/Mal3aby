import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { BaileysMessagingProvider } from './BaileysMessagingProvider.js'
import type { ConnectionState, MessagingProvider } from './MessagingProvider.js'

/**
 * TenantConnectionManager — holds one MessagingProvider per club and
 * syncs its state back into Supabase's whatsapp_connections table.
 *
 * This is the tenant-isolation enforcement point at the service level:
 * every public method takes an explicit clubId and only ever touches
 * that club's own Map entry — there is no code path that reads or
 * mutates a different tenant's provider instance. Combined with
 * SessionStore's hashed-filename isolation and the Supabase RLS on the
 * table side (Gate 8 migration: zero direct-table access, RPC-only),
 * this gives isolation at three independent layers.
 *
 * This service authenticates to Supabase with the SERVICE ROLE key
 * (never the anon key) specifically so it can write connection state
 * for any tenant it's actively managing a session for — but it never
 * accepts a clubId from an unauthenticated caller (see server.ts's
 * signed-request requirement).
 */
export class TenantConnectionManager {
  private readonly providers = new Map<string, MessagingProvider>()
  private readonly supabase: SupabaseClient

  constructor() {
    const url = process.env.SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !serviceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server-side only, never shipped to any client).')
    }
    this.supabase = createClient(url, serviceKey, { auth: { persistSession: false } })
  }

  private getOrCreateProvider(clubId: string): MessagingProvider {
    let provider = this.providers.get(clubId)
    if (!provider) {
      provider = new BaileysMessagingProvider(clubId, {
        onStateChange: (state, detail) => void this.syncState(clubId, state, detail),
        onConnected: (phoneNumber) => void this.recordConnected(clubId, phoneNumber),
      })
      this.providers.set(clubId, provider)
    }
    return provider
  }

  private async syncState(clubId: string, state: ConnectionState, detail?: Record<string, unknown>) {
    const update: Record<string, unknown> = { status: state, updated_at: new Date().toISOString() }
    if (state === 'failed' || state === 'expired' || state === 'logged_out') {
      update.last_error = typeof detail?.error === 'string' ? detail.error : null
    }
    // Uses the service-role key deliberately -- this write must
    // succeed regardless of which staff member (if any) is currently
    // logged into the admin UI, since connection state changes
    // (reconnect, disconnect-from-phone, expiry) can happen with no
    // one actively watching the screen.
    await this.supabase.from('whatsapp_connections').update(update).eq('club_id', clubId)
  }

  private async recordConnected(clubId: string, phoneNumber: string) {
    await this.supabase
      .from('whatsapp_connections')
      .update({ status: 'connected', connected_phone_number: phoneNumber, connected_at: new Date().toISOString(), pairing_token: null, pairing_expires_at: null })
      .eq('club_id', clubId)
    await this.supabase.from('whatsapp_connection_events').insert({ club_id: clubId, event: 'connected', detail: {} })
  }

  async connect(clubId: string): Promise<void> {
    const provider = this.getOrCreateProvider(clubId)
    await provider.initializeConnection()
  }

  async getQr(clubId: string): Promise<string | null> {
    const provider = this.providers.get(clubId)
    if (!provider) return null
    return provider.generateQr()
  }

  async disconnect(clubId: string): Promise<void> {
    const provider = this.providers.get(clubId)
    if (!provider) return
    await provider.logout()
    this.providers.delete(clubId)
    await this.supabase.from('whatsapp_connection_events').insert({ club_id: clubId, event: 'disconnected_by_connector', detail: {} })
  }

  async send(clubId: string, toPhoneE164: string, body: string) {
    const provider = this.providers.get(clubId)
    if (!provider) {
      return { success: false as const, error: 'no active connection for this club' }
    }
    return provider.sendMessage(toPhoneE164, body)
  }

  async healthCheck(clubId: string) {
    const provider = this.providers.get(clubId)
    if (!provider) {
      return { serviceOnline: true, sessionConnected: false, connectedPhoneNumber: null, lastSuccessfulSendAt: null, lastReconnectAt: null, queueConsumerAlive: true, sessionError: 'no active connection' }
    }
    return provider.healthCheck()
  }

  /** Attempts to restore any club that has a persisted (encrypted) session on disk, without requiring a fresh QR scan -- called once at process startup. */
  async restoreAllPersistedSessions(clubIds: string[]): Promise<void> {
    for (const clubId of clubIds) {
      const provider = this.getOrCreateProvider(clubId)
      try {
        await provider.reconnect()
      } catch {
        // A club with no valid persisted session simply stays
        // disconnected until an operator initiates a fresh pairing --
        // not a startup failure.
      }
    }
  }
}
