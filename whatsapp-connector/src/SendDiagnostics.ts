/**
 * SendDiagnostics -- tracks the LAST send attempt per club (in-memory,
 * this process's lifetime only), for the send-hang root-cause
 * investigation. Exposed read-only through HealthServer.ts's /status.
 *
 * Deliberately narrow: club id (already truncated, non-secret prefix),
 * generation, template key (a fixed enum value from templates.ts, never
 * user-authored text), stage reached, elapsed milliseconds, and outcome
 * -- never the message body, recipient phone number, QR token, invoice
 * token, or provider reference content beyond its own existence.
 */

export type SendStage = 'started' | 'text_sent' | 'media_sent' | 'timed_out' | 'error' | 'done'

interface SendAttemptRecord {
  clubId: string
  generation: number
  templateKey: string
  stage: SendStage
  startedAt: string
  elapsedMs: number | null
  outcome: 'success' | 'failed' | 'timed_out' | null
}

const lastAttemptByClub = new Map<string, SendAttemptRecord>()

export function recordSendStart(clubId: string, generation: number, templateKey: string): void {
  lastAttemptByClub.set(clubId, {
    clubId,
    generation,
    templateKey,
    stage: 'started',
    startedAt: new Date().toISOString(),
    elapsedMs: null,
    outcome: null,
  })
}

export function recordSendStage(clubId: string, stage: SendStage, elapsedMs: number): void {
  const existing = lastAttemptByClub.get(clubId)
  if (!existing) return
  existing.stage = stage
  existing.elapsedMs = elapsedMs
}

export function recordSendOutcome(clubId: string, outcome: 'success' | 'failed' | 'timed_out', elapsedMs: number): void {
  const existing = lastAttemptByClub.get(clubId)
  if (!existing) return
  existing.outcome = outcome
  existing.elapsedMs = elapsedMs
  existing.stage = 'done'
}

export function getSendDiagnosticsSnapshot(): SendAttemptRecord[] {
  return [...lastAttemptByClub.values()]
}
