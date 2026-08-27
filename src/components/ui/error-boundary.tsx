import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import i18n from '@/lib/i18n/config'
import { generateIncidentId, reportClientError } from '@/lib/errorReporting'
import { BUILD_SHA } from '@/lib/version'

// Top-level render-error safety net. Without this, any uncaught error in
// the render tree unmounts the whole React app and the user sees a blank
// white screen with no way to recover.
//
// PRODUCTION MONITORING (Phase 3, 2026-08-28): previously this comment
// said "no external error-tracking integration -- out of scope, needs a
// Sentry account". That framing was stale -- the actual production-
// hardening requirement was never "add Sentry specifically", it was
// "monitor errors using what the current free-tier Cloudflare/Supabase
// stack already supports, without a new paid service". That IS
// achievable without Sentry: every render error now gets (1) a
// client-generated incident id shown to the user, so a support
// conversation has a concrete reference instead of "it just broke",
// and (2) a best-effort sanitized beacon (see src/lib/errorReporting.ts)
// to this app's own Cloudflare Worker, which logs it via console.error
// -- captured for free by Workers Logs (7-day retention, dashboard
// Query Builder; see cloudflare/frontend-worker/wrangler.jsonc and
// docs/PRODUCTION_MONITORING.md for the full picture, including what
// this approach does NOT give you compared to a real APM: no alerting/
// paging, no cross-session error grouping/dedup, no release-health
// dashboards -- those remain genuine gaps, honestly documented rather
// than silently claimed as solved).
interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  incidentId: string | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, incidentId: null }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true, incidentId: generateIncidentId() }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const incidentId = this.state.incidentId ?? generateIncidentId()
    // Dev-console only for the raw error object -- never surface raw
    // error detail in the UI. See docs/SECURITY_ANTI_FRAUD.md (error
    // handling never leaks internals). The incident id ties this
    // console entry to both what the user sees on screen and (if the
    // beacon succeeds) the corresponding Workers Logs entry.
    console.error(`[incident ${incidentId}] Unhandled render error caught by ErrorBoundary:`, error, info.componentStack)
    reportClientError({
      incidentId,
      message: error.message || String(error),
      stack: error.stack,
      componentStack: info.componentStack,
      source: 'error_boundary',
    })
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      // Class component -- can't use the useTranslation() hook, so we read
      // the shared i18next instance directly (same store React-i18next's
      // hook reads from, kept in sync with the active language/locale).
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-page-bg px-6 text-center">
          <AlertTriangle className="size-12 text-status-danger" aria-hidden="true" />
          <div>
            <p className="text-lg font-semibold text-text-primary">{i18n.t('errorBoundary.title')}</p>
            <p className="mt-1 text-sm text-text-secondary">
              {i18n.t('errorBoundary.description')}
            </p>
            {this.state.incidentId && (
              <p className="mt-2 text-xs text-text-secondary" dir="ltr">
                {i18n.t('errorBoundary.incidentId', { id: this.state.incidentId })}
              </p>
            )}
          </div>
          <Button onClick={this.handleReload}>{i18n.t('errorBoundary.reload')}</Button>
          <p className="text-[10px] text-text-secondary/70" dir="ltr">
            build {BUILD_SHA}
          </p>
        </div>
      )
    }

    return this.props.children
  }
}
