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
  {
    // ROOT-CAUSE INVESTIGATION (2026-08-22), directive priorities C/D/F
    // -- messages-send.js's assertSessions() logs this line with a
    // merging object carrying `jids` (every JID this send is being
    // encrypted to) BEFORE checking which already have a valid local
    // Signal session. The template alone (captured via the message-
    // string path below) doesn't carry the count -- this pattern is
    // matched by TEMPLATE here for symmetry with the others, but its
    // real count comes from the separate array-length extraction path
    // in inspectBaileysLogCall (never the raw jids array itself).
    name: 'assert_sessions_call',
    test: (msg) => msg === 'assertSessions call with jids',
    extract: () => 'assertSessions call with jids',
  },
  {
    // The genuinely real server round-trip in this whole file: unlike
    // the fire-and-forget sendNode(stanza) at the end of relayMessage,
    // this one IS awaited via query()/waitForMessage() -- a real IQ
    // request/response with WhatsApp's own servers, fetching PreKey
    // bundles for any JID that didn't already have a valid session.
    // jidsRequiringFetch.length === 0 here would mean every recipient
    // device already had a valid session (no fresh negotiation
    // needed); a non-zero count proves a real prekey fetch was
    // attempted -- and this call's own success/failure (it can throw,
    // e.g. on a query timeout) is what genuinely determines whether
    // devices lacking a session got one before the send proceeded.
    name: 'fetching_sessions',
    test: (msg) => msg === 'fetching sessions',
    extract: () => 'fetching sessions (real IQ round-trip to WhatsApp servers)',
  },
  {
    // Directive priority G: which addressing form Baileys itself chose
    // for THIS specific conversation -- LID or PN -- decided
    // internally now (v7), not by anything this connector passes in.
    name: 'lid_or_pn_identity_choice',
    test: (msg) => /Using (LID|PN) identity for @(lid|s\.whatsapp\.net) conversation/.test(msg),
    extract: (msg) => msg,
  },
]

// ROOT-CAUSE INVESTIGATION (2026-08-22), directive priorities C/D/F --
// a SEPARATE, narrow allowlist for extracting a SAFE ARRAY LENGTH ONLY
// (never the array's own contents -- no JIDs, ever) from the merging
// object Baileys passes alongside specific known message templates.
// Each entry names the exact template string it applies to and the
// exact key(s) whose .length is safe to read.
const ARRAY_LENGTH_EXTRACTORS: Array<{ template: string; keys: string[] }> = [
  { template: 'assertSessions call with jids', keys: ['jids'] },
  { template: 'fetching sessions', keys: ['jidsRequiringFetch', 'wireJids'] },
]

function safeArrayLength(mergingObject: unknown, key: string): number | null {
  if (mergingObject === null || typeof mergingObject !== 'object') return null
  const value = (mergingObject as Record<string, unknown>)[key]
  return Array.isArray(value) ? value.length : null
}

/**
 * Pino hooks.logMethod signature: (args, method, level) => void, called
 * BEFORE the log line is actually written. `args[0]` is the merging
 * object or message string depending on call shape; Baileys' own code
 * consistently calls `logger.debug({...}, 'message template')`, so
 * args[1] is what we inspect here for the message text. The merging
 * object at args[0] is NEVER captured wholesale -- only specific,
 * pre-named keys' array LENGTHS are ever read from it (see
 * ARRAY_LENGTH_EXTRACTORS above), and only when the message template
 * matches one of that allowlist's exact strings.
 */
export function inspectBaileysLogCall(args: unknown[]): void {
  const msg = typeof args[1] === 'string' ? args[1] : typeof args[0] === 'string' ? args[0] : null
  if (!msg) return

  const lengthExtractor = ARRAY_LENGTH_EXTRACTORS.find((e) => e.template === msg)
  if (lengthExtractor && typeof args[1] === 'string') {
    const mergingObject = args[0]
    const counts = lengthExtractor.keys
      .map((key) => `${key}=${safeArrayLength(mergingObject, key) ?? '?'}`)
      .join(', ')
    recentEvents.push({
      pattern: `${msg.replace(/\s+/g, '_')}_counts`,
      detail: counts,
      recordedAt: new Date().toISOString(),
    })
    if (recentEvents.length > MAX_ENTRIES) recentEvents.shift()
    return
  }

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
