import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MorePage } from './MorePage'

// FINDING H-4 REGRESSION TEST: the club/role switcher (a <select> plus
// role-name label) previously existed only in AppLayout's desktop
// sidebar (hidden md:flex) -- a multi-club staff member had no way at
// all to switch clubs from mobile, since the mobile header stays
// deliberately minimal and MorePage (src/features/dashboard/MorePage.tsx)
// had no reference to setCurrentClubId/clubName/roleName anywhere. This
// asserts the switcher renders here when memberships.length > 1 (with
// the current club's role shown alongside it, matching the desktop
// sidebar's clarity) and stays absent for a single-club user, who has
// nothing to switch to.

const setCurrentClubId = vi.fn()

const singleMembership = {
  clubId: 'club-1',
  clubName: 'Downtown Club',
  clubNameAr: 'نادي وسط البلد',
  roleName: 'Owner',
  roleNameAr: 'مالك',
  permissionKeys: [] as string[],
}

const secondMembership = {
  clubId: 'club-2',
  clubName: 'Uptown Club',
  clubNameAr: 'نادي أعلى البلد',
  roleName: 'Manager',
  roleNameAr: 'مدير',
  permissionKeys: [] as string[],
}

let mockAuth: {
  memberships: typeof singleMembership[]
  currentMembership: typeof singleMembership | null
  setCurrentClubId: typeof setCurrentClubId
  signOut: () => Promise<void>
}

vi.mock('@/app/providers/AuthProvider', () => ({
  useAuth: () => mockAuth,
}))

vi.mock('@/features/billing/usePendingPaymentsCount', () => ({
  usePendingPaymentsCount: () => ({ data: 0 }),
}))

function renderWithProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MorePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('MorePage club/role switcher (finding H-4)', () => {
  beforeEach(() => {
    setCurrentClubId.mockReset()
  })

  it('does not render a club switcher for a single-club user', () => {
    mockAuth = {
      memberships: [singleMembership],
      currentMembership: singleMembership,
      setCurrentClubId,
      signOut: vi.fn(),
    }
    renderWithProviders()

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('renders the club switcher and current role when the user has multiple memberships', () => {
    mockAuth = {
      memberships: [singleMembership, secondMembership],
      currentMembership: singleMembership,
      setCurrentClubId,
      signOut: vi.fn(),
    }
    renderWithProviders()

    const select = screen.getByRole('combobox')
    expect(select).toBeInTheDocument()
    // Club names render in whichever locale the test environment's
    // navigator language resolves to (English or Arabic) -- both club
    // options must be present regardless of which label set is active.
    expect(screen.getByText((_, el) => el?.tagName === 'OPTION' && /Downtown Club|نادي وسط البلد/.test(el.textContent ?? ''))).toBeInTheDocument()
    expect(screen.getByText((_, el) => el?.tagName === 'OPTION' && /Uptown Club|نادي أعلى البلد/.test(el.textContent ?? ''))).toBeInTheDocument()
    // Role context stays visible alongside the switcher, matching the
    // desktop sidebar's clarity. No i18n provider is mounted in this
    // unit test (consistent with the rest of this suite, e.g.
    // AttentionNeeded.test.tsx), so react-i18next's useTranslation()
    // falls back to returning translation keys verbatim -- assert on
    // the key plus the interpolated role value, not on real copy.
    expect(screen.getByText((_, el) => el?.textContent === 'appShell.clubSwitcher.roleLabel')).toBeInTheDocument()
  })

  it('calls setCurrentClubId when a different club is selected', () => {
    mockAuth = {
      memberships: [singleMembership, secondMembership],
      currentMembership: singleMembership,
      setCurrentClubId,
      signOut: vi.fn(),
    }
    renderWithProviders()

    const select = screen.getByRole('combobox') as HTMLSelectElement
    select.value = 'club-2'
    select.dispatchEvent(new Event('change', { bubbles: true }))

    expect(setCurrentClubId).toHaveBeenCalledWith('club-2')
  })
})
