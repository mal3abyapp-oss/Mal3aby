import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { DirectionProvider } from '@/app/providers/DirectionProvider'
import { SalesLeadDetailPage } from './SalesLeadDetailPage'

// AUD-1 (owner brief, 2026-09-21): sales_lead_activities.detail was
// already written and already fetched into this page's profile query,
// but the Activity card only ever rendered the bare activity_type
// string -- every actual piece of evidence (why a lead was lost, which
// email address an invite went to, which fields were edited) was
// silently discarded. This locks in the fix: a translated activity-type
// label plus a one-line summary derived from `detail`, matching the
// same pattern the Status History card already used for its own
// `reason` line.

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

function profileWithActivities(lead: ReturnType<typeof baseLead>, activities: Array<Record<string, unknown>>) {
  return {
    lead,
    signals: [],
    latest_score: null,
    notes: [],
    activities,
    outreach_messages: [],
    followups: [],
    status_history: [],
    possible_duplicates: [],
    demo_events: [],
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

function mockCommonRpcs(profile: ReturnType<typeof profileWithActivities>) {
  mockRpc.mockImplementation((fnName: string) => {
    if (fnName === 'get_lead_full_profile') return Promise.resolve({ data: profile, error: null })
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
    if (fnName === 'get_lead_outreach_events') return Promise.resolve({ data: [], error: null })
    if (fnName === 'get_platform_whatsapp_sender_identity') return Promise.resolve({ data: null, error: null })
    return Promise.resolve({ data: null, error: null })
  })
}

describe('SalesLeadDetailPage — AUD-1: activity detail summaries', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    await i18n.changeLanguage('en')
  })

  it('shows a translated activity type label and a reason line for a status change', async () => {
    const profile = profileWithActivities(baseLead(), [
      { id: 'act-1', activity_type: 'status_changed', detail: { reason: 'no longer interested' }, created_at: new Date().toISOString() },
    ])
    mockCommonRpcs(profile)
    renderPage()

    expect(await screen.findByText(i18n.t('platform.sales.leadProfile.activityType.status_changed'))).toBeInTheDocument()
    expect(screen.getByText('no longer interested')).toBeInTheDocument()
  })

  it('shows the invited owner email for an activation invite activity', async () => {
    const profile = profileWithActivities(baseLead(), [
      { id: 'act-2', activity_type: 'activation_invite_created', detail: { owner_email: 'owner@example.com' }, created_at: new Date().toISOString() },
    ])
    mockCommonRpcs(profile)
    renderPage()

    expect(await screen.findByText(i18n.t('platform.sales.leadProfile.activityType.activation_invite_created'))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('platform.sales.leadProfile.activityDetail.ownerEmail', { email: 'owner@example.com' }))).toBeInTheDocument()
  })

  it('lists which fields changed for a contact-details edit', async () => {
    const profile = profileWithActivities(baseLead(), [
      {
        id: 'act-3',
        activity_type: 'contact_details_edited',
        detail: { business_name_changed: false, phone_changed: true, email_changed: true, website_changed: false, location_changed: false },
        created_at: new Date().toISOString(),
      },
    ])
    mockCommonRpcs(profile)
    renderPage()

    expect(await screen.findByText(i18n.t('platform.sales.leadProfile.activityType.contact_details_edited'))).toBeInTheDocument()
    const expectedFields = [
      i18n.t('platform.sales.leadProfile.activityDetail.field.phone_changed'),
      i18n.t('platform.sales.leadProfile.activityDetail.field.email_changed'),
    ].join(i18n.t('platform.sales.leadProfile.activityDetail.listSeparator'))
    expect(screen.getByText(expectedFields)).toBeInTheDocument()
  })

  it('falls back to the raw activity_type label with no detail line when nothing is recognized', async () => {
    const profile = profileWithActivities(baseLead(), [
      { id: 'act-4', activity_type: 'scored', detail: { score: 62, band: 'warm' }, created_at: new Date().toISOString() },
    ])
    mockCommonRpcs(profile)
    renderPage()

    expect(await screen.findByText(i18n.t('platform.sales.leadProfile.activityType.scored'))).toBeInTheDocument()
  })
})
