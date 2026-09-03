import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { SalesLeadDetailPage } from './SalesLeadDetailPage'

// ADR-054 regression test: "Convert to Tenant" (Phase 14) is a
// deliberate TRUE STOP -- complete_new_club_onboarding() is
// auth.uid()-coupled with no path to create a tenant owned by a
// different, not-currently-authenticated prospect, so no
// convert_sales_lead_to_tenant() RPC exists yet. This locks in that the
// UI never lets a platform owner click a button that would either fail
// unexpectedly or (worse) silently succeed with the wrong owner: the
// button must render disabled with the CONFIGURATION_BLOCKED
// explanation, for a lead that has NOT yet been converted.

const mockRpc = vi.fn()

const UNCONVERTED_LEAD_PROFILE = {
  lead: {
    id: 'lead-1',
    business_name: 'Test Sports Arena',
    business_type: 'football_field',
    country: 'EG',
    city: 'Cairo',
    area: null,
    address: null,
    website: 'https://example.com',
    public_phone: '+201001234567',
    public_email: 'info@example.com',
    whatsapp_public_number: null,
    rating: 4.5,
    review_count: 120,
    status: 'qualified',
    current_score: 62,
    current_score_band: 'warm',
    converted_club_id: null,
    converted_at: null,
  },
  signals: [],
  latest_score: null,
  notes: [],
  activities: [],
  outreach_messages: [],
  followups: [],
  status_history: [],
  possible_duplicates: [],
}

vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}))

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/platform/sales/leads/lead-1']}>
        <Routes>
          <Route path="/platform/sales/leads/:leadId" element={<SalesLeadDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SalesLeadDetailPage — Convert to Tenant stays blocked (ADR-054 TRUE STOP)', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_lead_full_profile') {
        return Promise.resolve({ data: UNCONVERTED_LEAD_PROFILE, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })
    await i18n.changeLanguage('en')
  })

  it('renders the Convert to Tenant button disabled with a CONFIGURATION_BLOCKED explanation', async () => {
    renderPage()

    const convertButton = await screen.findByRole('button', { name: i18n.t('platform.sales.leadProfile.convertButton') })
    expect(convertButton).toBeDisabled()

    // The explanation must actually be visible text, not just a title attribute
    // a screen reader/visual scan could miss.
    expect(screen.getByText(i18n.t('platform.sales.leadProfile.convertBlocked'))).toBeInTheDocument()

    // No conversion RPC of any name was ever called -- confirms this isn't just
    // a disabled button masking a live click handler underneath.
    expect(mockRpc).not.toHaveBeenCalledWith(expect.stringContaining('convert'), expect.anything())
  })

  it('never renders an enabled convert action for an unconverted lead regardless of score/status', async () => {
    renderPage()
    const convertButton = await screen.findByRole('button', { name: i18n.t('platform.sales.leadProfile.convertButton') })
    // Structural guarantee: disabled is a real HTML attribute here, not a CSS-only visual state.
    expect(convertButton).toHaveAttribute('disabled')
  })
})
