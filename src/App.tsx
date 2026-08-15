import { QueryProvider } from '@/app/providers/QueryProvider'

// Real routing (Public/App/Platform layouts + route guards) lands in
// Phase 1 — see docs/IMPLEMENTATION_PLAN.md Phase 1 and
// docs/ARCHITECTURE.md#public-website--layout-strategy.
// This is a Phase-0 placeholder confirming the build/dev pipeline works.
export function App() {
  return (
    <QueryProvider>
      <div dir="rtl" className="flex min-h-screen items-center justify-center bg-page-bg text-text-primary">
        <p className="font-arabic">ملعبي | Mala3by — قيد الإعداد</p>
      </div>
    </QueryProvider>
  )
}
