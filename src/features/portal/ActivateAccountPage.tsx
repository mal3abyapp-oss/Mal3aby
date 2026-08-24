import { useState, useEffect } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { LanguageSwitcher } from '@/components/ui/language-switcher'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { normalizePhone } from '@/lib/domain/phone'
import { CheckCircle2, XCircle, ShieldCheck, LogIn } from 'lucide-react'

/**
 * ActivateAccountPage -- CUSTOMER ACCOUNT / CLUB PORTAL: ZERO-COST
 * ACTIVATION, with the CUSTOMER ACTIVATION TAKEOVER GAP security
 * closure (amendment 2026-08-23, closure same day). Standalone public
 * route (/activate/:token), same pattern as SecureBookingPage/
 * VerifyInvoicePage/PublicClubBookingPage -- no auth guard, no
 * PublicLayout marketing chrome, reachable only via the opaque token
 * delivered in a WhatsApp booking message.
 *
 * Four-factor flow (steps 2+3 combined into one visual screen, per the
 * security closure's own explicit allowance), each step server-
 * verified, minimum information shown before ownership is proven:
 *   1. Context: masked phone + first name + (if invite was triggered
 *      by a booking) a minimal booking summary. Never full history.
 *   2. Registered-phone confirmation (verify_portal_invite_phone) --
 *      reuses the exact same PhoneInput/normalizePhone pipeline as
 *      every other phone-accepting form in this app.
 *   3. Independent activation secret (verify_portal_invite_secret) --
 *      a SEPARATE credential from the URL token, delivered only in the
 *      WhatsApp message body, that the customer types in manually.
 *      Closes the residual takeover risk where someone who already
 *      knows the customer's phone number and obtains the activation
 *      URL could otherwise activate the account alone.
 *   4. Email + password (customer's own choice, never staff-assigned)
 *      -> activate-portal-account Edge Function, which itself
 *      re-verifies BOTH phone_verified_at AND secret_verified_at
 *      server-side (never trusts this page's own step-gating) before
 *      auth.admin.createUser() ever runs -> claim_portal_invite_service()
 *      atomically links the new auth user to the canonical customer ->
 *      sign-in -> redirect straight into /portal.
 *
 * Every step derives identity exclusively from the raw token in the
 * URL -- the server never trusts a customer_id from this page, this
 * page never learns the customer's real phone number (only ever
 * receives a masked version back for display), and the account-
 * creation endpoint is unreachable with only the token+phone (or only
 * the token+secret) -- both factors are independently required.
 */

type Step = 'loading' | 'context' | 'verify' | 'credentials' | 'success' | 'invalid' | 'already_activated'

interface InviteContext {
  customerName: string | null
  clubName: string | null
  maskedPhone: string | null
  status: string | null
  isExpired: boolean
  bookingFieldName: string | null
  bookingStartAt: string | null
  bookingEndAt: string | null
}

async function fetchInviteContext(token: string): Promise<InviteContext> {
  const { data, error } = await supabase.rpc('get_portal_invite_context', { p_raw_token: token })
  if (error) throw error
  const row = data?.[0]
  return {
    customerName: row?.customer_name ?? null,
    clubName: row?.club_name ?? null,
    maskedPhone: row?.masked_phone ?? null,
    status: row?.status ?? null,
    isExpired: row?.is_expired ?? false,
    bookingFieldName: row?.booking_field_name ?? null,
    bookingStartAt: row?.booking_start_at ?? null,
    bookingEndAt: row?.booking_end_at ?? null,
  }
}

