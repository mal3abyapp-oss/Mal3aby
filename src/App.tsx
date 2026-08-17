import { RouterProvider } from 'react-router-dom'
import { QueryProvider } from '@/app/providers/QueryProvider'
import { DirectionProvider } from '@/app/providers/DirectionProvider'
import { AuthProvider } from '@/app/providers/AuthProvider'
import { router } from '@/app/routing/router'
import { ErrorBoundary } from '@/components/ui/error-boundary'

export function App() {
  return (
    <ErrorBoundary>
      <QueryProvider>
        <DirectionProvider>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </DirectionProvider>
      </QueryProvider>
    </ErrorBoundary>
  )
}
