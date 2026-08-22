/**
 * SendProtocolDiagnostics -- tiny in-memory ring buffer capturing a
 * STRICT ALLOWLIST of Baileys' own internal `logger.debug()` lines from
 * the outbound send/relay path, exposed read-only through
 * HealthServer.ts's /status endpoint. Mirrors ProcessDiagnostics.ts's
 * and IncomingMessageDiagnostics.ts's own established pattern exactly
 * (this process's own stdout is confirmed NOT visible via `wrangler
 * tail` for a Cloudflare Container).
 *
 * ROOT-CAUSE INVESTIGATION (2026-08-22), directive sections 3-4, 6-7:
 * direct source inspection of @whiskeysockets/baileys@7.0.0-rc14's
 * Socket/messages-send.js confirmed relayMessage() never awaits any
 * server acknowledgment before returning -- sendNode(stanza) is a
 * fire-and-forget raw WebSocket write (confirmed again, unchanged from
 * 6.7.24, at Socket/socket.js's own sendRawMessage()). The ONE piece of
 * real diagnostic evidence Baileys' own relay code produces about what
 * it actually attempted is a debug-level log line immediately before
 * that send: `sending message to ${participants.length} devices` --
 * this connector's logger has always run at 'info' level in
 * production, so this line (and everything else at debug level) was
 * silently dropped and never seen. If participants.length is ever 0,
 * that alone is direct, conclusive evidence of an empty destination
 * device set -- i.e. Baileys itself believed there was nowhere to
 * deliver the message, which would fully explain silent non-delivery
 * with zero client-visible error.
 *
 * SAFETY: this is NOT a blanket debug-log capture. Pino's
 * hooks.logMethod intercepts EVERY log call at every level, but this
 * module's hook only inspects the message TEMPLATE (the first
 * argument, a static string Baileys itself wrote, e.g. "sending
 * message to %d devices") against a fixed allowlist of known-safe,
 * content-free patterns -- never the interpolated values' raw
 * objects, never anything from a template not on the allowlist. No
 * message content, no phone numbers, no JIDs, no crypto material is
 * ever capturable through this mechanism even if Baileys' own debug
 * logs happened to include them elsewhere (they do not, for this
 * specific set of lines, confirmed by direct source reading -- but the
 * allowlist-by-template design means this stays safe even if that
 * changes in a future Baileys version, since an unrecognized template
 * is simply never captured).
 */

const MAX_ENTRIES = 30

interface SendProtocolEntry {
  pattern: string
  detail: string
  recordedAt: string
}

const recentEvents: SendProtocolEntry[] = []

// Fixed allowlist: pattern name -> a regex matched against pino's
// rendered log line, and a SAFE extractor that pulls only the specific
// numeric/enum fields relevant to send-protocol forensics -- never the
// raw matched text itself (which could theoretically still contain
// interpolated values we haven't accounted for).
const ALLOWED_PATTERNS: Array<{ name: string; test: (msg: string) => boolean; extract: (msg: string) => string }> = [
  {
    name: 'sending_message_to_devices',
    test: (msg) => /sending message to \d+ devices/.test(msg),
    extract: (msg) => msg.match(/sending message to (\d+) devices/)?.[0] ?? 'sending message to N devices',
  },
  {
    name: 'device_fanout',
    test: (msg) => /fetched \d+ devices/i.test(msg) || /device list/i.test(msg),
    extract: (msg) => (msg.match(/fetched (\d+) devices/i)?.[0] ?? 'device list event').slice(0, 100),
  },
  {
    name: 'retry_receipt',
    test: (msg) => /retry.?receipt/i.test(msg),
    extract: () => 'retry receipt event',
  },
  {
    name: 'session_error',
    test: (msg) =>
      /bad mac/i.test(msg) ||
      /no session/i.test(msg) ||
      /invalid prekey/i.test(msg) ||
      /untrusted identity/i.test(msg) ||
      /failed to (encrypt|decrypt)/i.test(msg) ||
      /sessionerror/i.test(msg),
    // Session-error lines are the one category where the message text
    // itself IS the useful signal (an error class name, e.g. "Bad MAC"
    // -- never message content) -- capped length as defense in depth.
    extract: (msg) => msg.slice(0, 150),
  },
]

/**
 * Pino hooks.logMethod signature: (args, method, level) => void, called
 * BEFORE the log line is actually written. `args[0]` is the merging
 * object or message string depending on call shape; Baileys' own code
 * consistently calls `logger.debug({...}, 'message template')`, so
 * args[1] is what we inspect here.
 */
export function inspectBaileysLogCall(args: unknown[]): void {
  const msg = typeof args[1] === 'string' ? args[1] : typeof args[0] === 'string' ? args[0] : null
  if (!msg) return
  for (const pattern of ALLOWED_PATTERNS) {
    if (pattern.test(msg)) {
      recentEvents.push({ pattern: pattern.name, detail: pattern.extract(msg), recordedAt: new Date().toISOString() })
      if (recentEvents.length > MAX_ENTRIES) recentEvents.shift()
      return
    }
  }
}

export function getSendProtocolDiagnosticsSnapshot(): { totalRecorded: number; recent: SendProtocolEntry[] } {
  return { totalRecorded: recentEvents.length, recent: recentEvents }
}
