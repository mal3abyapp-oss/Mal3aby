import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { LanguageSwitcher } from '@/components/ui/language-switcher'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CheckCircle2, XCircle, ShieldCheck, LogIn } from 'lucide-react'

/**
 * ActivateTenantOwnerPage -- Sales Intelligence Phase 14 (ADR-054 final
 * decision: INVITE-BASED OWNER ACTIVATION). Standalone public route
 * (/sales-activate/:token), structurally mirroring ActivateAccountPage
 * (the proven portal_invites pattern), adapted for a B2B prospect with
 * no club yet:
 *
 *   1. Context: masked owner email + business name. Never full lead data.
 *   2. Email confirmation (verify_sales_activation_email) -- proves the
 *      prospect controls the email the platform owner recorded at WON
 *      time (there is no "registered phone" the way a customer has one --
 *      a lead is a business, not a person with an account).
 *   3. Independent activation secret (verify_sales_activation_secret) --
 *      delivered out of band by the platform owner, never in this URL.
 *   4a. New prospect: choose a password -> sales-activate-tenant-owner
 *       Edge Function creates a pre-confirmed auth identity (email is the
 *       invite's own server-stored owner_email, never client-supplied)
 *       -> ordinary signInWithPassword() -> claim_sales_activation_invite()
 *       under that real session, which is the ONLY place complete_new_
 *       club_onboarding() is ever called, and always as the prospect's
 *       own identity -- never the platform owner's.
 *   4b. Existing account (Edge Function returns 409/existing_account):
 *       route to an ordinary sign-in form instead of creating a second
 *       identity (mandatory rule: "if the prospect already has an
 *       existing account, link the existing account after verification
 *       instead of creating a second one" / this codebase's own
 *       documented rule "never auto-link on a bare email-string match").
 *       After a successful sign-in, claim_sales_activation_invite() links
 *       that real session's identity.
 */

type Step =
  | 'loading' | 'context' | 'verify' | 'choice'
  | 'credentials' | 'signin' | 'linking' | 'success' | 'invalid' | 'already_activated'

interface InviteContext {
  businessName: string | null
  businessNameAr: string | null
  ownerEmailMasked: string | null
  status: string | null
  isExpired: boolean
}

async function fetchInviteContext(token: string): Promise<InviteContext> {
  const { data, error } = await supabase.rpc('get_sales_activation_invite_context', { p_raw_token: token })
  if (error) throw error
  const row = data?.[0]
  return {
    businessName: row?.business_name ?? null,
    businessNameAr: row?.business_name_ar ?? null,
    ownerEmailMasked: row?.owner_email_masked ?? null,
    status: row?.status ?? null,
    isExpired: row?.is_expired ?? false,
  }
}

