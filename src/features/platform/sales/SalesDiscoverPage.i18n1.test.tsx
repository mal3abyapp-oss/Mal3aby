import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { SalesDiscoverPage } from './SalesDiscoverPage'

// I18N-1 (owner brief, 2026-09-21): the manual-entry "Website" field
// label was a raw hardcoded English string ("Website") that bypassed
// t() entirely -- every sibling field (business name, phone, email,
// country, city) correctly used t(), but this one field silently never
// switched language. Confirmed by grepping every sales feature file for
// JSX text nodes that don't route through t() -- the same bug existed
// twice (this file's manual-entry form, and the copy-pasted edit-
// contact dialog on SalesLeadDetailPage.tsx). Locked in here: rendering
// in Arabic must show the Arabic label, never the English literal.

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
      <MemoryRouter>
        <SalesDiscoverPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SalesDiscoverPage — I18N-1: manual-entry Website label is translated', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    mockFrom.mockReset()
    mockFrom.mockImplementation(() => ({
      select: () => ({
        order: () => ({
          limit: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }))
    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_sales_provider_status') {
        return Promise.resolve({
          data: [
            { provider_key: 'google_places', enabled: true, is_configured: true, daily_cap: 100, config: {} },
            { provider_key: 'ai_offer_generator', enabled: false, is_configured: false, daily_cap: 50, config: {} },
            { provider_key: 'website_enrichment', enabled: true, is_configured: true, daily_cap: 100, config: {} },
          ],
          error: null,
        })
      }
      return Promise.resolve({ data: [], error: null })
    })
    await i18n.changeLanguage('ar')
  })

  it('shows the Arabic Website label, never the hardcoded English literal, when the UI is set to Arabic', async () => {
    renderPage()

    expect(await screen.findByText(i18n.t('platform.sales.discover.manualWebsiteLabel'))).toBeInTheDocument()
    expect(screen.queryByText('Website')).not.toBeInTheDocument()
  })
})
