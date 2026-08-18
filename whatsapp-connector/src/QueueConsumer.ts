import type { SupabaseSync } from './SupabaseSync.js'
import type { TenantConnectionManager } from './TenantConnectionManager.js'
import { renderTemplate, bookingQrUrl } from './templates.js'
import { generateBookingQrPng } from './QrImage.js'
import { buildInvoicePdfBuffer } from './InvoicePdf.js'
import type { MediaAttachment } from './WhatsAppProvider.js'

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
    for (const row of batch) {
      await this.processRow(row)
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

  private async processRow(row: Awaited<ReturnType<SupabaseSync['claimNextBatch']>>[number]): Promise<void> {
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
        return
      }
    }

    const result = await this.connections.send(row.clubId, row.recipientPhone, body, media)
    // Observability (directive rule 18): id, media type/intent (never
    // the bytes or the token), success, provider reference, never any
    // customer-content beyond what's already logged elsewhere.
    if (media) {
      console.log(
        `[connector] queue row ${row.id.slice(0, 8)} media=${row.mediaType}/${row.mediaIntent} bytes=${media.buffer.length} success=${result.success}`,
      )
    }
    await this.sync.reportSendResult(row.id, result.success, result.providerReference, result.error)
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
