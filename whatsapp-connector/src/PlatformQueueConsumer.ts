import type { PlatformSupabaseSync } from './PlatformSupabaseSync.js'
import type { PlatformConnectionManager } from './PlatformConnectionManager.js'

/**
 * PlatformQueueConsumer -- the Platform WhatsApp domain's counterpart to
 * QueueConsumer.ts, polling platform_whatsapp_queue (via
 * whatsapp_connector_claim_next_platform_batch()) instead of
 * notification_queue.
 *
 * Deliberately much simpler than QueueConsumer.ts: platform_whatsapp_queue
 * rows carry their own final message_body text already (written by
 * sales_queue_platform_whatsapp_message() at queue time, from the
 * approved, owner-reviewed -- and possibly owner-edited -- outreach
 * draft), never a template_key to render and never a media attachment
 * to build. This mirrors the real difference between the two domains:
 * Sales Intelligence outreach is a single free-text message a human
 * already approved, not a templated transactional notification.
 */
export class PlatformQueueConsumer {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly sync: PlatformSupabaseSync,
    private readonly connection: PlatformConnectionManager,
    private readonly pollIntervalMs: number,
    private readonly batchSize: number,
  ) {}

  start(): void {
    if (this.timer) return
    const tick = () => {
      void this.pollOnce()
        .catch((err) => console.error('[connector] platform queue poll failed:', (err as Error).message))
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
    for (let i = 0; i < batch.length; i++) {
      await this.processRow(batch[i]!)
      // Same "don't fire N messages in the same instant" pacing as
      // QueueConsumer.ts's own batch loop -- the real rate control is
      // the per-minute/per-hour caps in
      // platform_whatsapp_safety_settings, already enforced
      // server-side in whatsapp_connector_claim_next_platform_batch().
      if (batch.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  private async processRow(row: { id: string; recipientPhone: string; messageBody: string; attempts: number }): Promise<void> {
    if (!row.recipientPhone) {
      await this.sync.reportSendResult(row.id, false, undefined, 'no phone number on file for recipient')
      return
    }
    const result = await this.connection.send(row.recipientPhone, row.messageBody)
    await this.sync.reportSendResult(row.id, result.success, result.providerReference, result.error)
  }
}
