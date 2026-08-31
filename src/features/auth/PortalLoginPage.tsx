import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { translateSupabaseError } from '@/lib/errors'

// AUTH ARCHITECTURE RECONCILIATION (2026-08-31): the approved CUSTOMER
// authentication policy is Email OTP via Supabase Auth -- phone remains
// corroboration/operational data only (see claim_customer_self_service's
// own hardened corroboration check), never a login credential, and no
// SMS/WhatsApp OTP is ever introduced. This is a genuinely SEPARATE page
// from LoginPage.tsx, deliberately -- LoginPage.tsx is shared by staff/
// tenant-owner/platform-owner personas and remains fully untouched,
// password-based, per the directive's own explicit instruction not to
// unnecessarily migrate those personas. Splitting the entry point here
// (rather than adding persona-detection branching logic inside the
// shared LoginPage) keeps the blast radius of this change to exactly
// the customer journey, with zero risk of regressing the other three
// personas' login.
//
// Uses Supabase Auth's native signInWithOtp()/verifyOtp() -- no custom
// crypto, no custom rate-limiting (Supabase's own OTP rate limits and
// otp_expiry/otp_length settings apply, see supabase/config.toml's
// [auth.email] section), no new paid service. signInWithOtp() is safe
// to call for BOTH a brand-new email (creates the auth.users row
// implicitly, Supabase's own default behavior when shouldCreateUser is
// left at its default true) AND an existing email that already has a
// password set -- Supabase Auth is keyed by email uniqueness in
// auth.users, so verifying the OTP establishes a session for the SAME
// existing identity, never a second/duplicate auth.users row. This is
// exactly the compatibility guarantee an already-password-authenticated
// customer needs: they can switch to OTP login for the same account
// with zero migration action required on their part.
//
// Historical customer claiming remains entirely separate and unchanged
// -- successfully authenticating via OTP only establishes a Supabase
// session; RequirePortalCustomer (see RequireAuth.tsx) still gates on
// a real customers.user_id linkage, and ClaimAccountPage's own hardened
// phone-corroboration RPC (claim_customer_self_service) is still the
// only path to link an unclaimed historical customer record. OTP
// success never auto-claims or auto-creates a customer record.
export function PortalLoginPage() {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [stage, setStage] = useState<'email' | 'otp'>('email')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

  async function handleRequestOtp(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        // Never create a customer/business record here -- signInWithOtp
        // only ever creates the bare auth.users identity (Supabase's own
        // default), the same "empty" identity signup would produce. No
        // shouldCreateUser: false override -- a customer with a
        // staff-created record but no login yet must be able to request
        // an OTP for their own email on first use, exactly like a
        // brand-new customer would.
        shouldCreateUser: true,
      },
    })

    setSubmitting(false)

    if (otpError) {
      setError(translateSupabaseError(otpError, t('auth.portalLogin.requestError')))
      return
    }

    // ENUMERATION-RESISTANT UX: the exact same success state is shown
    // whether this email already has an account or not -- Supabase's
    // own signInWithOtp() response never distinguishes new-vs-existing
    // to the caller either, so there is no signal available to leak
    // even if this code wanted to.
    setStage('otp')
  }

  async function handleVerifyOtp(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: otp.trim(),
      type: 'email',
    })

    setSubmitting(false)

    if (verifyError) {
      // Never surface the raw provider error string -- same pattern
      // LoginPage.tsx already establishes for signInWithPassword.
      // Covers wrong code, expired code, and already-used (replayed)
      // code alike -- Supabase's own verifyOtp() returns the same
      // generic invalid-token error class for all three, which is
      // itself the correct enumeration-safe behavior (never confirms
      // *why* a code failed).
      setError(t('auth.portalLogin.verifyError'))
      return
    }

    // Success: a real Supabase session now exists for this email's
    // auth.users identity. Land on /portal -- RequirePortalCustomer
    // (wrapping the whole /portal subtree) handles the claim-gate
    // check from here; this page's job ends at "session established".
    const from = (location.state as { from?: Location })?.from?.pathname
    navigate(from && from.startsWith('/portal') ? from : '/portal', { replace: true })
  }

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col items-center justify-center gap-6 px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-xl">{t('auth.portalLogin.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {stage === 'email' ? (
            <form onSubmit={handleRequestOtp} className="flex flex-col gap-4">
              <p className="text-center text-sm text-text-secondary">{t('auth.portalLogin.emailStageDescription')}</p>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="portal-email" className="text-sm font-medium text-text-secondary">
                  {t('auth.emailLabel')}
                </label>
                <Input
                  id="portal-email"
                  type="email"
                  autoComplete="email"
                  required
                  dir="ltr"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              {error && (
                <p role="alert" className="text-sm text-status-danger">
                  {error}
                </p>
              )}

              <Button type="submit" disabled={submitting || !email.trim()} className="mt-2">
                {submitting ? t('auth.portalLogin.sending') : t('auth.portalLogin.sendCode')}
              </Button>

              <Link to="/login" className="text-center text-sm text-text-secondary hover:underline">
                {t('auth.portalLogin.staffLoginLink')}
              </Link>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="flex flex-col gap-4">
              <p className="text-center text-sm text-text-secondary">
                {t('auth.portalLogin.otpStageDescription', { email })}
              </p>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="portal-otp" className="text-sm font-medium text-text-secondary">
                  {t('auth.portalLogin.codeLabel')}
                </label>
                <Input
                  id="portal-otp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  dir="ltr"
                  className="text-center text-lg tracking-[0.5em]"
                  maxLength={6}
                  required
                  autoFocus
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                />
              </div>

              {error && (
                <p role="alert" className="text-sm text-status-danger">
                  {error}
                </p>
              )}

              <Button type="submit" disabled={submitting || otp.trim().length === 0} className="mt-2">
                {submitting ? t('auth.portalLogin.verifying') : t('auth.portalLogin.verify')}
              </Button>

              <button
                type="button"
                className="text-center text-sm text-text-secondary hover:underline"
                onClick={() => {
                  setStage('email')
                  setOtp('')
                  setError(null)
                }}
              >
                {t('auth.portalLogin.changeEmail')}
              </button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
