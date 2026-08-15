import { RouterProvider } from 'react-router-dom'
import { QueryProvider } from '@/app/providers/QueryProvider'
import { DirectionProvider } from '@/app/providers/DirectionProvider'
import { AuthProvider } from '@/app/providers/AuthProvider'
import { router } from '@/app/routing/router'

export function App() {
  return (
    <QueryProvider>
      <DirectionProvider>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </DirectionProvider>
    </QueryProvider>
  )
}
