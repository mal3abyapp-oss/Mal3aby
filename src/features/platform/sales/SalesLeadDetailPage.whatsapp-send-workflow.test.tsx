import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { DirectionProvider } from '@/app/providers/DirectionProvider'
import { SalesLeadDetailPage } from './SalesLeadDetailPage'

// UX review finding, fixed (2026-09-12): the Edit/Approve/Send workflow
// for channel='whatsapp_message' drafts (owner decision #20) previously
// had ZERO component-level test coverage -- only the SQL/RPC layer was
// tested (sales-platform-whatsapp-send.structural.test.ts /
// .integration.test.ts), never the actual React component a real
// Platform Owner interacts with. This file closes that gap: it renders
// SalesLeadDetailPage exactly like the existing channel-eligibility and
// tenant-activation test files do, and exercises the real user-facing
// paths -- Edit saving edited_body, Send succeeding when Platform
// WhatsApp is connected, and Send being unavailable (with the
// actionable not-connected message) when it is not -- so a regression
// in any of these is caught by CI, not only discovered live in
// production the way the disconnect-race bug and the quality-gate
// signature-stripping bug both were.

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
    public_email: null,
    whatsapp_public_number: '+201001234567',
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

function whatsappDraft(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'msg-wa-1',
    channel: 'whatsapp_message',
    message_type: 'offer',
    language: 'ar',
    subject: null,
    body: 'AI original: أهلاً، شفنا إن ملعبكم محتاج نظام حجز أفضل. فريق ملعبي',
    edited_body: null,
    status: 'approved',
    quality_status: 'approval_ready',
    quality_gate_result: { rejection_reasons: [] },
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function profileWithMessages(lead: ReturnType<typeof baseLead>, messages: Array<Record<string, unknown>>) {
  return {
    lead,
    signals: [],
    latest_score: null,
    notes: [],
    activities: [],
    outreach_messages: messages,
    followups: [],
    status_history: [],
    possible_duplicates: [],
    demo_events: [],
    activation_invite: null,
  }
}

const eligibilityRow = {
  lead_id: 'lead-1', email_eligible: false, email_reason: 'no email on file', whatsapp_eligible: false,
  whatsapp_reason: 'structural', call_task_eligible: true, call_task_reason: 'ok',
  recommended_channel: 'CALL_TASK', recommended_reason: 'ok',
}

vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 'test-token' } } }) },
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

function mockCommonRpcs(profile: ReturnType<typeof profileWithMessages>, senderIdentity: Record<string, unknown> | null) {
  mockRpc.mockImplementation((fnName: string) => {
    if (fnName === 'get_lead_full_profile') return Promise.resolve({ data: profile, error: null })
    if (fnName === 'get_lead_channel_eligibility') return Promise.resolve({ data: [eligibilityRow], error: null })
    if (fnName === 'get_lead_call_tasks') return Promise.resolve({ data: [], error: null })
    if (fnName === 'get_lead_outreach_events') return Promise.resolve({ data: [], error: null })
    if (fnName === 'get_platform_whatsapp_sender_identity') return Promise.resolve({ data: senderIdentity, error: null })
    if (fnName === 'sales_queue_platform_whatsapp_message') return Promise.resolve({ data: 'queue-1', error: null })
    if (fnName === 'sales_edit_outreach_draft') return Promise.resolve({ data: null, error: null })
    return Promise.resolve({ data: null, error: null })
  })
}

