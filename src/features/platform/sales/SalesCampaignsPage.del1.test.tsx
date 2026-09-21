import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { SalesCampaignsPage } from './SalesCampaignsPage'

// DEL-1 (owner brief, 2026-09-21): sales_campaigns had a real, live,
// currently-exploitable gap -- its RLS policy was `for all` and
// `authenticated` genuinely held raw DELETE/TRUNCATE table grants
// (confirmed via information_schema.role_table_grants against
// production before writing the fix), meaning any staffer with
// platform.sales.manage_campaigns could delete a campaign directly with
// zero audit trail, cascading to silently wipe its lead membership.
// Fixed at the RLS/grant layer (no more DELETE policy or grant) plus
// new, guarded, audited sales_archive_campaign/sales_restore_campaign
// RPCs, gated by a dedicated platform.sales.archive permission
// (mirroring platform.role.delete's own precedent). This locks in the
// UI: an active campaign shows an Archive button; an archived one shows
// a badge and a Restore button instead.

const mockRpc = vi.fn()
const mockFrom = vi.fn()

const ACTIVE_CAMPAIGN = { id: 'camp-1', name: 'Active Campaign', description: 'test', status: 'active', created_at: new Date().toISOString() }
const ARCHIVED_CAMPAIGN = { id: 'camp-2', name: 'Archived Campaign', description: 'test', status: 'archived', created_at: new Date().toISOString() }

const STATS = { target_count: 2, queued: 0, contacted: 1, replied: 0, demos: 0, won: 0, lost: 0 }

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

describe('SalesCampaignsPage — DEL-1: archive/restore', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    mockFrom.mockReset()
    await i18n.changeLanguage('en')

    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_campaign_stats') return Promise.resolve({ data: [STATS], error: null })
      if (fnName === 'sales_archive_campaign') return Promise.resolve({ data: null, error: null })
      if (fnName === 'sales_restore_campaign') return Promise.resolve({ data: null, error: null })
      return Promise.resolve({ data: null, error: null })
    })
  })

  it('shows an Archive button for an active campaign and calls sales_archive_campaign when clicked', async () => {
    mockFrom.mockImplementation(() => ({
      select: () => ({ order: () => Promise.resolve({ data: [ACTIVE_CAMPAIGN], error: null }) }),
    }))
    renderPage()

    const archiveButton = await screen.findByRole('button', { name: i18n.t('platform.sales.campaigns.archiveButton') })
    fireEvent.click(archiveButton)

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('sales_archive_campaign', { p_campaign_id: 'camp-1' })
    })

    // No restore button and no archived badge for an active campaign.
    expect(screen.queryByRole('button', { name: i18n.t('platform.sales.campaigns.restoreButton') })).not.toBeInTheDocument()
    expect(screen.queryByText(i18n.t('platform.sales.campaigns.statusArchived'))).not.toBeInTheDocument()
  })

  it('shows the Archived badge and a Restore button for an archived campaign, and calls sales_restore_campaign when clicked', async () => {
    mockFrom.mockImplementation(() => ({
      select: () => ({ order: () => Promise.resolve({ data: [ARCHIVED_CAMPAIGN], error: null }) }),
    }))
    renderPage()

    expect(await screen.findByText(i18n.t('platform.sales.campaigns.statusArchived'))).toBeInTheDocument()

    const restoreButton = screen.getByRole('button', { name: i18n.t('platform.sales.campaigns.restoreButton') })
    fireEvent.click(restoreButton)

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('sales_restore_campaign', { p_campaign_id: 'camp-2' })
    })

    // No archive button for an already-archived campaign.
    expect(screen.queryByRole('button', { name: i18n.t('platform.sales.campaigns.archiveButton') })).not.toBeInTheDocument()
  })
})
