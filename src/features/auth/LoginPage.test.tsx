import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LoginPage } from './LoginPage'

// FULL PRODUCT E2E ACCEPTANCE (D-E2E-001, P0 fix, 2026-08-31) --
// COMPONENT ROUTING VERIFICATION. This file previously had zero unit
// coverage (LoginPage's real signInWithPassword() flow could only ever
// be exercised live, and this codebase's standing rule -- never type a
// real password into a login form, including from an automated test --
// blocked any live-login E2E for it too). This test mocks
// signInWithPassword()'s RESOLVED VALUE (never types/submits a real
// password anywhere -- the form field is never even filled with a
// secret), which is enough to exercise the pure post-login ROUTING
// logic this bug lived in: hasAnyActiveMembership() /
// activate_my_invited_memberships() / hasAnyLinkedCustomerRecord() /
// isPlatformOwner(), and the order they're checked in.
//
// The regression this specifically guards: a staff member whose
// club_memberships row is still 'invited' (real staff-invite path,
// create_club_staff_membership_service) must have
// activate_my_invited_memberships() called BEFORE the
// hasAnyActiveMembership() check that decides whether they land on
// /app or get sent to /onboarding to create a brand-new club.
//
// Matches English copy (see PortalLoginPage.test.tsx's identical note):
// the jsdom test environment's i18next language-detector resolves to
// English regardless of the app's own Arabic runtime default.

const mockSignInWithPassword = vi.fn()
const mockRpc = vi.fn()
const mockFrom = vi.fn()
const mockNavigate = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

// Builds the exact chainable shape each of hasAnyActiveMembership()/
// hasAnyLinkedCustomerRecord() calls: supabase.from(table).select(...).eq?.(...)
// resolving to { count }.
function fromResult(count: number) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => Promise.resolve({ count, error: null })),
    then: (resolve: (v: { count: number; error: null }) => void) => resolve({ count, error: null }),
  }
  return chain
}

function renderPage() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  )
}

async function submitLogin(email = 'staff@example.com', password = 'irrelevant-not-a-real-secret') {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } })
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: /login|sign in|دخول/i }))
}

describe('LoginPage post-login routing', () => {
  beforeEach(() => {
    mockSignInWithPassword.mockReset()
    mockRpc.mockReset()
    mockFrom.mockReset()
    mockNavigate.mockReset()
    mockSignInWithPassword.mockResolvedValue({ data: { session: {} }, error: null })
    mockRpc.mockImplementation((name: string) => {
      if (name === 'is_platform_owner') return Promise.resolve({ data: false, error: null })
      if (name === 'activate_my_invited_memberships') return Promise.resolve({ data: 0, error: null })
      return Promise.resolve({ data: null, error: null })
    })
  })

  it('D-E2E-001 regression: calls activate_my_invited_memberships() before routing, so a just-activated invited staff member reaches /app, not /onboarding', async () => {
    // Simulates the exact real-world sequence: the staff member's
    // membership WAS 'invited' and activate_my_invited_memberships()
    // just flipped it to 'active' as part of this same login -- so the
    // subsequent hasAnyActiveMembership() check (which queries fresh)
    // must see it as active.
    const callOrder: string[] = []
    mockRpc.mockImplementation((name: string) => {
      callOrder.push(name)
      if (name === 'is_platform_owner') return Promise.resolve({ data: false, error: null })
      if (name === 'activate_my_invited_memberships') return Promise.resolve({ data: 1, error: null })
      return Promise.resolve({ data: null, error: null })
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'club_memberships') {
        callOrder.push('query:club_memberships')
        return fromResult(1) // now active, thanks to the activation RPC above
      }
      return fromResult(0)
    })

    renderPage()
    await submitLogin()

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/app', { replace: true }))
    expect(mockRpc).toHaveBeenCalledWith('activate_my_invited_memberships')
    // The activation call must happen before the membership-status query
    // that decides routing -- not after, and not skipped.
    const activateIdx = callOrder.indexOf('activate_my_invited_memberships')
    const queryIdx = callOrder.indexOf('query:club_memberships')
    expect(activateIdx).toBeGreaterThanOrEqual(0)
    expect(queryIdx).toBeGreaterThan(activateIdx)
  })

  it('calls activate_my_invited_memberships() unconditionally on every login, even with nothing to activate (idempotent no-op)', async () => {
    mockFrom.mockImplementation(() => fromResult(0))
    renderPage()
    await submitLogin()

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled())
    expect(mockRpc).toHaveBeenCalledWith('activate_my_invited_memberships')
  })

  it('a platform owner is routed to /platform regardless of membership/activation state', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'is_platform_owner') return Promise.resolve({ data: true, error: null })
      if (name === 'activate_my_invited_memberships') return Promise.resolve({ data: 0, error: null })
      return Promise.resolve({ data: null, error: null })
    })
    mockFrom.mockImplementation(() => fromResult(0))

    renderPage()
    await submitLogin()

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/platform', { replace: true }))
  })

  it('a real login failure never calls the activation RPC and shows a translated, non-raw error', async () => {
    mockSignInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid login credentials', status: 400 },
    })

    renderPage()
    await submitLogin()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toMatch(/postgres|P0001|invalid login credentials/i)
    expect(mockRpc).not.toHaveBeenCalledWith('activate_my_invited_memberships')
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('a user with no club membership and no linked customer record is routed to /onboarding', async () => {
    mockFrom.mockImplementation(() => fromResult(0))
    renderPage()
    await submitLogin()

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/onboarding', { replace: true }))
  })
})
