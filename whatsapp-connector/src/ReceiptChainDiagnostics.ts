/**
 * ReceiptChainDiagnostics -- tiny in-memory ring buffer recording
 * EVERY raw messages.update event this socket receives at all (before
 * extractDeliveryReceipts()'s own fromMe/key.id/status filtering),
 * exposed read-only through HealthServer.ts's /status endpoint.
 * Mirrors the established diagnostics pattern in this codebase.
 *
 * ROOT-CAUSE INVESTIGATION (2026-08-22) -- pivoting from send-path
 * debugging to delivery/receipt-path debugging specifically, per
 * explicit direction: a fully-instrumented plain-text send showed a
 * completely clean send-path evidence chain (protocol routing, session
 * negotiation, device fanout, zero persistence failures) yet the
 * message still did not arrive on the recipient's phone. Direct source
 * inspection of @whiskeysockets/baileys@7.0.0-rc14's messages-recv.js
 * confirms the receipt-handling mechanism itself is genuinely correct
 * and unchanged from 6.7.24: `ws.on('CB:receipt', ...)` -> handleReceipt()
 * processes a real incoming <receipt> XML stanza from WhatsApp's own
 * servers, and (for status >= SERVER_ACK on our own sent message)
 * emits a genuine messages.update event this connector already
 * listens to (extractDeliveryReceipts(), wired since the original
 * WHATSAPP DELIVERY TRUTH fix). The complete, total absence of ANY
 * receipt across every send in this entire investigation -- even this
 * one, fully instrumented -- means either (a) the receipt genuinely
 * never arrives from WhatsApp's servers at all, or (b) something in
 * this connector's own event-listener wiring silently drops it before
 * extractDeliveryReceipts() ever sees it. This module distinguishes
 * those two possibilities directly: it records the RAW event (before
 * any filtering) that reaches the messages.update listener at all,
 * for ANY reason (including receipts for OTHER messages/other own
 * devices, which extractDeliveryReceipts() would filter out but which
 * still prove the listener itself is alive and receiving SOMETHING
 * from the server).
 *
 * SAFE METADATA ONLY: never a JID (not even hashed -- simply omitted;
 * the fromMe/status-level/key-presence tuple is sufficient forensic
 * signal on its own), never message content.
 */

const MAX_ENTRIES = 30

interface RawUpdateEntry {
  fromMe: boolean | null
  hasKeyId: boolean
  statusLevel: number | null
  hasOtherUpdateFields: boolean
  recordedAt: string
}

const recentRawUpdates: RawUpdateEntry[] = []
let totalMessagesUpdateEventsFired = 0

export function recordRawMessagesUpdateEvent(
  updates: Array<{ key: { fromMe?: boolean | null; id?: string | null }; update: Record<string, unknown> }>,
): void {
  totalMessagesUpdateEventsFired += 1
  for (const { key, update } of updates) {
    const statusValue = update.status
    recentRawUpdates.push({
      fromMe: typeof key.fromMe === 'boolean' ? key.fromMe : null,
      hasKeyId: typeof key.id === 'string' && key.id.length > 0,
      statusLevel: typeof statusValue === 'number' ? statusValue : null,
      hasOtherUpdateFields: Object.keys(update).some((k) => k !== 'status' && k !== 'messageTimestamp'),
      recordedAt: new Date().toISOString(),
    })
    if (recentRawUpdates.length > MAX_ENTRIES) recentRawUpdates.shift()
  }
}

export function getReceiptChainDiagnosticsSnapshot(): {
  totalMessagesUpdateEventsFired: number
  totalIndividualUpdatesRecorded: number
  recent: RawUpdateEntry[]
} {
  return {
    totalMessagesUpdateEventsFired,
    totalIndividualUpdatesRecorded: recentRawUpdates.length,
    recent: recentRawUpdates,
  }
}
