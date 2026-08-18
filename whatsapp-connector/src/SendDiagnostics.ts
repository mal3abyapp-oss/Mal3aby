/**
 * SendDiagnostics -- tracks the LAST send attempt per club (in-memory,
 * this process's lifetime only), for the send-hang root-cause
 * investigation. Exposed read-only through HealthServer.ts's /status.
 *
 * Deliberately narrow: club id (already truncated, non-secret prefix),
 * generation, template key (a fixed enum value from templates.ts, never
 * user-authored text), stage reached, timestamps, elapsed milliseconds,
 * outcome, whether a provider reference exists (never its content, and
 * providerReference is Baileys' own message-id echo, not a secret --
 * still never logged verbatim here out of caution), and Baileys' OWN
 * error message when the failure is genuinely Baileys-reported (never
 * our own manufactured "never resolved" text, and never the message
 * body/recipient phone/QR token/invoice token).
 *
 * Added connectionOpenAt/resolvedAt (2026-08-18, production A/B test
 * requirement): the pending question after the 45s->75s change is NOT
 * "did it stop timing out" alone -- it's WHEN, relative to Baileys' own
 * documented ~60s ceiling, a real send actually resolves. Outcome
 * bucket A/B/C in BaileysProvider.ts's class-level doc comment depends
 * on being able to read resolvedAt - startedAt precisely from a live
 * /status call, not just an elapsedMs snapshot taken at one poll tick.
 */

export type SendStage = 'started' | 'text_sent' | 'media_sent' | 'timed_out' | 'error' | 'done'

interface SendAttemptRecord {
  clubId: string
  generation: number
  templateKey: string
  stage: SendStage
  startedAt: string
  /** Baileys' own connection.update 'open' timestamp for THIS generation, if known -- lets a reader compute "how long after connect was this send attempted". */
  connectionOpenAt: string | null
  /** Set the instant sendMessage() resolves OR rejects, whichever happens -- distinct from startedAt/elapsedMs so a reader can see the exact wall-clock moment, not just a duration snapshot from the last poll. */
  resolvedAt: string | null
  elapsedMs: number | null
  outcome: 'success' | 'failed' | 'timed_out' | null
  /** Baileys' own reported error message, ONLY when the failure is genuinely Baileys-reported (not our own withSendTimeout() text) -- outcome bucket B/C evidence. Never set for a timeout our own wrapper produced. */
  baileysErrorMessage: string | null
  hasProviderReference: boolean
}

const lastAttemptByClub = new Map<string, SendAttemptRecord>()
const connectionOpenAtByClubGeneration = new Map<string, string>()

/** Called from BaileysProvider.ts's connection.update handler when connection === 'open', so a later send attempt can report how long after connect it started. */
export function recordConnectionOpen(clubId: string, generation: number): void {
  connectionOpenAtByClubGeneration.set(`${clubId}:${generation}`, new Date().toISOString())
}

export function recordSendStart(clubId: string, generation: number, templateKey: string): void {
  lastAttemptByClub.set(clubId, {
    clubId,
    generation,
    templateKey,
    stage: 'started',
    startedAt: new Date().toISOString(),
    connectionOpenAt: connectionOpenAtByClubGeneration.get(`${clubId}:${generation}`) ?? null,
    resolvedAt: null,
    elapsedMs: null,
    outcome: null,
    baileysErrorMessage: null,
    hasProviderReference: false,
  })
}

export function recordSendStage(clubId: string, stage: SendStage, elapsedMs: number): void {
  const existing = lastAttemptByClub.get(clubId)
  if (!existing) return
  existing.stage = stage
  existing.elapsedMs = elapsedMs
}

export function recordSendOutcome(
  clubId: string,
  outcome: 'success' | 'failed' | 'timed_out',
  elapsedMs: number,
  options?: { baileysErrorMessage?: string; hasProviderReference?: boolean },
): void {
  const existing = lastAttemptByClub.get(clubId)
  if (!existing) return
  existing.outcome = outcome
  existing.elapsedMs = elapsedMs
  existing.resolvedAt = new Date().toISOString()
  existing.stage = 'done'
  // Only ever set for a GENUINE Baileys-reported error (never our own
  // withSendTimeout() "never resolved" text, which is already
  // classified via `outcome === 'timed_out'` and carries no useful
  // diagnostic content of its own) -- outcome bucket B/C evidence for
  // the production A/B test.
  if (options?.baileysErrorMessage) existing.baileysErrorMessage = options.baileysErrorMessage
  existing.hasProviderReference = options?.hasProviderReference ?? existing.hasProviderReference
}

export function getSendDiagnosticsSnapshot(): SendAttemptRecord[] {
  return [...lastAttemptByClub.values()]
}