export function ActivateAccountPage() {
  const { token } = useParams<{ token: string }>()
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const { direction, locale, setLocale } = useDirection()
  const navigate = useNavigate()

  const [step, setStep] = useState<Step>('loading')
  const [phoneRaw, setPhoneRaw] = useState('')
  const [phoneCountry, setPhoneCountry] = useState<CountryCode>('EG')
  const [phoneValid, setPhoneValid] = useState(false)
  const [secretRaw, setSecretRaw] = useState('')
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [credentialsError, setCredentialsError] = useState<string | null>(null)

  // Same one-time ?lang= seeding pattern as every other standalone
  // public page in this app (SecureBookingPage, PublicClubBookingPage).
  useEffect(() => {
    const langParam = searchParams.get('lang')
    if (langParam === 'ar' || langParam === 'en') {
      if (langParam !== locale) setLocale(langParam)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { data: context, isLoading: contextLoading, isError: contextError } = useQuery({
    queryKey: ['portal-invite-context', token],
    queryFn: () => fetchInviteContext(token!),
    enabled: !!token,
    retry: false,
  })

  useEffect(() => {
    if (contextLoading) return
    if (contextError || !context) {
      setStep('invalid')
      return
    }
    if (context.isExpired) {
      setStep('invalid')
      return
    }
    // A consumed (already-activated) invite must never let the customer
    // re-enter phone + activation secret -- route straight to the
    // friendly "already activated / go to login" screen instead of
    // letting them proceed through context/verify only to hit a raw,
    // unrouted server error later (verify_portal_invite_phone/secret and
    // activate-portal-account all independently reject a non-pending
    // invite, but with a generic message this page doesn't parse).
    if (context.status === 'consumed') {
      setStep('already_activated')
      return
    }
    if (step === 'loading') setStep('context')
  }, [contextLoading, contextError, context, step])

  // CUSTOMER ACTIVATION TAKEOVER GAP -- SECURITY CLOSURE: phone and
  // secret are two INDEPENDENT server checks, called sequentially here
  // (both must return true) -- the server itself never accepts one as
  // a substitute for the other, and the generic failure message below
  // deliberately never reveals which of the two factors was wrong
  // (directive section 27/7's explicit rule), matching the identical
  // generic-error pattern verify_portal_invite_phone already used
  // alone before this closure.
  const verifyMutation = useMutation({
    mutationFn: async () => {
      const phoneResult = normalizePhone(phoneRaw, phoneCountry)
      if (!phoneResult.valid || !phoneResult.e164) {
        throw new Error(t('activate.invalidPhone'))
      }
      if (!secretRaw.trim()) {
        throw new Error(t('activate.invalidSecret'))
      }

      const { data: phoneMatched, error: phoneErr } = await supabase.rpc('verify_portal_invite_phone', {
        p_raw_token: token!,
        p_entered_phone_e164: phoneResult.e164,
      })
      if (phoneErr) throw phoneErr

      const { data: secretMatched, error: secretErr } = await supabase.rpc('verify_portal_invite_secret', {
        p_raw_token: token!,
        p_entered_secret: secretRaw.trim(),
      })
      if (secretErr) throw secretErr

      return Boolean(phoneMatched) && Boolean(secretMatched)
    },
    onSuccess: (bothMatched) => {
      if (bothMatched) {
        setVerifyError(null)
        setStep('credentials')
      } else {
        // Section 27: generic failure, never reveal which factor (phone
        // or secret, or both) was wrong.
        setVerifyError(t('activate.verifyMismatch'))
      }
    },
    onError: (error: { message?: string }) => {
      setVerifyError(error?.message || t('activate.genericError'))
    },
  })

  const credentialsMutation = useMutation({
    mutationFn: async () => {
      if (password !== confirmPassword) {
        throw new Error(t('activate.passwordMismatch'))
      }
      if (password.length < 8) {
        throw new Error(t('activate.passwordTooShort'))
      }

      // Account creation + the atomic customer link both happen
      // server-side via the activate-portal-account Edge Function, NOT
      // client-side supabase.auth.signUp() -- live-tested against this
      // project's real hosted Auth config and confirmed signUp() there
      // requires email confirmation, which repeatedly hit Supabase's
      // outbound-email rate limit and silently prevented account
      // creation entirely. The Edge Function creates the auth user
      // pre-confirmed via the service_role admin API instead (zero
      // email sent, zero additional cost, matching this project's own
      // existing QA-account creation convention) and links it to the
      // canonical customer atomically before returning. Supabase Auth
      // itself remains the sole password/session authority throughout
      // -- this function never sees a session, only creates the user
      // record; the actual sign-in below is a completely ordinary
      // signInWithPassword() call with the credentials the customer
      // just chose.
      const { data: fnData, error: fnError } = await supabase.functions.invoke<{ customer_id?: string; error?: string }>(
        'activate-portal-account',
        { body: { raw_token: token, email, password } },
      )

      if (fnError || fnData?.error) {
        const message = fnData?.error ?? fnError?.message ?? ''
        if (message.toLowerCase().includes('already') || message.toLowerCase().includes('registered')) {
          throw new Error(t('activate.emailInUse'))
        }
        throw new Error(message || t('activate.genericError'))
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
      if (signInError) {
        // The account was genuinely created and linked at this point --
        // only the immediate sign-in failed (e.g. a transient network
        // blip). Direct the customer to sign in manually rather than
        // implying the whole activation failed.
        throw new Error(t('activate.signInAfterCreateFailed'))
      }

      return fnData?.customer_id
    },
    onSuccess: () => {
      setCredentialsError(null)
      setStep('success')
      setTimeout(() => navigate('/portal', { replace: true }), 1200)
    },
    onError: (error: { message?: string }) => {
      // This mutation only ever reaches the activate-portal-account Edge
      // Function, which surfaces claim_portal_invite_service()'s error
      // messages verbatim. That function (not the staff-only
      // send_portal_invite RPC, which this unauthenticated page never
      // calls) can raise 'this invite has already been used' or 'this
      // customer record is already linked to a different account' for a
      // stale/already-consumed link -- both route to the friendly
      // "already activated" screen instead of a raw error.
      const message = error?.message ?? ''
      if (message.includes('already been used') || message.includes('already linked to a different account')) {
        setStep('already_activated')
        return
      }
      setCredentialsError(message || t('activate.genericError'))
    },
  })

  return (
    <div dir={direction} className="flex min-h-screen flex-col bg-page-bg">
      <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
        <span className="font-semibold">{t('activate.brand')}</span>
        <LanguageSwitcher />
      </header>

      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
        {step === 'loading' && (
          <p className="text-center text-sm text-text-secondary">{t('activate.loading')}</p>
        )}

        {step === 'invalid' && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface p-6 text-center shadow-sm">
            <XCircle className="size-12 text-status-danger" />
            <p className="font-medium">{t('activate.invalidTitle')}</p>
            <p className="text-sm text-text-secondary">{t('activate.invalidMessage')}</p>
          </div>
        )}

        {step === 'already_activated' && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface p-6 text-center shadow-sm">
            <ShieldCheck className="size-12 text-status-info" />
            <p className="font-medium">{t('activate.alreadyActivatedTitle')}</p>
            <Button className="mt-2 w-full" onClick={() => navigate('/login')}>
              <LogIn className="me-1.5 size-4" />
              {t('activate.goToLogin')}
            </Button>
          </div>
        )}

        {step === 'context' && context && (
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-sm">
            <div className="text-center">
              <p className="text-lg font-semibold">
                {t('activate.greeting', { name: context.customerName ?? '' })}
              </p>
              {context.clubName && <p className="mt-1 text-sm text-text-secondary">{context.clubName}</p>}
            </div>

            {context.bookingFieldName && context.bookingStartAt && context.bookingEndAt && (
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <p className="text-xs text-text-secondary">{t('activate.yourBooking')}</p>
                <p className="font-medium">{context.bookingFieldName}</p>
                <p className="tabular-nums">
                  <bdi>
                    {new Date(context.bookingStartAt).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG', { day: 'numeric', month: 'long' })}
                    {' · '}
                    {new Date(context.bookingStartAt).toLocaleTimeString(locale === 'en' ? 'en-US' : 'ar-EG', { hour: '2-digit', minute: '2-digit' })}
                    {' — '}
                    {new Date(context.bookingEndAt).toLocaleTimeString(locale === 'en' ? 'en-US' : 'ar-EG', { hour: '2-digit', minute: '2-digit' })}
                  </bdi>
                </p>
              </div>
            )}

            {context.maskedPhone && (
              <p className="text-center text-xs text-text-secondary">
                {t('activate.registeredPhoneHint')} <bdi className="tabular-nums">{context.maskedPhone}</bdi>
              </p>
            )}

            <Button className="w-full" onClick={() => setStep('verify')}>
              {t('activate.activateButton')}
            </Button>
          </div>
        )}

        {step === 'verify' && (
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-sm">
            <div className="text-center">
              <ShieldCheck className="mx-auto size-10 text-accent-foreground" />
              <p className="mt-2 font-medium">{t('activate.confirmPhoneTitle')}</p>
              <p className="mt-1 text-sm text-text-secondary">{t('activate.confirmPhoneHint')}</p>
            </div>

            <PhoneInput
              label={t('activate.phoneLabel')}
              required
              value={{ raw: phoneRaw, country: phoneCountry }}
              onChange={(v) => { setPhoneRaw(v.raw); setPhoneCountry(v.country) }}
              onValidChange={(r) => setPhoneValid(r.valid)}
            />

            {/* CUSTOMER ACTIVATION TAKEOVER GAP -- SECURITY CLOSURE: the
                independent activation secret, delivered ONLY inside the
                WhatsApp message body -- never present anywhere in this
                page's own URL. Uppercased as typed since the secret's
                own alphabet is uppercase-only (mirrors the server's own
                upper(trim(...)) comparison, so a customer typing in
                lowercase still matches). */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('activate.secretLabel')}</label>
              <p className="text-xs text-text-secondary">{t('activate.secretHint')}</p>
              <Input
                required
                dir="ltr"
                className="text-center font-mono tracking-widest uppercase"
                value={secretRaw}
                onChange={(e) => setSecretRaw(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX"
                maxLength={9}
              />
            </div>

            {verifyError && <p role="alert" className="text-sm text-status-danger">{verifyError}</p>}

            <Button
              className="w-full"
              disabled={!phoneValid || !secretRaw.trim() || verifyMutation.isPending}
              onClick={() => verifyMutation.mutate()}
            >
              {verifyMutation.isPending ? t('activate.verifying') : t('activate.confirmButton')}
            </Button>
          </div>
        )}

        {step === 'credentials' && (
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-sm">
            <div className="text-center">
              <CheckCircle2 className="mx-auto size-10 text-status-success" />
              <p className="mt-2 font-medium">{t('activate.createCredentialsTitle')}</p>
              <p className="mt-1 text-sm text-text-secondary">{t('activate.createCredentialsHint')}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('activate.emailLabel')}</label>
              <Input type="email" required dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('activate.passwordLabel')}</label>
              <Input type="password" required dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('activate.confirmPasswordLabel')}</label>
              <Input type="password" required dir="ltr" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={8} />
            </div>
            <p className="text-xs text-text-secondary">{t('activate.passwordRequirement')}</p>

            {credentialsError && <p role="alert" className="text-sm text-status-danger">{credentialsError}</p>}

            <Button
              className="w-full"
              disabled={!email || !password || !confirmPassword || credentialsMutation.isPending}
              onClick={() => credentialsMutation.mutate()}
            >
              {credentialsMutation.isPending ? t('activate.creating') : t('activate.createAccountButton')}
            </Button>
          </div>
        )}

        {step === 'success' && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface p-6 text-center shadow-sm">
            <CheckCircle2 className="size-12 text-status-success" />
            <p className="font-medium">{t('activate.successTitle')}</p>
            <p className="text-sm text-text-secondary">{t('activate.successMessage')}</p>
          </div>
        )}
      </main>
    </div>
  )
}
