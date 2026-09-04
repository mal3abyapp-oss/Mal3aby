import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { DirectionProvider } from '@/app/providers/DirectionProvider'
import { SalesLeadDetailPage } from './SalesLeadDetailPage'

// Multi-channel outreach readiness mission (2026-09-04): regression lock
// for the Channel Eligibility card, Call Tasks section, and Delivery &
// Reply Events timeline added to the lead profile page. Verifies: (1)
// WhatsApp is always shown as NOT eligible with its structural reason
// (never silently omitted, never shown as eligible), (2) the
// "Create Call Task" action only appears when call_task_eligible is
// true, (3) the recommended channel + reason renders, (4) reply/delivery
// events render with their translated label and any reply excerpt.

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
    status: 'contact_ready',
    current_score: 62,
    current_score_band: 'warm',
    converted_club_id: null,
    converted_at: null,
    business_name_ar: null,
    ...overrides,
  }
}

function profileFor(lead: ReturnType<typeof baseLead>) {
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
    activation_invite: null,
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

describe('SalesLeadDetailPage — channel eligibility, call tasks, outreach events', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    await i18n.changeLanguage('en')
  })

  it('shows email eligible, WhatsApp always not-eligible with its structural reason, and the recommended channel', async () => {
    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_lead_full_profile') return Promise.resolve({ data: profileFor(baseLead()), error: null })
      if (fnName === 'get_lead_channel_eligibility') {
        return Promise.resolve({
          data: [{
            lead_id: 'lead-1',
            email_eligible: true,
            email_reason: 'verified public_email on file',
            whatsapp_eligible: false,
            whatsapp_reason: 'WhatsApp connector is club-scoped -- a sales lead is not yet a club',
            call_task_eligible: true,
            call_task_reason: 'verified public_phone on file',
            recommended_channel: 'EMAIL',
            recommended_reason: 'email is the only channel with an automated, approval-gated send pipeline',
          }],
          error: null,
        })
      }
      if (fnName === 'get_lead_call_tasks') return Promise.resolve({ data: [], error: null })
      if (fnName === 'get_lead_outreach_events') return Promise.resolve({ data: [], error: null })
      return Promise.resolve({ data: null, error: null })
    })
    renderPage()

    await screen.findByText(i18n.t('platform.sales.leadProfile.channels'))

    // WhatsApp always rendered as NOT eligible, with the real structural reason visible.
    expect(screen.getByText(/WhatsApp connector is club-scoped/)).toBeInTheDocument()
    const notEligibleLabels = screen.getAllByText(i18n.t('platform.sales.leadProfile.channelNotEligible'))
    expect(notEligibleLabels.length).toBeGreaterThan(0)

    // Email shown eligible.
    expect(screen.getAllByText(i18n.t('platform.sales.leadProfile.channelEligible')).length).toBeGreaterThan(0)

    // Recommended channel + reason rendered.
    expect(screen.getByText(/EMAIL/)).toBeInTheDocument()
    expect(screen.getByText(/automated, approval-gated send pipeline/)).toBeInTheDocument()

    // Create Call Task button appears since call_task_eligible is true.
    expect(screen.getByRole('button', { name: i18n.t('platform.sales.leadProfile.createCallTaskButton') })).toBeInTheDocument()
  })

  it('creates a call task via sales_create_call_task when the button is clicked', async () => {
    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_lead_full_profile') return Promise.resolve({ data: profileFor(baseLead()), error: null })
      if (fnName === 'get_lead_channel_eligibility') {
        return Promise.resolve({
          data: [{
            lead_id: 'lead-1', email_eligible: false, email_reason: 'no public_email on file',
            whatsapp_eligible: false, whatsapp_reason: 'structural', call_task_eligible: true,
            call_task_reason: 'has phone', recommended_channel: 'CALL_TASK', recommended_reason: 'phone only',
          }],
          error: null,
        })
      }
      if (fnName === 'get_lead_call_tasks') return Promise.resolve({ data: [], error: null })
      if (fnName === 'get_lead_outreach_events') return Promise.resolve({ data: [], error: null })
      if (fnName === 'sales_create_call_task') return Promise.resolve({ data: 'task-1', error: null })
      return Promise.resolve({ data: null, error: null })
    })
    renderPage()

    const createButton = await screen.findByRole('button', { name: i18n.t('platform.sales.leadProfile.createCallTaskButton') })
    fireEvent.click(createButton)

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('sales_create_call_task', expect.objectContaining({ p_lead_id: 'lead-1' }))
    })
  })

  it('never shows Create Call Task when call_task_eligible is false (no phone on file)', async () => {
    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_lead_full_profile') return Promise.resolve({ data: profileFor(baseLead({ public_phone: null, public_email: null })), error: null })
      if (fnName === 'get_lead_channel_eligibility') {
        return Promise.resolve({
          data: [{
            lead_id: 'lead-1', email_eligible: false, email_reason: 'no email', whatsapp_eligible: false,
            whatsapp_reason: 'structural', call_task_eligible: false, call_task_reason: 'no phone on file',
            recommended_channel: 'NO_SAFE_CHANNEL', recommended_reason: 'no verified contact channel',
          }],
          error: null,
        })
      }
      if (fnName === 'get_lead_call_tasks') return Promise.resolve({ data: [], error: null })
      if (fnName === 'get_lead_outreach_events') return Promise.resolve({ data: [], error: null })
      return Promise.resolve({ data: null, error: null })
    })
    renderPage()

    await screen.findByText(i18n.t('platform.sales.leadProfile.channels'))
    expect(screen.queryByRole('button', { name: i18n.t('platform.sales.leadProfile.createCallTaskButton') })).not.toBeInTheDocument()
    expect(screen.getByText(/NO_SAFE_CHANNEL/)).toBeInTheDocument()
  })

  it('renders reply/delivery events with translated labels and reply excerpts', async () => {
    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_lead_full_profile') return Promise.resolve({ data: profileFor(baseLead()), error: null })
      if (fnName === 'get_lead_channel_eligibility') {
        return Promise.resolve({
          data: [{
            lead_id: 'lead-1', email_eligible: true, email_reason: 'ok', whatsapp_eligible: false,
            whatsapp_reason: 'structural', call_task_eligible: true, call_task_reason: 'ok',
            recommended_channel: 'EMAIL', recommended_reason: 'ok',
          }],
          error: null,
        })
      }
      if (fnName === 'get_lead_call_tasks') return Promise.resolve({ data: [], error: null })
      if (fnName === 'get_lead_outreach_events') {
        return Promise.resolve({
          data: [
            {
              id: 'evt-1', message_id: 'msg-1', event_type: 'delivered', is_reply: false,
              reply_excerpt: null, created_at: new Date().toISOString(), message_channel: 'email', message_subject: 'Hello',
            },
            {
              id: 'evt-2', message_id: 'msg-1', event_type: 'requested_information', is_reply: true,
              reply_excerpt: 'Subject: Re: Hello\n\nCan you send more details?', created_at: new Date().toISOString(),
              message_channel: 'email', message_subject: 'Hello',
            },
          ],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    })
    renderPage()

    await screen.findByText(i18n.t('platform.sales.leadProfile.events'))
    expect(screen.getByText(new RegExp(i18n.t('platform.sales.leadProfile.eventTypeLabels.delivered')))).toBeInTheDocument()
    expect(screen.getByText(new RegExp(i18n.t('platform.sales.leadProfile.eventTypeLabels.requested_information')))).toBeInTheDocument()
    expect(screen.getByText(/Can you send more details\?/)).toBeInTheDocument()
  })
})
