import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * SupabaseSync -- the only file (besides main.ts's client construction)
 * that talks to Supabase. Wraps the connector-facing RPCs from
 * 20260817110000_whatsapp_connection_model_v2.sql and
 * 20260818010000_whatsapp_connector_queue_rpcs.sql. Authenticates with
 * the SERVICE ROLE key (server-side only, never shipped to any
 * client) -- these RPCs are deliberately not granted to
 * authenticated/anon, so only this key can call them.
 *
 * Every call is a narrow, purpose-built RPC -- this class never does a
 * raw `.from('whatsapp_accounts')` table read/write, matching the
 * "exactly one write surface, encryption always happens in the same
 * place" principle documented on those RPCs.
 */
export class SupabaseSync {
  private readonly client: SupabaseClient

  constructor() {
    const url = process.env.SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !serviceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server-side only, never shipped to any client).')
    }
    this.client = createClient(url, serviceKey, { auth: { persistSession: false } })
  }

  async reportStatus(params: {
    clubId: string
    status: 'disconnected' | 'qr_required' | 'connecting' | 'connected' | 'reconnecting' | 'degraded' | 'logged_out' | 'restricted' | 'failed' | 'error'
    qrPayload?: string | null
    qrTtlSeconds?: number | null
    connectedPhoneNumber?: string | null
    error?: string | null
  }): Promise<void> {
    const { error } = await this.client.rpc('whatsapp_connector_report_status', {
      p_club_id: params.clubId,
      p_status: params.status,
      p_qr_payload: params.qrPayload ?? null,
      p_qr_ttl_seconds: params.qrTtlSeconds ?? null,
      p_connected_phone_number: params.connectedPhoneNumber ?? null,
      p_error: params.error ?? null,
    })
    if (error) throw new Error(`whatsapp_connector_report_status failed: ${error.message}`)
  }

  async storeSession(clubId: string, encrypted: Buffer): Promise<void> {
    const { error } = await this.client.rpc('whatsapp_connector_store_session', {
      p_club_id: clubId,
      // supabase-js encodes a bytea param from a hex-prefixed string.
      p_session_credentials_encrypted: `\\x${encrypted.toString('hex')}`,
    })
    if (error) throw new Error(`whatsapp_connector_store_session failed: ${error.message}`)
  }

  async loadSession(clubId: string): Promise<Buffer | null> {
    const { data, error } = await this.client.rpc('whatsapp_connector_load_session', { p_club_id: clubId })
    if (error) throw new Error(`whatsapp_connector_load_session failed: ${error.message}`)
    if (!data) return null
    // supabase-js returns bytea as a "\\x"-prefixed hex string.
    const hex = typeof data === 'string' && data.startsWith('\\x') ? data.slice(2) : (data as string)
    return Buffer.from(hex, 'hex')
  }

  async listAccounts(): Promise<Array<{ clubId: string; status: string }>> {
    const { data, error } = await this.client.rpc('whatsapp_connector_list_accounts')
    if (error) throw new Error(`whatsapp_connector_list_accounts failed: ${error.message}`)
    return (data ?? []).map((row: { club_id: string; status: string }) => ({ clubId: row.club_id, status: row.status }))
  }

  async claimNextBatch(limit: number): Promise<
    Array<{
      id: string
      clubId: string
      recipientCustomerId: string | null
      recipientPhone: string | null
      templateKey: string
      language: string
      variables: Record<string, unknown>
      attempts: number
    }>
  > {
    const { data, error } = await this.client.rpc('whatsapp_connector_claim_next_batch', { p_limit: limit })
    if (error) throw new Error(`whatsapp_connector_claim_next_batch failed: ${error.message}`)
    return (data ?? []).map(
      (row: {
        id: string
        club_id: string
        recipient_customer_id: string | null
        recipient_phone: string | null
        template_key: string
        language: string
        variables: Record<string, unknown>
        attempts: number
      }) => ({
        id: row.id,
        clubId: row.club_id,
        recipientCustomerId: row.recipient_customer_id,
        recipientPhone: row.recipient_phone,
        templateKey: row.template_key,
        language: row.language,
        variables: row.variables,
        attempts: row.attempts,
      }),
    )
  }

  /** Part J: sweeps whatsapp-channel pending/retrying rows past their expires_at to a terminal 'expired' status, before they're ever claimed/attempted. Returns how many rows were expired (for logging only -- never logs message content). */
  async expireStale(): Promise<number> {
    const { data, error } = await this.client.rpc('whatsapp_connector_expire_stale')
    if (error) throw new Error(`whatsapp_connector_expire_stale failed: ${error.message}`)
    return (data as number) ?? 0
  }

  async reportSendResult(queueId: string, success: boolean, providerReference?: string, error?: string): Promise<void> {
    const { error: rpcError } = await this.client.rpc('whatsapp_connector_report_send_result', {
      p_queue_id: queueId,
      p_success: success,
      p_provider_reference: providerReference ?? null,
      p_error: error ?? null,
    })
    if (rpcError) throw new Error(`whatsapp_connector_report_send_result failed: ${rpcError.message}`)
  }
}
