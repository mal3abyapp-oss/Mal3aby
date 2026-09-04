import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { DirectionProvider } from '@/app/providers/DirectionProvider'
import { SalesLeadDetailPage } from './SalesLeadDetailPage'

// ADR-054 Phase 14 regression: the TRUE STOP is resolved (invite-based
// owner activation) -- "Convert to Tenant" now sends a secure activation
// invite to the prospect's own email rather than being permanently
// disabled, and NEVER calls any RPC that would make the platform owner
// the tenant's owner. These tests lock in: (1) the invite-send action is
// available for a live, unconverted lead, (2) a lead in a terminal
// non-convertible state (won/lost/do_not_contact) shows an explanatory
// message instead of an enabled action, (3) an awaiting-activation lead
// shows status + Resend, never a raw "create tenant" control, (4) a
// tenant_activated lead shows the real club link.

const mockRpc = vi.fn()

function baseLead(overrides: Partial<Record<string, unknown>> = {}) {
  return {
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
    business_name_ar: null,
    ...overrides,
  }
}

function profileFor(lead: ReturnType<typeof baseLead>, activationInvite: unknown = null) {
  return {
    lead,
    signals: [],
    latest_score: null,
    notes: [],
    activities: [],
    outreach_messages: [],
    followups: [],
    status_history: [],
    possible_duplicates: [],
    activation_invite: activationInvite,
  }
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
      <DirectionProvider>
        <MemoryRouter initialEntries={['/platform/sales/leads/lead-1']}>
          <Routes>
            <Route path="/platform/sales/leads/:leadId" element={<SalesLeadDetailPage />} />
          </Routes>
        </MemoryRouter>
      </DirectionProvider>
    </QueryClientProvider>,
  )
}

describe('SalesLeadDetailPage — Phase 14 invite-based owner activation', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    await i18n.changeLanguage('en')
  })

  it('offers to send an activation invite for a live, unconverted lead -- never an enabled direct-create action', async () => {
    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_lead_full_profile') return Promise.resolve({ data: profileFor(baseLead()), error: null })
      return Promise.resolve({ data: null, error: null })
    })
    renderPage()

    const sendButton = await screen.findByRole('button', { name: i18n.t('platform.sales.leadProfile.convertSendInviteButton') })
    expect(sendButton).toBeDisabled() // no owner email entered yet

    const emailInput = screen.getByLabelText(i18n.t('platform.sales.leadProfile.convertOwnerEmailLabel'))
    fireEvent.change(emailInput, { target: { value: 'owner@example.com' } })
    expect(sendButton).not.toBeDisabled()

    fireEvent.click(sendButton)
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('sales_win_lead_and_invite_owner', expect.objectContaining({ p_lead_id: 'lead-1', p_owner_email: 'owner@example.com' }))
    })

    // Never any RPC that would create/link a tenant directly from this page.
    expect(mockRpc).not.toHaveBeenCalledWith('complete_new_club_onboarding', expect.anything())
    expect(mockRpc).not.toHaveBeenCalledWith('claim_sales_activation_invite', expect.anything())
  })

  it('shows a blocked explanation (no action) for a terminal won/lost/do_not_contact lead', async () => {
    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_lead_full_profile') return Promise.resolve({ data: profileFor(baseLead({ status: 'lost' })), error: null })
      return Promise.resolve({ data: null, error: null })
    })
    renderPage()

    expect(await screen.findByText(i18n.t('platform.sales.leadProfile.convertBlocked'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: i18n.t('platform.sales.leadProfile.convertSendInviteButton') })).not.toBeInTheDocument()
  })

  it('shows invite status + Resend for a lead awaiting owner activation, never a raw create-tenant control', async () => {
    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_lead_full_profile') {
        return Promise.resolve({
          data: profileFor(
            baseLead({ status: 'awaiting_owner_activation' }),
            { status: 'pending', owner_email: 'owner@example.com', expires_at: new Date(Date.now() + 86400000).toISOString(), created_at: new Date().toISOString(), consumed_at: null },
          ),
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    })
    renderPage()

    expect(await screen.findByText(i18n.t('platform.sales.leadProfile.statusAwaitingActivation'))).toBeInTheDocument()
    const resendButton = screen.getByRole('button', { name: i18n.t('platform.sales.leadProfile.resendInviteButton') })
    fireEvent.click(resendButton)
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('resend_sales_activation_invite', { p_lead_id: 'lead-1' })
    })
    expect(screen.queryByRole('button', { name: i18n.t('platform.sales.leadProfile.convertSendInviteButton') })).not.toBeInTheDocument()
  })

  it('shows the real club link for a tenant_activated lead', async () => {
    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_lead_full_profile') {
        return Promise.resolve({
          data: profileFor(baseLead({ status: 'tenant_activated', converted_club_id: 'club-123', converted_at: new Date().toISOString() })),
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    })
    renderPage()

    expect(await screen.findByText(i18n.t('platform.sales.leadProfile.statusTenantActivated'))).toBeInTheDocument()
    const link = screen.getByRole('link', { name: i18n.t('platform.sales.leadProfile.viewClubLink') })
    expect(link).toHaveAttribute('href', '/platform/clubs/club-123')
  })
})
