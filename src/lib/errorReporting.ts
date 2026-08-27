import { BUILD_SHA } from '@/lib/version'

// PRODUCTION MONITORING (Phase 3, 2026-08-28): shared frontend error-
// reporting helper. Used by ErrorBoundary (React render errors) and by
// the top-level window 'error'/'unhandledrejection' listeners installed
// in main.tsx (errors OUTSIDE the render tree -- event handlers, async
// callbacks, promise rejections -- which a React error boundary never
// catches at all, a real gap the previous "ErrorBoundary is the only
// error handling" state left completely uncovered).
//
// Design constraints, deliberately mirroring the sanitize*Error()
// discipline already established across every payment gateway Edge
// Function (supabase/functions/*/index.ts):
//   - never include PII (no customer name/phone/email -- none of that
//     is even available at this layer, by construction)
//   - never include secrets/tokens/raw request or response bodies --
//     only a client-generated incident id, the error message, a capped
//     stack trace, the current build SHA, and the current path
//   - best-effort, fire-and-forget: a failure to report an error must
//     never itself throw, block the UI, or become a second visible
//     error -- catches its own network failure silently
//   - same-origin only, matches the CSP's connect-src 'self' -- posts
//     to this app's own Worker route (/api/client-error), never a
//     third party
//
// correlation_id note (directive item 6): payment_gateway_transactions
// already has its own DB-generated correlation_id for the payment
// domain (see docs/PRODUCTION_MONITORING.md). This is a DIFFERENT,
// deliberately lightweight pattern for the frontend-error domain --
// generated client-side per error, never written to Postgres, and
// never joined against the payment correlation_id. Extending a single
// shared correlation-id column across both domains was considered and
// rejected: a render error has no necessary relationship to any
// in-flight payment, so forcing one shared identifier space would
// either leave the column null in the overwhelming majority of error
// reports or invite conflating two unrelated concepts. Cross-referencing
// stays possible via TIME WINDOW + build SHA (this incident id, shown
// to the user, appears verbatim in the corresponding Workers Logs
// entry -- see the beacon route in cloudflare/frontend-worker/src/index.ts)
// without needing a shared column.
export function generateIncidentId(): string {
  // crypto.randomUUID() is available in all browsers this app already
  // requires (same API the backend's gen_random_uuid()-backed
  // correlation_id pattern is conceptually modeled on) -- no new
  // dependency, no external ID service.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Extremely defensive fallback for an environment without
  // crypto.randomUUID (pre-2022 browser) -- not cryptographically
  // strong, but this id is only ever a human-facing correlation
  // reference, never a security boundary, so this is an acceptable
  // degradation rather than a hard failure.
  return `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

interface ReportClientErrorInput {
  incidentId: string
  message: string
  stack?: string | null
  componentStack?: string | null
  source: 'error_boundary' | 'window_error' | 'unhandled_rejection'
}

const FIELD_MAX_CHARS = 2000

function cap(value: string | null | undefined, max: number): string | null {
  if (!value) return null
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
}

/**
 * Fire-and-forget POST of a sanitized error report to this app's own
 * Worker route. Never throws, never awaited by callers for its result --
 * reporting an error must never become a reason a user-facing recovery
 * path (e.g. ErrorBoundary's reload button) is delayed or blocked.
 */
export function reportClientError(input: ReportClientErrorInput): void {
  try {
    const body = JSON.stringify({
      incident_id: input.incidentId,
      message: cap(input.message, 500),
      build_sha: BUILD_SHA,
      path: cap(typeof window !== 'undefined' ? window.location.pathname : null, 300),
      stack: cap(input.stack, FIELD_MAX_CHARS),
      component_stack: cap(input.componentStack, FIELD_MAX_CHARS),
      source: input.source,
    })

    // navigator.sendBeacon survives the page unloading/navigating away
    // immediately after a crash (the exact moment this matters most);
    // fetch with keepalive is the fallback for environments/tests where
    // sendBeacon isn't available. Both are same-origin, no-cors-relevant
    // since this is same-origin to begin with.
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' })
      const sent = navigator.sendBeacon('/api/client-error', blob)
      if (sent) return
    }

    if (typeof fetch === 'function') {
      void fetch('/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {
        // Best-effort only -- see file header. Never surface this.
      })
    }
  } catch {
    // Never let error reporting itself throw -- see file header.
  }
}
