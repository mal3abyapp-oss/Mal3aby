/**
 * OptOutKeywordMatcher -- ban-protection hardening (2026-09-12). Two
 * narrow, conservative text-pattern checks, both privacy-preserving by
 * construction: the caller passes message text in, gets back ONLY a
 * boolean (or a short, pre-defined classification string for the
 * ban-notice case) -- the raw text itself is never returned, logged,
 * or persisted anywhere by this module or its callers. This matches
 * every other diagnostics module in this connector's own established
 * "safe metadata only" discipline (see IncomingMessageDiagnostics.ts's
 * own doc comment).
 *
 * 1. isOptOutKeyword(): a real customer (never fromMe, never the
 *    WhatsApp-system JID) texting a stop/إيقاف-shaped message should
 *    result in an automatic suppression -- this was previously ONLY
 *    ever staff- or system-failure-triggered (notification_suppressions,
 *    reason='opted_out'), never customer-message-triggered. Matches a
 *    short, deliberately narrow allowlist of unambiguous opt-out
 *    words/phrases in Arabic and English -- NOT a broad sentiment
 *    classifier, which would risk false-positive-suppressing a
 *    legitimate customer message that merely contains an unrelated
 *    word.
 *
 * 2. isKnownBanNoticeShape(): a real WhatsApp-server account-risk/
 *    restriction notice (arrives as an ordinary message FROM
 *    WhatsApp's own system JID, per IncomingMessageDiagnostics.ts's own
 *    prior investigation) has a well-documented, narrow set of actual
 *    phrasings WhatsApp itself uses (e.g. references to "banned",
 *    "violat(ing|ed) (our|the) terms", "temporarily restricted"). This
 *    checks ONLY messages already confirmed to be from that system JID
 *    -- never a general scan of arbitrary incoming text -- so a false
 *    match can only ever occur on a message WhatsApp's own servers
 *    sent, not on ordinary customer/lead conversation.
 */

const OPT_OUT_PATTERNS: RegExp[] = [
  /^\s*(stop|unsubscribe|cancel)\s*$/i,
  // إيقاف/ايقاف covers both the correctly-hamzated spelling and the
  // common un-hamzated one (hamzas are frequently dropped when typing
  // Arabic on a phone keyboard) -- both mean the same word. توقف is
  // arguably the single most natural everyday way to say "stop" in
  // Arabic and was missing from the original list.
  /^\s*(إيقاف|ايقاف|توقف|وقف|إلغاء(?:\s*الاشتراك)?|لا\s*ترسل(?:وا)?)\s*$/,
]

export function isOptOutKeyword(messageText: string): boolean {
  const trimmed = messageText.trim()
  if (trimmed.length === 0 || trimmed.length > 40) return false
  return OPT_OUT_PATTERNS.some((p) => p.test(trimmed))
}

const BAN_NOTICE_PATTERNS: RegExp[] = [
  /\bbanned\b/i,
  /\bviolat(?:ed|ing|es)\s+(?:our|the)\s+terms\b/i,
  /\btemporarily\s+(?:restricted|suspended)\b/i,
  /\baccount\s+has\s+been\s+(?:banned|restricted|suspended)\b/i,
]

export function isKnownBanNoticeShape(messageText: string): boolean {
  return BAN_NOTICE_PATTERNS.some((p) => p.test(messageText))
}
