import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * PlatformSupabaseSync -- the Platform WhatsApp domain's counterpart to
 * SupabaseSync.ts, wrapping the whatsapp_connector_*_platform_* RPCs
 * from 20260909200000_platform_whatsapp_domain.sql. A SEPARATE class
 * (not a widening of SupabaseSync) matching that migration's own
 * explicit design intent -- see whatsapp_connector_get_platform_session_key()'s
 * doc comment: "a real UUID, but never a public.clubs.id... the platform
 * sentinel key flows through the exact same opaque-key machinery as any
 * club_id, but the connector never needs to know it isn't one." Keeping
 * this a distinct class (rather than adding platform methods onto
 * SupabaseSync) makes the two-domain separation (Platform WhatsApp vs.
 * Tenant/Club WhatsApp, owner decision #21) visible at the connector's
 * own code-structure level, not just in the database's permission model.
 *
 * Same authentication (SERVICE ROLE key) and same "narrow, purpose-built
 * RPC only, never a raw table read/write" discipline as SupabaseSync.
 * These RPCs are already revoked from public/anon/authenticated in SQL
 * (20260909200000_platform_whatsapp_domain.sql), so only this key can
 * call them -- confirmed by reading that migration directly before
 * writing this file.
 */
export class PlatformSupabaseSync {
  private readonly client: SupabaseClient

  constructor() {
    const url = process.env.SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !serviceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server-side only, never shipped to any client).')
    }
    this.client = createClient(url, serviceKey, { auth: { persistSession: false } })
  }

  /**
   * Returns the platform account's own sentinel session_key (a real
   * UUID, never a club_id) and its current status, or null if this
   * connector process has nothing to do for the platform account right
   * now (no persisted session AND not currently 'connecting' -- mirrors
   * whatsapp_connector_list_accounts()'s own "which accounts need my
   * attention right now" filter, just narrowed to the one singleton
   * platform row instead of a set of clubs).
   */
  async getSessionKey(): Promise<{ sessionKey: string; status: string } | null> {
    const { data, error } = await this.client.rpc('whatsapp_connector_get_platform_session_key')
    if (error) throw new Error(`whatsapp_connector_get_platform_session_key failed: ${error.message}`)
    const row = (data ?? [])[0] as { session_key: string; status: string } | undefined
    if (!row) return null
    return { sessionKey: row.session_key, status: row.status }
  }

  async reportStatus(params: {
    status: 'disconnected' | 'qr_required' | 'connecting' | 'connected' | 'reconnecting' | 'degraded' | 'logged_out' | 'restricted' | 'failed' | 'error'
    qrPayload?: string | null
    qrTtlSeconds?: number | null
    connectedPhoneNumber?: string | null
    error?: string | null
    generation: number
    stateSeq: number
  }): Promise<void> {
    const { error } = await this.client.rpc('whatsapp_connector_report_platform_status', {
      p_status: params.status,
      p_qr_payload: params.qrPayload ?? null,
      p_qr_ttl_seconds: params.qrTtlSeconds ?? null,
      p_connected_phone_number: params.connectedPhoneNumber ?? null,
      p_error: params.error ?? null,
      p_generation: params.generation,
      p_state_seq: params.stateSeq,
    })
    if (error) throw new Error(`whatsapp_connector_report_platform_status failed: ${error.message}`)
  }

  async storeSession(encrypted: Buffer): Promise<void> {
    const { error } = await this.client.rpc('whatsapp_connector_store_platform_session', {
      // supabase-js encodes a bytea param from a hex-prefixed string,
      // matching SupabaseSync.storeSession()'s own established pattern.
      p_session_credentials_encrypted: `\\x${encrypted.toString('hex')}`,
    })
    if (error) throw new Error(`whatsapp_connector_store_platform_session failed: ${error.message}`)
  }

  async loadSession(): Promise<Buffer | null> {
    const { data, error } = await this.client.rpc('whatsapp_connector_load_platform_session')
    if (error) throw new Error(`whatsapp_connector_load_platform_session failed: ${error.message}`)
    if (!data) return null
    const hex = typeof data === 'string' && data.startsWith('\\x') ? data.slice(2) : (data as string)
    return Buffer.from(hex, 'hex')
  }

  async claimNextBatch(limit: number): Promise<Array<{ id: string; recipientPhone: string; messageBody: string; attempts: number }>> {
    const { data, error } = await this.client.rpc('whatsapp_connector_claim_next_platform_batch', { p_limit: limit })
    if (error) throw new Error(`whatsapp_connector_claim_next_platform_batch failed: ${error.message}`)
    return (data ?? []).map((row: { id: string; recipient_phone: string; message_body: string; attempts: number }) => ({
      id: row.id,
      recipientPhone: row.recipient_phone,
      messageBody: row.message_body,
      attempts: row.attempts,
    }))
  }

  async reportSendResult(id: string, success: boolean, providerReference?: string, error?: string): Promise<void> {
    const { error: rpcError } = await this.client.rpc('whatsapp_connector_report_platform_send_result', {
      p_id: id,
      p_success: success,
      p_provider_reference: providerReference ?? null,
      p_error: error ?? null,
    })
    if (rpcError) throw new Error(`whatsapp_connector_report_platform_send_result failed: ${rpcError.message}`)
  }
}
