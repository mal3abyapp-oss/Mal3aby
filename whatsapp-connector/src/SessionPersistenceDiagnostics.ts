/**
 * SessionPersistenceDiagnostics -- tiny in-memory counters/timestamps
 * for the onCredsUpdate persistence path (encryptAuthDirForClub +
 * SupabaseSync.storeSession), exposed read-only through
 * HealthServer.ts's /status endpoint. Mirrors ProcessDiagnostics.ts's
 * own established pattern.
 *
 * ROOT-CAUSE INVESTIGATION (2026-08-22), directive priority A/B (creds.
 * update persistence audit, session-store completeness): the manual
 * phone-to-phone control test PASSED (a real WhatsApp send from the
 * SAME account's primary phone reached its recipient cleanly),
 * definitively ruling out account-level restriction and isolating the
 * defect to the Baileys companion/session path specifically. The
 * onCredsUpdate hook (TenantConnectionManager.ts) that persists
 * auth-state changes to Postgres is currently entirely
 * fire-and-forget (`void encryptAuthDirForClub(...).then(...).catch(
 * err => console.error(...))`) -- this process's own stdout is
 * confirmed NOT visible via `wrangler tail` for a Cloudflare
 * Container, so a silently-failing persistence write here would be
 * completely invisible from outside the container, and would exactly
 * explain "socket reconnects fine (creds.json itself is small and
 * likely persisted early/reliably), but per-contact Signal session
 * state persisted incompletely across a restart" -- precisely the
 * P0 class of bug already found and fixed once in this file
 * (2026-08-19, "Waiting for this message") for a DIFFERENT specific
 * write path (state.keys.set) -- this module answers whether that
 * fix, and creds.update itself, are actually succeeding end-to-end in
 * production right now, not just wired up in code.
 */

interface PersistenceCounters {
  firedCount: number
  successCount: number
  failureCount: number
  lastFiredAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastFailureMessage: string | null
}

function emptyCounters(): PersistenceCounters {
  return {
    firedCount: 0,
    successCount: 0,
    failureCount: 0,
    lastFiredAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureMessage: null,
  }
}

// Two distinct sources, matching BaileysProvider.ts's own two trigger
// paths for onCredsUpdate -- 'creds_update' (the real Baileys
// creds.update event, top-level identity/registration state) and
// 'keys_set' (the wrapped state.keys.set(), per-contact Signal session
// keys -- the exact path the 2026-08-19 fix added a persistence
// trigger to, since it previously had none at all).
type PersistenceSource = 'creds_update' | 'keys_set' | 'session_repair'

const counters: Record<PersistenceSource, PersistenceCounters> = {
  creds_update: emptyCounters(),
  keys_set: emptyCounters(),
  session_repair: emptyCounters(),
}

export function recordPersistenceFired(source: PersistenceSource): void {
  counters[source].firedCount += 1
  counters[source].lastFiredAt = new Date().toISOString()
}

export function recordPersistenceSuccess(source: PersistenceSource): void {
  counters[source].successCount += 1
  counters[source].lastSuccessAt = new Date().toISOString()
}

export function recordPersistenceFailure(source: PersistenceSource, message: string): void {
  counters[source].failureCount += 1
  counters[source].lastFailureAt = new Date().toISOString()
  // Capped length -- defense in depth against an unexpectedly long
  // error message from a deep library call; never message content or
  // secrets (this is a persistence-layer error path, e.g. a network/DB
  // failure message, not anything touching plaintext/keys).
  counters[source].lastFailureMessage = message.slice(0, 200)
}

export function getSessionPersistenceDiagnosticsSnapshot(): typeof counters {
  return counters
}
