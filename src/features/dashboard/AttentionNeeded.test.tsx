import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AttentionNeeded } from './AttentionNeeded'

// FINDING B-1 REGRESSION TEST (frozen production audit): AttentionNeeded
// used to destructure only `data: items = [], isLoading` from useQuery,
// with no isError/error handling anywhere. A genuinely FAILED fetch
// therefore defaulted `items` to [] and rendered byte-identical to
// "nothing needs attention right now" -- a false "all clear" success
// state that would have hidden unpaid bookings, expiring subscriptions,
// and pending payment proofs from a receptionist/manager with zero
// indication anything was wrong. This test mocks the underlying
// supabase queries to reject, and asserts the component renders an
// explicit error state (not the reassuring empty-state success copy).

const mockAuth = { currentClubId: 'club-1' }
vi.mock('@/app/providers/AuthProvider', () => ({
  useAuth: () => mockAuth,
}))

vi.mock('@/app/providers/DirectionProvider', () => ({
  useDirection: () => ({ locale: 'en', direction: 'ltr' as const }),
}))

// Chainable Supabase-like query builder whose terminal methods reject,
// simulating a real fetch failure (network error, RLS denial, etc.)
// rather than a Postgres error object resolved with { error }.
function makeRejectingQuery() {
  const err = new Error('network error')
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'gte', 'lte', 'in', 'order', 'limit']
  for (const m of methods) {
    chain[m] = vi.fn(() => chain)
  }
  chain.maybeSingle = vi.fn(() => Promise.reject(err))
  // The final method actually awaited by AttentionNeeded.tsx's Promise.all
  // is `.limit(...)` (and `.maybeSingle()` for the whatsapp diagnostics
  // query) -- both must be thenable/awaitable and reject.
  chain.then = (_resolve: unknown, reject: (e: unknown) => void) => Promise.reject(err).catch(reject)
  chain.limit = vi.fn(() => Promise.reject(err))
  return chain
}

const mockFrom = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}))

vi.mock('@/lib/domain/billing', () => ({
  fetchInvoicePaymentSummaries: vi.fn(() => Promise.resolve(new Map())),
}))

function renderWithProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AttentionNeeded />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('AttentionNeeded error handling (finding B-1)', () => {
  beforeEach(() => {
    mockFrom.mockReset()
    mockFrom.mockImplementation(() => makeRejectingQuery())
  })

  it('renders an explicit error state, not the "nothing needs attention" success copy, when the fetch fails', async () => {
    renderWithProviders()

    await waitFor(() => {
      expect(screen.queryByText(/nothing needs attention right now/i)).not.toBeInTheDocument()
    })

    // The error copy (or at minimum a retry affordance) must be present
    // -- this is the actual regression: before the fix, the component
    // returned early with the empty/success card and there was no error
    // branch to reach at all.
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('never renders the success-tone empty-state message on a failed fetch', async () => {
    renderWithProviders()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    })

    // Defense in depth: explicitly assert the exact reassuring copy a
    // real user would read as "you're all caught up" never appears.
    expect(screen.queryByText(/nothing needs attention right now/i)).not.toBeInTheDocument()
  })
})
