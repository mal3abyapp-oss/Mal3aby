import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { DirectionProvider } from '@/app/providers/DirectionProvider'
import { SalesDiscoverPage } from './SalesDiscoverPage'

const mockRpc = vi.fn()
const mockFrom = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
    auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 'test' } } }) },
  },
}))

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <DirectionProvider>
        <MemoryRouter><SalesDiscoverPage /></MemoryRouter>
      </DirectionProvider>
    </QueryClientProvider>,
  )
}

describe('SalesDiscoverPage discovery job details', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    mockFrom.mockReset()
    mockFrom.mockImplementation(() => ({
      select: () => ({
        order: () => ({
          limit: () => Promise.resolve({
            data: [{
              id: '11111111-2222-3333-4444-555555555555',
              status: 'completed',
              discovered_count: 8,
              new_count: 5,
              duplicate_count: 3,
              enriched_count: 0,
              failed_count: 0,
              skipped_count: 0,
              search_params: { query: 'football fields', city: 'Cairo', country: 'EG' },
              attempts: 1,
              started_at: '2026-09-23T10:00:00Z',
              finished_at: '2026-09-23T10:01:00Z',
              created_at: '2026-09-23T10:00:00Z',
              last_error: null,
            }],
            error: null,
          }),
        }),
      }),
    }))
    mockRpc.mockResolvedValue({
      data: [{ provider_key: 'google_places', enabled: true, is_configured: true, daily_cap: 100 }],
      error: null,
    })
    await i18n.changeLanguage('ar')
  })

  it('opens and closes a discovery job to show its identifying details', async () => {
    renderPage()

    const openButton = await screen.findByRole('button', { name: /فتح المهمة/ })
    expect(openButton).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(openButton)
    expect(screen.getByText('football fields')).toBeInTheDocument()
    expect(screen.getByText('11111111-2222-3333-4444-555555555555')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /إغلاق التفاصيل/ })).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByRole('button', { name: /إغلاق التفاصيل/ }))
    expect(screen.queryByText('football fields')).not.toBeInTheDocument()
  })
})
