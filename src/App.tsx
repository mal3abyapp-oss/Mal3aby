import { RouterProvider } from 'react-router-dom'
import { QueryProvider } from '@/app/providers/QueryProvider'
import { DirectionProvider } from '@/app/providers/DirectionProvider'
import { router } from '@/app/routing/router'

export function App() {
  return (
    <QueryProvider>
      <DirectionProvider>
        <RouterProvider router={router} />
      </DirectionProvider>
    </QueryProvider>
  )
}
