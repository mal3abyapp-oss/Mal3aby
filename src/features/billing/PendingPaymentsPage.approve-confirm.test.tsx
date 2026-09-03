import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { PendingPaymentsPage } from './PendingPaymentsPage'

// Production audit finding H-3 -- regression test. PendingPaymentsPage's
// "Approve" action used to call approve_payment_proof() directly on click
// with zero confirmation, even though the RPC creates a real payment
// record (approve_payment_proof() -> record_payment()) and the adjacent
// "Reject" action on the same screen was already correctly gated behind
// a Dialog. This locks in the full confirm-dialog fix: clicking "Approve"
// must NOT call the RPC by itself -- it must only open a confirm dialog,
// and the RPC must fire only once the dialog's own confirm button is
// clicked.

const mockAuth = { currentClubId: 'club-1' }
vi.mock('@/app/providers/AuthProvider', () => ({
  useAuth: () => mockAuth,
}))
vi.mock('@/app/providers/DirectionProvider', () => ({
  useDirection: () => ({ locale: 'en', direction: 'ltr' as const }),
}))

const mockRpc = vi.fn()
const mockFrom = vi.fn()

const PENDING_PROOF_ROW = {
  id: 'proof-1',
  booking_id: 'booking-1',
  invoice_id: 'invoice-1',
  amount: 250,
  storage_path: 'club-1/proof-1.png',
  mime_type: 'image/png',
  status: 'pending_review',
  rejection_reason: null,
  uploaded_at: '2026-08-30T10:00:00Z',
  bookings: {
    start_at: '2026-08-31T10:00:00Z',
    field_id: 'field-1',
    fields: { name: 'Field A' },
    customers: { full_name: 'Test Customer' },
  },
}

function makeFromMock() {
  return (table: string) => {
    if (table === 'payment_proofs') {
      return {
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: [PENDING_PROOF_ROW], error: null }),
          }),
        }),
      }
    }
    throw new Error(`unexpected table in test: ${table}`)
  }
}

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
      <MemoryRouter>
        <PendingPaymentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('PendingPaymentsPage — approve confirm dialog (finding H-3)', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    mockFrom.mockReset()
    mockFrom.mockImplementation(makeFromMock())
    // i18n/config.ts (PERF-03 lazy-load fix): changeLanguage('en') now
    // has to actually fetch the 'en' resource chunk the first time, so
    // this must be awaited -- this test's own i18n.t(...) calls (used to
    // build expected button names to search for) run synchronously
    // right after, and would otherwise evaluate against a not-yet-loaded
    // English bundle.
    await i18n.changeLanguage('en')
  })

  it('does NOT call approve_payment_proof on the first click -- only opens a confirm dialog', async () => {
    renderPage()

    const approveButton = await screen.findByRole('button', { name: i18n.t('billing.pendingPayments.approve') })
    fireEvent.click(approveButton)

    // The RPC must not have fired from this single click.
    expect(mockRpc).not.toHaveBeenCalledWith('approve_payment_proof', expect.anything())

    // The confirm dialog must now be open, showing the dialog's own confirm control.
    expect(await screen.findByTestId('approve-payment-confirm')).toBeInTheDocument()
  })

  it('only calls approve_payment_proof once the dialog confirm button is clicked', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null })
    renderPage()

    const approveButton = await screen.findByRole('button', { name: i18n.t('billing.pendingPayments.approve') })
    fireEvent.click(approveButton)

    const confirmButton = await screen.findByTestId('approve-payment-confirm')
    fireEvent.click(confirmButton)

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('approve_payment_proof', { p_proof_id: 'proof-1' }),
    )
  })

  it('dismissing the dialog without confirming never calls the RPC', async () => {
    renderPage()

    const approveButton = await screen.findByRole('button', { name: i18n.t('billing.pendingPayments.approve') })
    fireEvent.click(approveButton)

    expect(await screen.findByTestId('approve-payment-confirm')).toBeInTheDocument()
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
