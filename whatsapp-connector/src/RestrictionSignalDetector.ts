/**
 * RestrictionSignalDetector -- ban-protection hardening (2026-09-12).
 * Detects the ONE genuine, protocol-level WhatsApp-side restriction
 * signal an unofficial Multi-Device client can actually observe: a
 * repeated pattern of `403 forbidden` disconnects from WhatsApp's own
 * servers in a short window.
 *
 * WHY 403 SPECIFICALLY, AND WHY A PATTERN NOT A SINGLE OCCURRENCE:
 * Baileys' own DisconnectReason enum (confirmed by direct inspection of
 * the installed @whiskeysockets/baileys package) maps HTTP-shaped
 * status codes to disconnect reasons: 401=loggedOut (a normal
 * user-initiated unlink -- already handled, never a restriction
 * signal), 403=forbidden (WhatsApp's OWN servers actively refusing the
 * connection -- the closest real signal to "this account/session has
 * been restricted"), 440=connectionReplaced (a session conflict, e.g.
 * two processes fighting over one identity -- NOT a ban signal, this
 * project has its own documented incident history of that exact
 * failure mode from an unrelated bug), 500=badSession (a corrupted
 * local session -- can happen for entirely benign reasons, e.g. a
 * genuinely stale auth dir, not necessarily a ban).
 *
 * A SINGLE 403 is not conclusive by itself (a transient server-side
 * hiccup is possible) -- this detector requires MULTIPLE 403s within a
 * short rolling window before reporting a real restriction signal,
 * mirroring the existing circuit-breaker's own "failure RATE over a
 * rolling window, not a raw count" discipline
 * (20260817044244_safe_messaging_rate_control_circuit_breaker.sql) so
 * this detector's evidence bar is exactly as conservative as the
 * mechanism it complements, not a hair-trigger false alarm.
 *
 * This is NOT a claim that 403 always means "banned" -- it is the
 * single most specific, real, externally-observable signal available
 * to an unofficial client, reported honestly as "a restriction signal
 * was observed" so a human can investigate, never as an automated
 * "your number is banned" diagnosis this connector has no way to make
 * with certainty.
 */

const RESTRICTION_WINDOW_MS = 10 * 60 * 1000 // 10 minutes
const RESTRICTION_THRESHOLD = 3 // 3 forbidden disconnects within the window

const forbiddenTimestampsByKey = new Map<string, number[]>()

/**
 * Records one 403/forbidden disconnect for the given identity key
 * (clubId or the platform's own sentinel session_key -- this module is
 * shared by both domains, keyed the same opaque way BaileysProvider
 * itself already is). Returns true exactly once the pattern crosses
 * the threshold within the window -- the caller reports a restriction
 * signal on that transition, not on every subsequent 403 while the
 * account remains in that state (the DB-side RPC already sets a
 * terminal 'restricted' status that a human must acknowledge, so
 * repeated reporting after the first would be redundant, not more
 * informative).
 */
export function recordForbiddenDisconnect(key: string): boolean {
  const now = Date.now()
  const existing = forbiddenTimestampsByKey.get(key) ?? []
  const withinWindow = existing.filter((ts) => now - ts < RESTRICTION_WINDOW_MS)
  withinWindow.push(now)
  forbiddenTimestampsByKey.set(key, withinWindow)
  return withinWindow.length >= RESTRICTION_THRESHOLD
}

/** Clears this key's recorded history -- called on a fresh, successful connection (a genuinely re-established session means the prior pattern is no longer live evidence of an ongoing restriction). */
export function clearForbiddenDisconnectHistory(key: string): void {
  forbiddenTimestampsByKey.delete(key)
}

export function describeForbiddenPattern(key: string): string {
  const count = (forbiddenTimestampsByKey.get(key) ?? []).length
  return `${count}x 403 forbidden disconnect within ${RESTRICTION_WINDOW_MS / 60000} minutes`
}
