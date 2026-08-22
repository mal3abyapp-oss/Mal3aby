/**
 * IncomingMessageDiagnostics -- tiny in-memory ring buffer of recent
 * incoming-message metadata, exposed read-only through HealthServer.ts's
 * /status endpoint. Mirrors ProcessDiagnostics.ts's own pattern exactly
 * (same rationale: this process's own console.log() is confirmed NOT
 * visible via `wrangler tail` for a Cloudflare Container -- see that
 * file's own doc comment -- so anything worth inspecting from outside
 * this process during a live investigation must be surfaced through
 * /status instead).
 *
 * ROOT-CAUSE INVESTIGATION (2026-08-22): this connector never listened
 * to messages.upsert at all before this fix (confirmed via grep before
 * the change -- zero matches), meaning it was structurally blind to
 * ANY incoming message, including a genuine WhatsApp-server-originated
 * account-status/risk notice (which arrives as an ordinary message from
 * WhatsApp's own system JID, not a connection-level event). This module
 * is what makes "has this account received any such notice recently"
 * an answerable, evidence-based question instead of a guess -- directly
 * relevant to the hypothesis that WhatsApp may be silently suppressing
 * delivery for unofficial-client (Baileys) accounts while still
 * reporting client-side send success.
 *
 * SAFE METADATA ONLY, same discipline as every other diagnostics module
 * in this file: never message content, never the sender's actual
 * phone number/JID -- only fromMe, isFromWhatsAppSystem (a boolean, not
 * the JID itself), messageType, upsertType, and timestamp.
 */

const MAX_ENTRIES = 20

interface IncomingMessageEntry {
  fromMe: boolean
  isFromWhatsAppSystem: boolean
  messageType: string | null
  upsertType: string
  timestampMs: number | null
  recordedAt: string
}

const recentIncomingMessages: IncomingMessageEntry[] = []

export function recordIncomingMessage(meta: {
  fromMe: boolean
  isFromWhatsAppSystem: boolean
  messageType: string | null
  upsertType: string
  timestampMs: number | null
}): void {
  recentIncomingMessages.push({ ...meta, recordedAt: new Date().toISOString() })
  if (recentIncomingMessages.length > MAX_ENTRIES) {
    recentIncomingMessages.shift()
  }
}

export function getIncomingMessageDiagnosticsSnapshot(): {
  totalRecorded: number
  recent: IncomingMessageEntry[]
} {
  return {
    totalRecorded: recentIncomingMessages.length,
    recent: recentIncomingMessages,
  }
}
