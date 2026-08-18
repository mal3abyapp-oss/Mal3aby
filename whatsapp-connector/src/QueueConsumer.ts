import type { SupabaseSync } from './SupabaseSync.js'
import type { TenantConnectionManager } from './TenantConnectionManager.js'
import { renderTemplate, bookingQrUrl } from './templates.js'
import { generateBookingQrPng } from './QrImage.js'
import { buildInvoicePdfBuffer } from './InvoicePdf.js'
import type { MediaAttachment } from './WhatsAppProvider.js'
import { classifyRootCause, type ClassificationInput } from './RootCauseClassifier.js'
import { getSendDiagnosticsSnapshot } from './SendDiagnostics.js'
import { getProcessDiagnosticsSnapshot } from './ProcessDiagnostics.js'

/**
 * QueueConsumer -- polls notification_queue (via
 * whatsapp_connector_claim_next_batch()) for whatsapp-channel rows and
 * attempts delivery through each row's club's WhatsAppProvider.
 *
 * This is the ONLY place this service reads from notification_queue,
 * and it never calls Baileys directly -- it renders a message via
 * templates.ts and hands off to TenantConnectionManager.send(), which
 * resolves to the WhatsAppProvider abstraction. Business logic
 * (booking/payment RPCs) never calls this or anything in this service
 * directly -- Business Event -> Notification Engine -> Queue -> here.
 *
 * A club with no connected WhatsApp session simply fails that one
 * claimed row (reported via reportSendResult, which applies the
 * capped-retry policy) -- it never blocks other clubs' rows in the
 * same batch, and a WhatsApp outage never affects booking/payment
 * data, which is already durably committed before a row ever reaches
 * this queue (task #93).
 */
