import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { SalesDashboardPage } from './SalesDashboardPage'

// REP-1 (owner brief, 2026-09-21): every Sales Intelligence report was
// previously all-time cumulative only, do_not_contact leads were
// silently counted in total_leads with no visibility, and
// get_sales_stats_by_dimension() was fully built server-side but never
// wired to any UI. This locks in: the date-range filter reaches
// get_sales_dashboard_summary/get_sales_funnel_stats with the right
// params, the new suppressed stat renders, and the by-dimension card
// renders with a working CSV export.

const mockRpc = vi.fn()

const SUMMARY = {
  total_leads: 10, hot_leads: 2, warm_leads: 3, cold_leads: 5, contact_ready: 4,
  contacted: 6, demos_scheduled: 1, converted: 1, reply_rate: 50, demo_rate: 20,
  win_rate: 10, avg_days_to_conversion: 5, suppressed_count: 3,
}

const DIMENSION_ROWS = [
  { dimension_value: 'EG', lead_count: 8, won_count: 1 },
  { dimension_value: 'SA', lead_count: 2, won_count: 0 },
]

vi.mock('@/lib/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}))

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SalesDashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SalesDashboardPage — REP-1', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    await i18n.changeLanguage('en')

    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_sales_dashboard_summary') return Promise.resolve({ data: [SUMMARY], error: null })
      if (fnName === 'get_sales_funnel_stats') return Promise.resolve({ data: [], error: null })
      if (fnName === 'get_sales_stats_by_source') return Promise.resolve({ data: [], error: null })
      if (fnName === 'get_sales_stats_by_dimension') return Promise.resolve({ data: DIMENSION_ROWS, error: null })
      if (fnName === 'get_pending_followups') return Promise.resolve({ data: [], error: null })
      if (fnName === 'get_sales_upcoming_demos') return Promise.resolve({ data: [], error: null })
      return Promise.resolve({ data: null, error: null })
    })
  })

  it('shows the previously-invisible suppressed (do_not_contact) count', async () => {
    renderPage()
    const label = await screen.findByText(i18n.t('platform.sales.dashboard.suppressed'))
    const card = label.closest('div')?.parentElement
    await waitFor(() => expect(card).toHaveTextContent('3'))
  })

  it('passes the selected date range through to the summary and funnel RPCs', async () => {
    renderPage()
    await screen.findByText(i18n.t('platform.sales.dashboard.suppressed'))

    const fromInput = screen.getByLabelText(i18n.t('reports.dateFrom'))
    fireEvent.change(fromInput, { target: { value: '2026-09-01' } })
    const toInput = screen.getByLabelText(i18n.t('reports.dateTo'))
    fireEvent.change(toInput, { target: { value: '2026-09-21' } })

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('get_sales_dashboard_summary', { p_start_date: '2026-09-01', p_end_date: '2026-09-21' })
      expect(mockRpc).toHaveBeenCalledWith('get_sales_funnel_stats', { p_start_date: '2026-09-01', p_end_date: '2026-09-21' })
    })
  })

  it('renders the by-dimension breakdown (previously unreachable from any UI) with an export button', async () => {
    renderPage()

    expect(await screen.findByText('EG')).toBeInTheDocument()
    expect(screen.getByText('SA')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: i18n.t('platform.sales.dashboard.exportCsv') })).toBeInTheDocument()
  })
})
