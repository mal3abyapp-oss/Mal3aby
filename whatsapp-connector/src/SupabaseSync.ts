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
    /** Status-write-race fix -- see BaileysProviderHooks' doc comment (BaileysProvider.ts). Both required (not optional) so no call site can silently skip fencing and reintroduce the race. */
    generation: number
    stateSeq: number
  }): Promise<void> {
    const { error } = await this.client.rpc('whatsapp_connector_report_status', {
      p_club_id: params.clubId,
      p_status: params.status,
      p_qr_payload: params.qrPayload ?? null,
      p_qr_ttl_seconds: params.qrTtlSeconds ?? null,
      p_connected_phone_number: params.connectedPhoneNumber ?? null,
      p_error: params.error ?? null,
      p_generation: params.generation,
      p_state_seq: params.stateSeq,
    })
    if (error) throw new Error(`whatsapp_connector_report_status failed: ${error.message}`)
  }

  /**
   * WHATSAPP DELIVERY TRUTH fix (2026-08-22): records a REAL received
   * delivery/read receipt -- the honest counterpart to
   * reportSendResult(), which only ever proved provider acceptance.
   * Best-effort, fire-and-forget by design (mirrors every other
   * observability write in this file): a failure here must never
   * disrupt the actual send/queue-processing path, and a dropped
   * receipt update degrades gracefully (that message's delivered_at/
   * read_at simply stays null, correctly read by the UI as
   * "unverified", never as a false negative).
   */
  async reportDeliveryReceipt(providerReference: string, statusLevel: number): Promise<void> {
    try {
      const { error } = await this.client.rpc('whatsapp_connector_report_delivery_receipt', {
        p_provider_reference: providerReference,
        p_status_level: statusLevel,
      })
      if (error) console.error(`[connector] reportDeliveryReceipt failed for ref ${providerReference.slice(0, 12)}: (non-fatal):`, error.message)
    } catch (err) {
      console.error(`[connector] reportDeliveryReceipt threw for ref ${providerReference.slice(0, 12)} (non-fatal):`, (err as Error).message)
    }
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

  /**
   * Atomically claims this process's DB-fencing generation for a club
   * (independent-audit fix, 2026-08-21) -- see
   * whatsapp_connector_claim_generation()'s own SQL-side doc comment
   * and BaileysProvider.claimDbGeneration()'s doc comment for the full
   * incident this fixes. Must be called exactly once per club per
   * process lifetime, BEFORE that club's provider ever reports a
   * status transition -- never fire-and-forget like reportStatus(),
   * this one is awaited and its failure must propagate (an unclaimed
   * generation must never silently fall back to reporting with a wrong
   * or fabricated value).
   */
  async claimGeneration(clubId: string): Promise<number> {
    const { data, error } = await this.client.rpc('whatsapp_connector_claim_generation', { p_club_id: clubId })
    if (error) throw new Error(`whatsapp_connector_claim_generation failed: ${error.message}`)
    return data as number
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
      mediaType: 'image' | 'document' | null
      mediaIntent: 'booking_qr' | 'invoice_pdf' | null
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
        media_type: 'image' | 'document' | null
        media_intent: 'booking_qr' | 'invoice_pdf' | null
      }) => ({
        id: row.id,
        clubId: row.club_id,
        recipientCustomerId: row.recipient_customer_id,
        recipientPhone: row.recipient_phone,
        templateKey: row.template_key,
        language: row.language,
        variables: row.variables,
        attempts: row.attempts,
        mediaType: row.media_type ?? null,
        mediaIntent: row.media_intent ?? null,
      }),
    )
  }

  /**
   * Canonical invoice data for PDF generation -- directive rule 9:
   * NEVER recompute finance independently, always the same
   * get_invoice_payment_summary()-backed source Reports/Billing/
   * verify_invoice_public() use. Service-role-only RPC (not granted to
   * anon/authenticated), matching this class's existing pattern of
   * narrow, purpose-built RPC calls only.
   */
  async getInvoiceDocumentData(invoiceId: string): Promise<{
    invoiceId: string
    invoiceNumber: string
    clubName: string | null
    customerName: string | null
    bookingRef: string | null
    fieldName: string | null
    bookingStartAt: string | null
    bookingEndAt: string | null
    clubTimezone: string | null
    issuedAt: string
    total: number
    paid: number
    refunded: number
    outstanding: number
    paymentStatus: string
    currency: string
    paymentMethod: string | null
    receiptSerial: string | null
    receiptBook: string | null
    receiptSeries: string | null
    receiptDate: string | null
  } | null> {
    const { data, error } = await this.client.rpc('whatsapp_connector_get_invoice_document_data', { p_invoice_id: invoiceId })
    if (error) throw new Error(`whatsapp_connector_get_invoice_document_data failed: ${error.message}`)
    const row = (data ?? [])[0] as
      | {
          invoice_id: string
          invoice_number: string
          club_name: string | null
          customer_name: string | null
          booking_ref: string | null
          field_name: string | null
          booking_start_at: string | null
          booking_end_at: string | null
          club_timezone: string | null
          issued_at: string
          total: number
          paid: number
          refunded: number
          outstanding: number
          payment_status: string
          currency: string
          payment_method: string | null
          receipt_serial: string | null
          receipt_book: string | null
          receipt_series: string | null
          receipt_date: string | null
        }
      | undefined
    if (!row) return null
    return {
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
      clubName: row.club_name,
      customerName: row.customer_name,
      bookingRef: row.booking_ref,
      fieldName: row.field_name,
      bookingStartAt: row.booking_start_at,
      bookingEndAt: row.booking_end_at,
      clubTimezone: row.club_timezone,
      issuedAt: row.issued_at,
      total: row.total,
      paid: row.paid,
      refunded: row.refunded,
      outstanding: row.outstanding,
      paymentStatus: row.payment_status,
      currency: row.currency,
      paymentMethod: row.payment_method,
      receiptSerial: row.receipt_serial,
      receiptBook: row.receipt_book,
      receiptSeries: row.receipt_series,
      receiptDate: row.receipt_date,
    }
  }

  /** Part J: sweeps whatsapp-channel pending/retrying rows past their expires_at to a terminal 'expired' status, before they're ever claimed/attempted. Returns how many rows were expired (for logging only -- never logs message content). */
  async expireStale(): Promise<number> {
    const { data, error } = await this.client.rpc('whatsapp_connector_expire_stale')
    if (error) throw new Error(`whatsapp_connector_expire_stale failed: ${error.message}`)
    return (data as number) ?? 0
  }

  /**
   * Duplicate-send mitigation (20260821160000): records provider_reference
   * the MOMENT Baileys confirms the text send, before media handling or
   * the full reportSendResult() round-trip -- so a crash landing after
   * this point but before reportSendResult() lets
   * whatsapp_connector_expire_stale() tell a genuinely stuck row apart
   * from an already-delivered one and refuse to resend it. Best-effort
   * and fire-and-forget by design (mirrors the observability writes
   * below): if this call itself fails or is slow, it must never delay
   * or block the real send path, and the row simply falls back to the
   * pre-existing (wider) recovery window -- not worse than before this
   * fix existed, only not as narrow as intended for that one call.
   */
  async markProviderReferenceInFlight(queueId: string, providerReference: string): Promise<void> {
    try {
      const { error } = await this.client.rpc('whatsapp_connector_mark_provider_reference', {
        p_queue_id: queueId,
        p_provider_reference: providerReference,
      })
      if (error) console.error(`[connector] markProviderReferenceInFlight failed for queue row ${queueId.slice(0, 8)} (non-fatal):`, error.message)
    } catch (err) {
      console.error(`[connector] markProviderReferenceInFlight threw for queue row ${queueId.slice(0, 8)} (non-fatal):`, (err as Error).message)
    }
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

  /**
   * WhatsApp Health & Root Cause Center -- writes one delivery trace
   * row. Best-effort: a failure here must NEVER block or fail the
   * actual send/report_send_result path (observability must not become
   * a new reason for the real feature to break, per the explicit
   * "observability yourself must not cause new outages" requirement) --
   * callers should catch and log, never let this throw propagate into
   * QueueConsumer.processRow()'s own control flow.
   */
  async writeDeliveryTrace(trace: {
    clubId: string
    notificationQueueId: string | null
    attemptNumber: number
    templateKey: string
    mediaType: string | null
    mediaIntent: string | null
    socketGeneration: number | null
    containerInstanceId: string | null
    stageTimeline: Array<{ stage: string; at: string }>
    lastStageReached: string | null
    startedAt: string
    finishedAt: string | null
    elapsedMs: number | null
    outcome: 'success' | 'failed' | 'timed_out' | 'unknown'
    rootCauseCode: string | null
    rootCauseConfidence: 'high' | 'medium' | 'low' | 'unproven' | null
    errorSummary: string | null
    hasProviderReference: boolean
  }): Promise<string | null> {
    const { data, error } = await this.client.rpc('whatsapp_connector_write_delivery_trace', {
      p_club_id: trace.clubId,
      p_notification_queue_id: trace.notificationQueueId,
      p_attempt_number: trace.attemptNumber,
      p_template_key: trace.templateKey,
      p_media_type: trace.mediaType,
      p_media_intent: trace.mediaIntent,
      p_socket_generation: trace.socketGeneration,
      p_container_instance_id: trace.containerInstanceId,
      p_stage_timeline: trace.stageTimeline,
      p_last_stage_reached: trace.lastStageReached,
      p_started_at: trace.startedAt,
      p_finished_at: trace.finishedAt,
      p_elapsed_ms: trace.elapsedMs,
      p_outcome: trace.outcome,
      p_root_cause_code: trace.rootCauseCode,
      p_root_cause_confidence: trace.rootCauseConfidence,
      p_error_summary: trace.errorSummary,
      p_has_provider_reference: trace.hasProviderReference,
    })
    if (error) throw new Error(`whatsapp_connector_write_delivery_trace failed: ${error.message}`)
    return (data as string) ?? null
  }

  /** WhatsApp Health & Root Cause Center -- opens/escalates/resolves an incident based on real trace evidence. Same best-effort contract as writeDeliveryTrace(). */
  async upsertIncident(params: {
    clubId: string
    outcome: 'success' | 'failed' | 'timed_out' | 'unknown'
    rootCauseCode: string | null
    rootCauseConfidence: 'high' | 'medium' | 'low' | 'unproven' | null
    automaticRecoveryPerformed?: boolean
    automaticRecoveryDetail?: string
  }): Promise<string | null> {
    const { data, error } = await this.client.rpc('whatsapp_connector_upsert_incident', {
      p_club_id: params.clubId,
      p_outcome: params.outcome,
      p_root_cause_code: params.rootCauseCode,
      p_root_cause_confidence: params.rootCauseConfidence,
      p_automatic_recovery_performed: params.automaticRecoveryPerformed ?? false,
      p_automatic_recovery_detail: params.automaticRecoveryDetail ?? null,
    })
    if (error) throw new Error(`whatsapp_connector_upsert_incident failed: ${error.message}`)
    return (data as string) ?? null
  }
}