export class QueueConsumer {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly sync: SupabaseSync,
    private readonly connections: TenantConnectionManager,
    private readonly pollIntervalMs: number,
    private readonly batchSize: number,
  ) {}

  start(): void {
    if (this.timer) return
    const tick = () => {
      void this.pollOnce()
        .catch((err) => console.error('[connector] queue poll failed:', (err as Error).message))
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
    // Part J: sweep stale (past-expires_at) rows to a terminal 'expired'
    // status BEFORE claiming, so a reminder that's gone stale (e.g. the
    // booking it referred to already started) is never attempted even
    // once, let alone sent late.
    await this.sync.expireStale()

    const batch = await this.sync.claimNextBatch(this.batchSize)
    // COMPOUNDING-DELAY FINDING, NOT YET FIXED (send-hang investigation,
    // 2026-08-18): sequential per-row processing means N rows that each
    // hit the SEND_TIMEOUT_MS ceiling in one batch take N * timeout to
    // fully process, not one timeout's worth -- confirmed live: 4 rows
    // for the same recipient, all claimed in the same batch
    // (last_attempt_at identical), and the 4th row's own send didn't
    // even START until ~135s after the batch was claimed (3 rows ahead
    // of it, each ~45s). This is a REAL, separate contributing factor to
    // how long a stuck backlog appears to hang -- distinct from the
    // per-send USync-timeout-race hypothesis (BaileysProvider.ts) --
    // but NOT changed here yet: making this concurrent instead of
    // sequential needs BaileysProvider.sendMessage() to be safe against
    // concurrent calls for the SAME club (it currently has no per-send
    // mutex, only the connection-level one in initializeConnection()),
    // which has not been verified. Documented, not guessed at with an
    // unverified fix. Its queue position IS captured for the Flight
    // Recorder/classification engine (see processRow()'s
    // queuePositionInBatch), so the UI can surface this factor even
    // while the underlying architecture stays sequential.
    for (let i = 0; i < batch.length; i++) {
      await this.processRow(batch[i], i)
      // Part G: process gradually rather than releasing a whole batch
      // simultaneously. This spacing is for service stability and to
      // avoid bursty behavior -- it is NOT an attempt to compute or
      // claim a "safe" WhatsApp send rate (there is no such guarantee).
      // The actual rate control is the per-account per-minute/per-hour
      // caps in messaging_safety_settings, enforced server-side in
      // whatsapp_connector_claim_next_batch -- this is just "don't fire
      // N messages in the same instant" pacing within an already
      // rate-limited batch.
      if (batch.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  private async processRow(row: Awaited<ReturnType<SupabaseSync['claimNextBatch']>>[number], queuePositionInBatch = 0): Promise<void> {
    const startedAt = new Date().toISOString()

    // WhatsApp Health & Root Cause Center: best-effort trace+incident
    // write, wrapped so a failure here NEVER affects the real send
    // path -- observability must not become a new reason for the
    // actual feature to break.
    const recordTraceAndIncident = async (input: ClassificationInput, outcome: 'success' | 'failed' | 'timed_out', errorSummary: string | null, hasProviderReference: boolean) => {
      try {
        const classification = outcome === 'success' ? null : classifyRootCause(input)
        const diagnostics = this.connections.getProviderDiagnostics(row.clubId)
        await this.sync.writeDeliveryTrace({
          clubId: row.clubId,
          notificationQueueId: row.id,
          attemptNumber: row.attempts,
          templateKey: row.templateKey,
          mediaType: row.mediaType,
          mediaIntent: row.mediaIntent,
          socketGeneration: diagnostics?.generation ?? null,
          containerInstanceId: process.env.HOSTNAME ?? null,
          stageTimeline: [],
          lastStageReached: null,
          startedAt,
          finishedAt: new Date().toISOString(),
          elapsedMs: null,
          outcome,
          rootCauseCode: classification?.code ?? null,
          rootCauseConfidence: classification?.confidence ?? null,
          errorSummary,
          hasProviderReference,
        })
        await this.sync.upsertIncident({
          clubId: row.clubId,
          outcome,
          rootCauseCode: classification?.code ?? null,
          rootCauseConfidence: classification?.confidence ?? null,
        })
      } catch (traceErr) {
        console.error(`[connector] observability write failed for queue row ${row.id.slice(0, 8)} (non-fatal, send result already reported separately):`, (traceErr as Error).message)
      }
    }

    if (!row.recipientPhone) {
      await this.sync.reportSendResult(row.id, false, undefined, 'no phone number on file for recipient')
      return
    }

    let body: string
    try {
      body = renderTemplate(row.templateKey, row.language, row.variables)
    } catch (err) {
      // A bad/unknown template_key is a permanent failure, not a
      // transient one -- still goes through the same capped-retry path
      // rather than a special-cased hard fail, keeping the failure
      // policy in exactly one place (whatsapp_connector_report_send_result).
      await this.sync.reportSendResult(row.id, false, undefined, (err as Error).message)
      return
    }

    let media: MediaAttachment | undefined
    if (row.mediaType && row.mediaIntent) {
      try {
        media = await this.buildMediaAttachment(row)
      } catch (err) {
        // MAL3ABY WHATSAPP QR IMAGE + INVOICE DOCUMENT DELIVERY,
        // directive rule 17: a media GENERATION failure (bad/expired
        // token, invoice not found, PDF library error) must never be
        // silently downgraded to "just send the text anyway" -- that
        // would violate rule 4 (never send a text that PROMISES a QR
        // image is attached when it silently isn't) since templates.ts's
        // own booking-created/confirmed/payment-received copy already
        // includes the secure url as the documented fallback, but the
        // caption line above it implies an attachment is coming. Report
        // failure through the same capped-retry path as a send failure
        // -- observability (id/media type/failure) without ever logging
        // the token, PDF bytes, or PNG bytes themselves.
        console.error(
          `[connector] media generation failed for queue row ${row.id.slice(0, 8)} (type=${row.mediaType}, intent=${row.mediaIntent}):`,
          (err as Error).message,
        )
        await this.sync.reportSendResult(row.id, false, undefined, `media generation failed: ${(err as Error).message}`)
        await recordTraceAndIncident(
          { hadActiveProvider: true, wasOurOwnTimeout: false, circuitBreakerOpen: false, mediaGenerationFailed: { kind: row.mediaIntent === 'booking_qr' ? 'qr' : row.mediaIntent === 'invoice_pdf' ? 'pdf' : 'unknown' } },
          'failed',
          `media generation failed: ${(err as Error).message}`,
          false,
        )
        return
      }
    }

    const result = await this.connections.send(row.clubId, row.recipientPhone, body, media, row.templateKey)
    // Observability (directive rule 18): id, media type/intent (never
    // the bytes or the token), success, provider reference, never any
    // customer-content beyond what's already logged elsewhere.
    if (media) {
      console.log(
        `[connector] queue row ${row.id.slice(0, 8)} media=${row.mediaType}/${row.mediaIntent} bytes=${media.buffer.length} success=${result.success}`,
      )
    }
    await this.sync.reportSendResult(row.id, result.success, result.providerReference, result.error)

    // WhatsApp Health & Root Cause Center: classify and record this
    // outcome AFTER the real send-result RPC above -- the actual
    // feature's own retry/backoff logic must never depend on or wait
    // for this.
    const sendSnapshot = getSendDiagnosticsSnapshot().find((s) => s.clubId === row.clubId)
    const processSnapshot = getProcessDiagnosticsSnapshot()
    const hadRecentException =
      !!processSnapshot.lastUncaughtExceptionAt &&
      new Date(processSnapshot.lastUncaughtExceptionAt).getTime() > Date.now() - 60_000
    const uploadFailedButTextSucceeded = !!media && !result.success && !!result.error?.includes('text sent but media failed')

    await recordTraceAndIncident(
      {
        hadActiveProvider: this.connections.hasProvider(row.clubId),
        connectionState: this.connections.getConnectionState(row.clubId) as ClassificationInput['connectionState'],
        lastStageReached: sendSnapshot?.stage,
        wasOurOwnTimeout: sendSnapshot?.outcome === 'timed_out',
        baileysErrorMessage: sendSnapshot?.baileysErrorMessage ?? undefined,
        elapsedMs: sendSnapshot?.elapsedMs ?? undefined,
        recentProcessException: hadRecentException,
        circuitBreakerOpen: false, // claimNextBatch() already excludes circuit-broken accounts from ever being claimed -- if we got this far, it was not open at claim time.
        mediaUploadFailed: uploadFailedButTextSucceeded,
        queuePositionInBatch,
      },
      result.success ? 'success' : sendSnapshot?.outcome === 'timed_out' ? 'timed_out' : 'failed',
      result.error ?? null,
      !!result.providerReference,
    )
  }

  /**
   * Generates the media attachment transiently, in memory, from
   * canonical data -- discarded by the caller immediately after send
   * (directive rule 5). Never persists the PNG/PDF bytes anywhere;
   * never logs the raw booking_qr_token/invoice token (rule 18).
   */
  private async buildMediaAttachment(row: Awaited<ReturnType<SupabaseSync['claimNextBatch']>>[number]): Promise<MediaAttachment> {
    if (row.mediaIntent === 'booking_qr') {
      const token = row.variables?.booking_qr_token
      const url = bookingQrUrl(token)
      if (!url) {
        // Directive rule 4: never send a QR image for an event without
        // an active credential -- a missing/empty token here means the
        // business RPC didn't mint one (e.g. this template_key should
        // never have been queued with media_intent set), which is a
        // real bug worth a loud failure, not a silently-skipped image.
        throw new Error('booking_qr media_intent but no booking_qr_token present in variables')
      }
      const png = await generateBookingQrPng(url)
      return {
        kind: 'image',
        buffer: png,
        caption: row.language === 'en' ? 'Your booking check-in code / keep it or show it on arrival' : 'رمز حضور حجزك في ملعبي / احتفظ به أو اعرضه عند الوصول',
      }
    }

    if (row.mediaIntent === 'invoice_pdf') {
      const invoiceId = row.variables?.invoice_id
      if (typeof invoiceId !== 'string' || !invoiceId) {
        throw new Error('invoice_pdf media_intent but no invoice_id present in variables')
      }
      const data = await this.sync.getInvoiceDocumentData(invoiceId)
      if (!data) {
        throw new Error(`invoice_pdf media_intent but whatsapp_connector_get_invoice_document_data returned no row for this invoice`)
      }
      const pdf = await buildInvoicePdfBuffer(data)
      // Never the raw token in the filename (directive rule 12) --
      // only the human-facing invoice number, which is already shown
      // to the customer in the message text and on the invoice itself.
      const safeInvoiceNumber = data.invoiceNumber.replace(/[^a-zA-Z0-9-]/g, '')
      return {
        kind: 'document',
        buffer: pdf,
        mimetype: 'application/pdf',
        fileName: `Mal3aby-Invoice-${safeInvoiceNumber}.pdf`,
        caption: row.language === 'en' ? 'Your invoice' : 'فاتورتك',
      }
    }

    throw new Error(`unrecognized media_intent: ${row.mediaIntent}`)
  }
}
