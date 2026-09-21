import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { SalesCampaignsPage } from './SalesCampaignsPage'

// CAMP-1 (owner brief, 2026-09-21): a campaign could be created but had
// no way to ever add a lead -- the backend RPC
// (sales_add_leads_to_campaign) worked correctly and always had, but no
// frontend component called it, so every campaign's target_count was
// permanently stuck at 0. This locks in the "Manage leads" dialog fix
// (search, select, add) and the previously-orphaned `lost` stat field
// (computed by get_campaign_stats(), translated in i18n, never
// rendered).

const mockRpc = vi.fn()
const mockFrom = vi.fn()

const CAMPAIGN = { id: 'camp-1', name: 'Test Campaign', description: 'A test campaign', status: 'active', created_at: new Date().toISOString() }

const CAMPAIGN_STATS = { target_count: 3, queued: 1, contacted: 2, replied: 1, demos: 0, won: 0, lost: 1 }

const CANDIDATE_LEADS = [
  { lead_id: 'lead-a', business_name: 'Alpha Arena', city: 'Cairo', country: 'EG', status: 'discovered', current_score: 40 },
  { lead_id: 'lead-b', business_name: 'Beta Fields', city: 'Giza', country: 'EG', status: 'qualified', current_score: 55 },
]

vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}))

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SalesCampaignsPage />
    </QueryClientProvider>,
  )
}

describe('SalesCampaignsPage — CAMP-1', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    mockFrom.mockReset()
    await i18n.changeLanguage('en')

    mockFrom.mockImplementation((table: string) => {
      if (table === 'sales_campaigns') {
        return {
          select: () => ({
            order: () => Promise.resolve({ data: [CAMPAIGN], error: null }),
          }),
        }
      }
      return { select: () => Promise.resolve({ data: [], error: null }) }
    })

    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_campaign_stats') return Promise.resolve({ data: [CAMPAIGN_STATS], error: null })
      if (fnName === 'search_sales_leads') return Promise.resolve({ data: CANDIDATE_LEADS, error: null })
      if (fnName === 'sales_add_leads_to_campaign') return Promise.resolve({ data: 1, error: null })
      return Promise.resolve({ data: null, error: null })
    })
  })

  it('renders every campaign stat including the previously-orphaned "lost" field', async () => {
    renderPage()

    expect(await screen.findByText(`${i18n.t('platform.sales.campaigns.stats.target')}: 3`)).toBeInTheDocument()
    expect(screen.getByText(`${i18n.t('platform.sales.campaigns.stats.lost')}: 1`)).toBeInTheDocument()
  })

  it('lets a Platform Owner search for a lead and add it to the campaign', async () => {
    renderPage()

    const manageButton = await screen.findByRole('button', { name: i18n.t('platform.sales.campaigns.manageLeads') })
    fireEvent.click(manageButton)

    expect(await screen.findByText('Alpha Arena')).toBeInTheDocument()
    expect(screen.getByText('Beta Fields')).toBeInTheDocument()

    const checkbox = screen.getAllByRole('checkbox')[0]!
    fireEvent.click(checkbox)

    const addButton = screen.getByRole('button', { name: i18n.t('platform.sales.campaigns.addSelectedLeads', { count: 1 }) })
    expect(addButton).toBeEnabled()
    fireEvent.click(addButton)

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('sales_add_leads_to_campaign', { p_campaign_id: 'camp-1', p_lead_ids: ['lead-a'] })
    })
  })

  it('disables the add button until at least one lead is selected', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: i18n.t('platform.sales.campaigns.manageLeads') }))
    await screen.findByText('Alpha Arena')

    const addButton = screen.getByRole('button', { name: i18n.t('platform.sales.campaigns.addSelectedLeads', { count: 0 }) })
    expect(addButton).toBeDisabled()
  })
})
