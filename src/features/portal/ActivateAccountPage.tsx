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
 * ACTIVATION (amendment 2026-08-23). Standalone public route
 * (/activate/:token), same pattern as SecureBookingPage/
 * VerifyInvoicePage/PublicClubBookingPage -- no auth guard, no
 * PublicLayout marketing chrome, reachable only via the opaque token
 * delivered in a WhatsApp booking message.
 *
 * Three-step flow, each step server-verified, minimum information
 * shown before ownership is proven (amendment section 7):
 *   1. Context: masked phone + first name + (if invite was triggered
 *      by a booking) a minimal booking summary. Never full history.
 *   2. Registered-phone confirmation: the zero-cost second factor
 *      (amendment section 8) -- possession of the link alone is not
 *      enough. Reuses the exact same PhoneInput/normalizePhone
 *      pipeline as every other phone-accepting form in this app.
 *   3. Email + password (customer's own choice, never staff-assigned)
 *      -> supabase.auth.signUp() -> claim_portal_invite() atomically
 *      links the new auth user to the canonical customer -> redirect
 *      straight into /portal.
 *
 * Every step derives identity exclusively from the raw token in the
 * URL -- the server never trusts a customer_id from this page, and
 * this page never learns the customer's real phone number (only ever
 * receives a masked version back for display).
 */

type Step = 'loading' | 'context' | 'phone' | 'credentials' | 'success' | 'invalid' | 'already_activated'

interface InviteContext {
  customerName: string | null
  clubName: string | null
  maskedPhone: string | null
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
  const [phoneError, setPhoneError] = useState<string | null>(null)
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
    if (step === 'loading') setStep('context')
  }, [contextLoading, contextError, context, step])

  const phoneMutation = useMutation({
    mutationFn: async () => {
      const phoneResult = normalizePhone(phoneRaw, phoneCountry)
      if (!phoneResult.valid || !phoneResult.e164) {
        throw new Error(t('activate.invalidPhone'))
      }
      const { data, error } = await supabase.rpc('verify_portal_invite_phone', {
        p_raw_token: token!,
        p_entered_phone_e164: phoneResult.e164,
      })
      if (error) throw error
      return data as boolean
    },
    onSuccess: (matched) => {
      if (matched) {
        setPhoneError(null)
        setStep('credentials')
      } else {
        // Section 27: generic failure, never reveal which part was wrong.
        setPhoneError(t('activate.phoneMismatch'))
      }
    },
    onError: (error: { message?: string }) => {
      setPhoneError(error?.message || t('activate.genericError'))
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
      const message = error?.message ?? ''
      if (message.includes('already has an activated portal account') || message.includes('already linked to a different account')) {
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

            <Button className="w-full" onClick={() => setStep('phone')}>
              {t('activate.activateButton')}
            </Button>
          </div>
        )}

        {step === 'phone' && (
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

            {phoneError && <p role="alert" className="text-sm text-status-danger">{phoneError}</p>}

            <Button
              className="w-full"
              disabled={!phoneValid || phoneMutation.isPending}
              onClick={() => phoneMutation.mutate()}
            >
              {phoneMutation.isPending ? t('activate.verifying') : t('activate.confirmButton')}
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