export function ActivateTenantOwnerPage() {
  const { token } = useParams<{ token: string }>()
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const { direction, locale, setLocale } = useDirection()
  const navigate = useNavigate()

  const [step, setStep] = useState<Step>('loading')
  const [emailRaw, setEmailRaw] = useState('')
  const [secretRaw, setSecretRaw] = useState('')
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [signinPassword, setSigninPassword] = useState('')
  const [credentialsError, setCredentialsError] = useState<string | null>(null)

  useEffect(() => {
    const langParam = searchParams.get('lang')
    if (langParam === 'ar' || langParam === 'en') {
      if (langParam !== locale) setLocale(langParam)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { data: context, isLoading: contextLoading, isError: contextError } = useQuery({
    queryKey: ['sales-activation-invite-context', token],
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
    if (context.status === 'consumed') {
      setStep('already_activated')
      return
    }
    if (step === 'loading') setStep('context')
  }, [contextLoading, contextError, context, step])

  // Both factors are independent server checks -- the generic failure
  // message never reveals which one was wrong, mirroring the portal
  // activation flow's own anti-enumeration convention exactly.
  const verifyMutation = useMutation({
    mutationFn: async () => {
      if (!emailRaw.trim() || !emailRaw.includes('@')) {
        throw new Error(t('activateTenant.invalidEmail'))
      }
      if (!secretRaw.trim()) {
        throw new Error(t('activateTenant.invalidSecret'))
      }

      const { data: emailMatched, error: emailErr } = await supabase.rpc('verify_sales_activation_email', {
        p_raw_token: token!,
        p_entered_email: emailRaw.trim(),
      })
      if (emailErr) throw emailErr

      const { data: secretMatched, error: secretErr } = await supabase.rpc('verify_sales_activation_secret', {
        p_raw_token: token!,
        p_entered_secret: secretRaw.trim(),
      })
      if (secretErr) throw secretErr

      return Boolean(emailMatched) && Boolean(secretMatched)
    },
    onSuccess: (bothMatched) => {
      if (!bothMatched) {
        setVerifyError(t('activateTenant.verifyMismatch'))
        return
      }
      setVerifyError(null)
      setStep('choice')
    },
    onError: (error: { message?: string }) => {
      setVerifyError(error?.message || t('activateTenant.genericError'))
    },
  })

  const claimMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('claim_sales_activation_invite', { p_raw_token: token! })
      if (error) throw error
      return data as string
    },
    onSuccess: () => {
      setStep('success')
      setTimeout(() => navigate('/platform', { replace: true }), 1500)
    },
    onError: (error: { message?: string }) => {
      const message = error?.message ?? ''
      if (message.includes('already been used') || message.includes('already activated a different business')) {
        setStep('already_activated')
        return
      }
      setCredentialsError(message || t('activateTenant.genericError'))
    },
  })

  const credentialsMutation = useMutation({
    mutationFn: async () => {
      if (password !== confirmPassword) {
        throw new Error(t('activateTenant.passwordMismatch'))
      }
      if (password.length < 8) {
        throw new Error(t('activateTenant.passwordTooShort'))
      }

      // Account creation happens server-side via the Edge Function (zero
      // outbound-email confirmation, matching this project's established
      // convention) -- email is the invite's own server-stored value,
      // never sent from this page. No onboarding happens here yet.
      const { data: fnData, error: fnError } = await supabase.functions.invoke<{ user_id?: string; error?: string; existing_account?: boolean }>(
        'sales-activate-tenant-owner',
        { body: { raw_token: token, password } },
      )

      if (fnError || fnData?.error) {
        if (fnData?.existing_account) {
          // Mandatory rule: link the existing account instead of a second
          // one -- never an automatic link from the email string alone.
          setStep('signin')
          throw new Error('__existing_account__')
        }
        throw new Error(fnData?.error ?? fnError?.message ?? t('activateTenant.genericError'))
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({ email: emailRaw.trim(), password })
      if (signInError) {
        throw new Error(t('activateTenant.signInAfterCreateFailed'))
      }

      // Now under a real session -- the only place onboarding runs.
      return claimMutation.mutateAsync()
    },
    onSuccess: () => {
      setCredentialsError(null)
    },
    onError: (error: { message?: string }) => {
      if (error?.message === '__existing_account__') return
      setCredentialsError(error?.message || t('activateTenant.genericError'))
    },
  })

  const signinMutation = useMutation({
    mutationFn: async () => {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: emailRaw.trim(), password: signinPassword })
      if (signInError) {
        throw new Error(t('activateTenant.signInFailed'))
      }
      return claimMutation.mutateAsync()
    },
    onError: (error: { message?: string }) => {
      setCredentialsError(error?.message || t('activateTenant.genericError'))
    },
  })

  return (
    <div dir={direction} className="flex min-h-screen flex-col bg-page-bg">
      <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3">
        <span className="font-semibold">{t('activateTenant.brand')}</span>
        <LanguageSwitcher />
      </header>

      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
        {step === 'loading' && (
          <p className="text-center text-sm text-text-secondary">{t('activateTenant.loading')}</p>
        )}

        {step === 'invalid' && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface p-6 text-center shadow-sm">
            <XCircle className="size-12 text-status-danger" />
            <p className="font-medium">{t('activateTenant.invalidTitle')}</p>
            <p className="text-sm text-text-secondary">{t('activateTenant.invalidMessage')}</p>
          </div>
        )}

        {step === 'already_activated' && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface p-6 text-center shadow-sm">
            <ShieldCheck className="size-12 text-status-info" />
            <p className="font-medium">{t('activateTenant.alreadyActivatedTitle')}</p>
            <Button className="mt-2 w-full" onClick={() => navigate('/login')}>
              <LogIn className="me-1.5 size-4" />
              {t('activateTenant.goToLogin')}
            </Button>
          </div>
        )}

        {step === 'context' && context && (
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-sm">
            <div className="text-center">
              <p className="text-lg font-semibold">
                {t('activateTenant.greeting', { name: context.businessNameAr ?? context.businessName ?? '' })}
              </p>
            </div>
            {context.ownerEmailMasked && (
              <p className="text-center text-xs text-text-secondary">
                {t('activateTenant.registeredEmailHint')} <bdi dir="ltr">{context.ownerEmailMasked}</bdi>
              </p>
            )}
            <Button className="w-full" onClick={() => setStep('verify')}>
              {t('activateTenant.activateButton')}
            </Button>
          </div>
        )}

        {step === 'verify' && (
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-sm">
            <div className="text-center">
              <ShieldCheck className="mx-auto size-10 text-accent-foreground" />
              <p className="mt-2 font-medium">{t('activateTenant.confirmTitle')}</p>
              <p className="mt-1 text-sm text-text-secondary">{t('activateTenant.confirmHint')}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('activateTenant.emailLabel')}</label>
              <Input type="email" required dir="ltr" value={emailRaw} onChange={(e) => setEmailRaw(e.target.value)} placeholder="you@example.com" />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('activateTenant.secretLabel')}</label>
              <p className="text-xs text-text-secondary">{t('activateTenant.secretHint')}</p>
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
              disabled={!emailRaw.includes('@') || !secretRaw.trim() || verifyMutation.isPending}
              onClick={() => verifyMutation.mutate()}
            >
              {verifyMutation.isPending ? t('activateTenant.verifying') : t('activateTenant.confirmButton')}
            </Button>
          </div>
        )}

        {step === 'choice' && (
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-sm">
            <div className="text-center">
              <CheckCircle2 className="mx-auto size-10 text-status-success" />
              <p className="mt-2 font-medium">{t('activateTenant.choiceTitle')}</p>
              <p className="mt-1 text-sm text-text-secondary">{t('activateTenant.choiceHint')}</p>
            </div>
            <Button className="w-full" onClick={() => setStep('credentials')}>
              {t('activateTenant.newAccountButton')}
            </Button>
            <Button variant="outline" className="w-full" onClick={() => setStep('signin')}>
              {t('activateTenant.haveAccountButton')}
            </Button>
          </div>
        )}

        {step === 'credentials' && (
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-sm">
            <div className="text-center">
              <p className="font-medium">{t('activateTenant.createCredentialsTitle')}</p>
              <p className="mt-1 text-sm text-text-secondary">{t('activateTenant.createCredentialsHint')}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('activateTenant.passwordLabel')}</label>
              <Input type="password" required dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('activateTenant.confirmPasswordLabel')}</label>
              <Input type="password" required dir="ltr" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={8} />
            </div>
            <p className="text-xs text-text-secondary">{t('activateTenant.passwordRequirement')}</p>

            {credentialsError && <p role="alert" className="text-sm text-status-danger">{credentialsError}</p>}

            <Button
              className="w-full"
              disabled={!password || !confirmPassword || credentialsMutation.isPending || claimMutation.isPending}
              onClick={() => credentialsMutation.mutate()}
            >
              {credentialsMutation.isPending || claimMutation.isPending ? t('activateTenant.creating') : t('activateTenant.createAccountButton')}
            </Button>
          </div>
        )}

        {step === 'signin' && (
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-sm">
            <div className="text-center">
              <LogIn className="mx-auto size-10 text-accent-foreground" />
              <p className="mt-2 font-medium">{t('activateTenant.signInTitle')}</p>
              <p className="mt-1 text-sm text-text-secondary">{t('activateTenant.signInHint')}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('activateTenant.passwordLabel')}</label>
              <Input type="password" required dir="ltr" value={signinPassword} onChange={(e) => setSigninPassword(e.target.value)} />
            </div>

            {credentialsError && <p role="alert" className="text-sm text-status-danger">{credentialsError}</p>}

            <Button
              className="w-full"
              disabled={!signinPassword || signinMutation.isPending || claimMutation.isPending}
              onClick={() => signinMutation.mutate()}
            >
              {signinMutation.isPending || claimMutation.isPending ? t('activateTenant.signingIn') : t('activateTenant.signInButton')}
            </Button>
          </div>
        )}

        {step === 'success' && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface p-6 text-center shadow-sm">
            <CheckCircle2 className="size-12 text-status-success" />
            <p className="font-medium">{t('activateTenant.successTitle')}</p>
            <p className="text-sm text-text-secondary">{t('activateTenant.successMessage')}</p>
          </div>
        )}
      </main>
    </div>
  )
}