describe('SalesLeadDetailPage — whatsapp_message Send workflow (Platform WhatsApp)', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    await i18n.changeLanguage('en')
  })

  it('shows the sender number and a working Send button when Platform WhatsApp is connected, and calls sales_queue_platform_whatsapp_message with the right message id', async () => {
    const profile = profileWithMessages(baseLead(), [whatsappDraft()])
    mockCommonRpcs(profile, { status: 'connected', connected_phone_number: '+201112223333' })
    renderPage()

    await screen.findByText(/فريق ملعبي|AI original/)

    // Sender identity shown before Send is pressed.
    expect(await screen.findByText(/\+201112223333/)).toBeInTheDocument()

    const sendButton = screen.getByRole('button', { name: i18n.t('platform.sales.leadProfile.outreachSendButton') })
    expect(sendButton).toBeEnabled()
    fireEvent.click(sendButton)

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('sales_queue_platform_whatsapp_message', { p_message_id: 'msg-wa-1' })
    })
  })

  it('does not show a Send button and shows the actionable not-connected message when Platform WhatsApp is disconnected', async () => {
    const profile = profileWithMessages(baseLead(), [whatsappDraft()])
    mockCommonRpcs(profile, { status: 'disconnected', connected_phone_number: null })
    renderPage()

    await screen.findByText(/فريق ملعبي|AI original/)

    expect(screen.queryByRole('button', { name: i18n.t('platform.sales.leadProfile.outreachSendButton') })).not.toBeInTheDocument()
    const notConnectedText: string = i18n.t('platform.sales.leadProfile.outreachWhatsappNotConnected', { status: 'disconnected' })
    expect(await screen.findByText(new RegExp(notConnectedText.split('(')[0] ?? notConnectedText))).toBeInTheDocument()
    expect(screen.getByRole('link', { name: i18n.t('platform.sales.leadProfile.outreachGoToWhatsappSettings') })).toHaveAttribute('href', '/platform/whatsapp')
  })

  it('does not offer Send at all when the draft is only generated (not yet approved), even if Platform WhatsApp is connected', async () => {
    const profile = profileWithMessages(baseLead(), [whatsappDraft({ status: 'generated' })])
    mockCommonRpcs(profile, { status: 'connected', connected_phone_number: '+201112223333' })
    renderPage()

    await screen.findByText(/فريق ملعبي|AI original/)
    expect(screen.queryByRole('button', { name: i18n.t('platform.sales.leadProfile.outreachSendButton') })).not.toBeInTheDocument()
    // Approve/Reject are the only actions available pre-approval.
    expect(screen.getByRole('button', { name: i18n.t('platform.sales.leadProfile.outreachApproveButton') })).toBeInTheDocument()
  })

  it('Edit dialog saves via the sales-edit-outreach-draft Edge Function (DRAFT-1: re-runs the quality gate on the edited text server-side)', async () => {
    const profile = profileWithMessages(baseLead(), [whatsappDraft()])
    mockCommonRpcs(profile, { status: 'connected', connected_phone_number: '+201112223333' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message_id: 'msg-wa-1', quality_status: 'approval_ready', quality_gate_result: {} }),
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    await screen.findByText(/فريق ملعبي|AI original/)

    const editButtons = screen.getAllByRole('button', { name: i18n.t('platform.sales.leadProfile.outreachEditButton') })
    fireEvent.click(editButtons[0]!)

    const textarea = await screen.findByLabelText(i18n.t('platform.sales.leadProfile.outreachEditBodyLabel'))
    fireEvent.change(textarea, { target: { value: 'نص معدَّل من صاحب المنصة' } })

    const saveButton = screen.getByRole('button', { name: i18n.t('platform.sales.leadProfile.outreachEditSave') })
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/functions/v1/sales-edit-outreach-draft'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ message_id: 'msg-wa-1', edited_body: 'نص معدَّل من صاحب المنصة' }),
        }),
      )
    })
    // The Edge Function call carries only message_id/edited_body -- the
    // AI-generated `body` column itself is never sent, confirming this
    // path still never attempts to overwrite the AI original (proven
    // separately, additively, at the SQL layer). Unlike the raw RPC
    // call this replaces, the Edge Function re-runs the commercial
    // quality gate against the edited text server-side before persisting
    // quality_status -- see sales-edit-outreach-draft/index.ts.
    vi.unstubAllGlobals()
  })

  it('shows a quality-rejected warning when the Edge Function reports the edit failed the commercial quality gate (DRAFT-1)', async () => {
    const profile = profileWithMessages(baseLead(), [whatsappDraft()])
    mockCommonRpcs(profile, { status: 'connected', connected_phone_number: '+201112223333' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message_id: 'msg-wa-1', quality_status: 'quality_rejected', quality_gate_result: { rejection_reasons: ['PLACEHOLDER_TEXT'] } }),
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPage()

    await screen.findByText(/فريق ملعبي|AI original/)

    const editButtons = screen.getAllByRole('button', { name: i18n.t('platform.sales.leadProfile.outreachEditButton') })
    fireEvent.click(editButtons[0]!)

    const textarea = await screen.findByLabelText(i18n.t('platform.sales.leadProfile.outreachEditBodyLabel'))
    fireEvent.change(textarea, { target: { value: '[placeholder]' } })
    fireEvent.click(screen.getByRole('button', { name: i18n.t('platform.sales.leadProfile.outreachEditSave') }))

    expect(await screen.findByText(i18n.t('platform.sales.leadProfile.outreachEditQualityRejected'))).toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it('shows the "Edited by owner" badge and the edited text (not the AI original) once a draft has edited_body set', async () => {
    const profile = profileWithMessages(baseLead(), [
      whatsappDraft({ edited_body: 'نص معدَّل يظهر بدلاً من نص الذكاء الاصطناعي الأصلي' }),
    ])
    mockCommonRpcs(profile, { status: 'connected', connected_phone_number: '+201112223333' })
    renderPage()

    expect(await screen.findByText(/نص معدَّل يظهر بدلاً من نص الذكاء الاصطناعي الأصلي/)).toBeInTheDocument()
    expect(screen.getByText(i18n.t('platform.sales.leadProfile.outreachEditedBadge'))).toBeInTheDocument()
  })

  it('does not disable a sibling approved whatsapp_message draft\'s Send button while a different draft is being sent', async () => {
    const profile = profileWithMessages(baseLead(), [
      whatsappDraft({ id: 'msg-wa-1', created_at: new Date(Date.now() - 1000).toISOString() }),
      whatsappDraft({ id: 'msg-wa-2', created_at: new Date().toISOString() }),
    ])
    mockCommonRpcs(profile, { status: 'connected', connected_phone_number: '+201112223333' })
    // Never resolve the queue RPC so the mutation stays "pending" long enough to assert on.
    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'get_lead_full_profile') return Promise.resolve({ data: profile, error: null })
      if (fnName === 'get_lead_channel_eligibility') return Promise.resolve({ data: [eligibilityRow], error: null })
      if (fnName === 'get_lead_call_tasks') return Promise.resolve({ data: [], error: null })
      if (fnName === 'get_lead_outreach_events') return Promise.resolve({ data: [], error: null })
      if (fnName === 'get_platform_whatsapp_sender_identity') return Promise.resolve({ data: { status: 'connected', connected_phone_number: '+201112223333' }, error: null })
      if (fnName === 'sales_queue_platform_whatsapp_message') return new Promise(() => {}) // never resolves
      return Promise.resolve({ data: null, error: null })
    })
    renderPage()

    await waitFor(() => expect(screen.getAllByText(/فريق ملعبي|AI original/).length).toBeGreaterThan(0))
    const sendButtons = screen.getAllByRole('button', { name: i18n.t('platform.sales.leadProfile.outreachSendButton') })
    expect(sendButtons).toHaveLength(2)

    fireEvent.click(sendButtons[0]!)

    await waitFor(() => {
      expect(screen.getByText(i18n.t('platform.sales.leadProfile.outreachSending'))).toBeInTheDocument()
    })
    // The OTHER row's Send button must remain enabled and unchanged --
    // this is the fix for the "shared mutation over-disables sibling
    // rows" finding.
    const remainingSendButton = screen.getByRole('button', { name: i18n.t('platform.sales.leadProfile.outreachSendButton') })
    expect(remainingSendButton).toBeEnabled()
  })
})
