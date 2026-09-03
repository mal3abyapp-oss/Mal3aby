import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import './lib/version' // logs the real build SHA/time once on load -- see item D of the 2026-08-27 auth/cache bugfix directive.
import { generateIncidentId, reportClientError } from './lib/errorReporting'
import { initI18n } from './lib/i18n/config'

// PRODUCTION MONITORING (Phase 3, 2026-08-28): ErrorBoundary only ever
// catches errors thrown during React's own render/lifecycle -- it has
// no visibility into an error thrown from a plain DOM event handler, a
// setTimeout callback, or a rejected Promise nobody awaited/caught.
// Those are real, common failure shapes in this app (e.g. an unhandled
// rejection from a fire-and-forget mutation) that previously vanished
// with nothing beyond whatever the browser's own devtools console
// happened to show -- no incident id, no beacon, nothing queryable
// after the fact. These two window-level listeners close that gap
// using the exact same sanitized-report path ErrorBoundary uses, so
// both failure shapes are covered by one consistent mechanism.
window.addEventListener('error', (event) => {
  const incidentId = generateIncidentId()
  console.error(`[incident ${incidentId}] Unhandled window error:`, event.error ?? event.message)
  reportClientError({
    incidentId,
    message: event.error instanceof Error ? event.error.message : String(event.message ?? 'unknown error'),
    stack: event.error instanceof Error ? event.error.stack : null,
    source: 'window_error',
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const incidentId = generateIncidentId()
  console.error(`[incident ${incidentId}] Unhandled promise rejection:`, event.reason)
  const reason = event.reason as unknown
  reportClientError({
    incidentId,
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : null,
    source: 'unhandled_rejection',
  })
})

// PERF-03: config.ts's i18n init is now async -- it dynamically imports
// only the detected/stored locale's translation JSON instead of both
// languages being bundled into main at module scope (was 126.5KB gzip,
// 36% of the main chunk, on every load regardless of language). Awaiting
// it here keeps React's render fully synchronous once it starts (no
// Suspense boundary needed anywhere downstream) -- this only delays the
// very first paint by one small same-origin chunk fetch, which is still
// strictly less data than the old eager double-import.
void initI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
