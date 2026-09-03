import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { SalesDiscoverPage } from './SalesDiscoverPage'

// Phase 18/2 regression test: "if a required paid external provider is
// not already authorized: do not purchase/enable it automatically...
// surface it as configuration required, while continuing everything
// else possible." This locks in that when google_places is not
// configured (get_sales_provider_status returns is_configured: false),
// the Discover Leads screen surfaces the CONFIGURATION_BLOCKED message
// AND disables the Start Discovery button -- it must not silently allow
// a doomed discovery attempt, and it must not hide the rest of the page
// (manual entry stays usable).

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

describe('SalesDiscoverPage — CONFIGURATION_BLOCKED provider handling (Phase 2/18)', () => {
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
            { provider_key: 'google_places', enabled: false, is_configured: false, daily_cap: 100, config: {} },
            { provider_key: 'ai_offer_generator', enabled: false, is_configured: false, daily_cap: 50, config: {} },
            { provider_key: 'website_enrichment', enabled: true, is_configured: true, daily_cap: 100, config: {} },
          ],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    })
    await i18n.changeLanguage('en')
  })

  it('shows the configuration-required message and disables Start Discovery when google_places has no credential', async () => {
    renderPage()

    expect(await screen.findByText(i18n.t('platform.sales.discover.configurationBlocked'))).toBeInTheDocument()

    const startButton = screen.getByRole('button', { name: i18n.t('platform.sales.discover.startButton') })
    expect(startButton).toBeDisabled()
  })

  it('never calls the discovery Edge Function while the provider is unconfigured', async () => {
    renderPage()
    await screen.findByText(i18n.t('platform.sales.discover.configurationBlocked'))
    // No RPC/fetch attempt to actually run discovery should have happened --
    // only the read-only status/jobs queries this page loads on mount.
    expect(mockRpc).not.toHaveBeenCalledWith('sales_check_and_increment_quota', expect.anything())
  })

  it('still renders the manual-entry section so non-blocked work continues (mission: "continue with all non-blocked work")', async () => {
    renderPage()
    await screen.findByText(i18n.t('platform.sales.discover.configurationBlocked'))
    expect(screen.getByText(i18n.t('platform.sales.discover.manualEntryTitle'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: i18n.t('platform.sales.discover.manualEntryButton') })).toBeInTheDocument()
  })
})
