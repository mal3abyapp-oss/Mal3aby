import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Top-level render-error safety net. Without this, any uncaught error in
// the render tree unmounts the whole React app and the user sees a blank
// white screen with no way to recover. This is deliberately minimal --
// no external error-tracking integration (out of scope, needs a Sentry
// account) -- it only prevents the blank-screen failure mode and offers
// a reload. See MAL3ABY_PRODUCTION_READINESS.md (Observability).
interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Dev-console only -- never surface raw error detail in the UI.
    // See docs/SECURITY_ANTI_FRAUD.md (error handling never leaks internals).
    console.error('Unhandled render error caught by ErrorBoundary:', error, info.componentStack)
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-page-bg px-6 text-center">
          <AlertTriangle className="size-12 text-status-danger" aria-hidden="true" />
          <div>
            <p className="text-lg font-semibold text-text-primary">حدث خطأ غير متوقع</p>
            <p className="mt-1 text-sm text-text-secondary">
              حاول إعادة تحميل الصفحة. إذا استمرت المشكلة، تواصل مع الدعم الفني.
            </p>
          </div>
          <Button onClick={this.handleReload}>إعادة تحميل الصفحة</Button>
        </div>
      )
    }

    return this.props.children
  }
}
