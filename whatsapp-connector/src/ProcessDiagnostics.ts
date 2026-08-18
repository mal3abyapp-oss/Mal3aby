/**
 * ProcessDiagnostics -- tiny in-memory counters for process-level
 * uncaughtException/unhandledRejection events, exposed read-only through
 * HealthServer.ts's /status endpoint (already wrangler-tail-visible via
 * WhatsAppAccountObject.ts's pollHealthAndDecide() diagnostic logging).
 *
 * WHY THIS EXISTS (send-hang root-cause investigation, 2026-08-18): this
 * connector's index.ts installCrashGuards() deliberately swallows
 * uncaughtException/unhandledRejection to keep the whole process alive
 * after a single internal library error (a real, documented fix for a
 * prior crash -- see index.ts's own doc comment). But that swallow was
 * previously silent from the OUTSIDE: wrangler tail never sees a
 * Container's own stdout (confirmed empirically earlier in this
 * investigation), so there was no way to correlate "did an uncaught
 * exception fire recently" against "is a specific sendMessage() call now
 * hanging" without this. If Baileys' own internal state (its retry
 * queue, its pending-query correlation maps, etc.) is ever left
 * corrupted by an exception that this process's crash guard caught and
 * discarded, THIS is what proves it -- a send that hangs shortly after a
 * recorded exception is real evidence for "corrupted in-memory Baileys
 * state", not proof on its own, but exactly the missing correlation
 * needed to accept or reject that hypothesis instead of guessing.
 *
 * Never records the actual error message/stack here (that already goes
 * to this process's own stdout via index.ts, which is fine -- it is
 * never forwarded to Supabase or the Worker) -- only a timestamp and a
 * count, since a full error message could incidentally contain
 * something sensitive coming from deep inside a third-party library.
 */

let uncaughtExceptionCount = 0
let lastUncaughtExceptionAt: string | null = null
let unhandledRejectionCount = 0
let lastUnhandledRejectionAt: string | null = null

export function recordUncaughtException(): void {
  uncaughtExceptionCount += 1
  lastUncaughtExceptionAt = new Date().toISOString()
}

export function recordUnhandledRejection(): void {
  unhandledRejectionCount += 1
  lastUnhandledRejectionAt = new Date().toISOString()
}

export function getProcessDiagnosticsSnapshot() {
  return {
    uncaughtExceptionCount,
    lastUncaughtExceptionAt,
    unhandledRejectionCount,
    lastUnhandledRejectionAt,
  }
}
