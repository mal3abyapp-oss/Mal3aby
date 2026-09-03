import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { StaffPage } from './StaffPage'

// Production audit finding H-3 -- regression test. StaffPage.tsx's
// "Deactivate" action used to call deactivate_staff_member() directly on
// click with zero confirmation step. This locks in the reveal-then-confirm
// fix: clicking "Deactivate" must NOT call the RPC by itself -- it must
// only reveal a confirm step, and the RPC must fire only once the explicit
// confirm button is clicked.

const mockAuth = { currentClubId: 'club-1' }
vi.mock('@/app/providers/AuthProvider', () => ({
  useAuth: () => mockAuth,
}))

const mockRpc = vi.fn()
const mockFrom = vi.fn()

const ACTIVE_STAFF_ROW = {
  id: 'membership-1',
  user_id: 'user-1',
  status: 'active',
  has_cash_custody: false,
  roles: { key: 'receptionist', name_ar: 'موظف استقبال' },
  club_roles: null,
  membership_branches: [],
}

function makeFromMock() {
  return (table: string) => {
    if (table === 'club_memberships') {
      return {
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: [ACTIVE_STAFF_ROW], error: null }),
          }),
        }),
      }
    }
    if (table === 'profiles') {
      return {
        select: () => ({
          in: () => Promise.resolve({ data: [{ user_id: 'user-1', full_name: 'Test Employee' }], error: null }),
        }),
      }
    }
    if (table === 'employee_cash_liabilities') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: [], error: null }),
            }),
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
        <StaffPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('StaffPage — deactivate reveal-then-confirm (finding H-3)', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    mockFrom.mockReset()
    mockFrom.mockImplementation(makeFromMock())
    // i18n/config.ts (PERF-03 lazy-load fix): changeLanguage('en') now
    // has to actually fetch the 'en' resource chunk the first time, so
    // this must be awaited -- this test's own i18n.t('staff.deactivate')
    // / i18n.t('staff.confirmDeactivate') calls (used to build the
    // expected button names to search for) run synchronously right
    // after, and would otherwise evaluate against a not-yet-loaded
    // English bundle.
    await i18n.changeLanguage('en')
  })

  it('does NOT call deactivate_staff_member on the first click -- only reveals a confirm step', async () => {
    renderPage()

    const deactivateButton = await screen.findByRole('button', { name: i18n.t('staff.deactivate') })
    fireEvent.click(deactivateButton)

    // The RPC must not have fired from this single click.
    expect(mockRpc).not.toHaveBeenCalledWith('deactivate_staff_member', expect.anything())

    // A confirm step must now be visible.
    expect(await screen.findByRole('button', { name: i18n.t('staff.confirmDeactivate') })).toBeInTheDocument()
  })

  it('only calls deactivate_staff_member once the confirm button is clicked', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null })
    renderPage()

    const deactivateButton = await screen.findByRole('button', { name: i18n.t('staff.deactivate') })
    fireEvent.click(deactivateButton)

    const confirmButton = await screen.findByRole('button', { name: i18n.t('staff.confirmDeactivate') })
    fireEvent.click(confirmButton)

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('deactivate_staff_member', { p_membership_id: 'membership-1' }),
    )
  })

  it('cancelling the confirm step never calls the RPC', async () => {
    renderPage()

    const deactivateButton = await screen.findByRole('button', { name: i18n.t('staff.deactivate') })
    fireEvent.click(deactivateButton)

    const cancelButton = await screen.findByRole('button', { name: i18n.t('common.cancel') })
    fireEvent.click(cancelButton)

    // Back to the original "Deactivate" trigger, confirm step gone.
    expect(await screen.findByRole('button', { name: i18n.t('staff.deactivate') })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: i18n.t('staff.confirmDeactivate') })).not.toBeInTheDocument()
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
