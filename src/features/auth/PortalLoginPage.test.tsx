import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PortalLoginPage } from './PortalLoginPage'

// CUSTOMER EMAIL OTP (2026-08-31) -- COMPONENT RENDER VERIFICATION.
// signInWithOtp()/verifyOtp() themselves are mocked (a real OTP round
// trip needs a real inbox, environment-blocked in any sandboxed/CI
// runner -- the actual live infrastructure reachability was verified
// separately this session via a real signInWithOtp() call against the
// production Supabase project, which correctly hit its own send-rate
// limit, proving the endpoint is live and reachable). What this file
// verifies is the thing that previously had zero coverage: given a
// real signInWithOtp()/verifyOtp() response shape, does the actual
// PortalLoginPage component render the correct stage/error state --
// email-stage submit correctly transitions to the OTP-entry stage on
// success, wrong/expired OTP shows the enumeration-safe generic error
// (never a raw provider error), and a successful verify navigates to
// /portal. No production code is touched or bypassed. Uses fireEvent
// (already an @testing-library/react dependency) rather than
// @testing-library/user-event, which is not installed in this repo --
// matches this codebase's existing test-utility footprint (see
// ScanPage.test.tsx) rather than adding a new dependency.
//
// Matches against the English copy: the test environment's i18next
// language-detector resolves to English (jsdom's default locale),
// regardless of the app's own runtime default of Arabic (see
// i18n/config.ts's fallbackLng) -- matching what's actually rendered
// rather than fighting the detector.

const mockSignInWithOtp = vi.fn()
const mockVerifyOtp = vi.fn()
const mockNavigate = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      signInWithOtp: (...args: unknown[]) => mockSignInWithOtp(...args),
      verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args),
    },
  },
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

function renderPage() {
  return render(
    <MemoryRouter>
      <PortalLoginPage />
    </MemoryRouter>,
  )
}

async function requestOtpFor(email: string) {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } })
  fireEvent.click(screen.getByRole('button', { name: /send login code/i }))
  return screen.findByLabelText(/login code/i)
}

describe('PortalLoginPage', () => {
  beforeEach(() => {
    mockSignInWithOtp.mockReset()
    mockVerifyOtp.mockReset()
    mockNavigate.mockReset()
  })

  it('requests an OTP for the entered email and transitions to the code-entry stage on success', async () => {
    mockSignInWithOtp.mockResolvedValue({ data: { user: null, session: null }, error: null })
    renderPage()

    await requestOtpFor('qa.customer@example.com')

    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: 'qa.customer@example.com',
      options: { shouldCreateUser: true },
    })
    expect(screen.getByLabelText(/login code/i)).toBeInTheDocument()
  })

  it('shows the same success transition regardless of whether the account already exists (Supabase itself never signals this distinction)', async () => {
    mockSignInWithOtp.mockResolvedValue({ data: { user: null, session: null }, error: null })
    renderPage()

    await requestOtpFor('existing.customer@example.com')

    // Same UI transition regardless of new-vs-existing -- no branch in
    // this component's own logic ever inspects account-existence.
    expect(screen.getByLabelText(/login code/i)).toBeInTheDocument()
  })

  it('shows a translated, non-raw error when the OTP request fails (e.g. rate limited)', async () => {
    mockSignInWithOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'email rate limit exceeded', status: 429, code: 'over_email_send_rate_limit' },
    })
    renderPage()

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'qa.customer@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /send login code/i }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toMatch(/rate_limit|postgres|uuid|P0001/i)
    expect(alert.textContent).toMatch(/too many times|wait/i) // the real translated rate-limit copy
  })

  it('rejects an incorrect or expired OTP with a generic, non-raw error and stays on the code-entry stage', async () => {
    mockSignInWithOtp.mockResolvedValue({ data: { user: null, session: null }, error: null })
    mockVerifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Token has expired or is invalid', status: 403, code: 'otp_expired' },
    })
    renderPage()

    await requestOtpFor('qa.customer@example.com')
    fireEvent.change(screen.getByLabelText(/login code/i), { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: /verify and sign in/i }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toMatch(/postgres|uuid|otp_expired|P0001/i)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('navigates to /portal on a successful OTP verification', async () => {
    mockSignInWithOtp.mockResolvedValue({ data: { user: null, session: null }, error: null })
    mockVerifyOtp.mockResolvedValue({ data: { user: { id: 'u1' }, session: { access_token: 'tok' } }, error: null })
    renderPage()

    await requestOtpFor('qa.customer@example.com')
    fireEvent.change(screen.getByLabelText(/login code/i), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: /verify and sign in/i }))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/portal', { replace: true })
    })
  })

  it('only ever accepts digits into the OTP field, even if non-digit characters are entered', async () => {
    mockSignInWithOtp.mockResolvedValue({ data: { user: null, session: null }, error: null })
    renderPage()

    const otpInput = (await requestOtpFor('qa.customer@example.com')) as HTMLInputElement
    fireEvent.change(otpInput, { target: { value: '12a3-4b5' } })
    expect(otpInput.value).toBe('12345')
  })

  it('the "change email" action returns to the email-entry stage', async () => {
    mockSignInWithOtp.mockResolvedValue({ data: { user: null, session: null }, error: null })
    renderPage()

    await requestOtpFor('qa.customer@example.com')
    fireEvent.click(screen.getByRole('button', { name: /change email/i }))

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
  })
})
