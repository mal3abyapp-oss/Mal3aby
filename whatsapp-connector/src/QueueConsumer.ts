import type { SupabaseSync } from './SupabaseSync.js'
import type { TenantConnectionManager } from './TenantConnectionManager.js'
import { renderTemplate } from './templates.js'

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
    const batch = await this.sync.claimNextBatch(this.batchSize)
    for (const row of batch) {
      await this.processRow(row)
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

    const result = await this.connections.send(row.clubId, row.recipientPhone, body)
    await this.sync.reportSendResult(row.id, result.success, result.providerReference, result.error)
  }
}
