import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// Supabase Auth's built-in resetPasswordForEmail flow — no custom
// password-reset system (ADR-041).
export function ForgotPasswordPage() {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    // Platform Owner & Password Security directive: best-effort audit
    // event. Deliberately NOT awaited into the success/failure branch --
    // this request is anonymous by design (no session exists yet, and
    // must never differ in timing/behavior based on whether the email
    // is registered), and log_password_reset_event('self_requested')
    // requires auth.uid(), which is null here -- it will simply no-op
    // server-side for an unauthenticated caller. This call exists only
    // to cover the case where a signed-in user reaches this same page
    // deliberately (e.g. to rotate credentials); it never blocks or
    // alters the response shown to the visitor.
    await supabase.rpc('log_password_reset_event', { p_kind: 'self_requested' }).then(
      () => undefined,
      () => undefined,
    )
    setSubmitting(false)
    // Always show the same success state regardless of whether the email
    // exists — never reveal account existence via response differences.
    setSent(true)
  }

  return (
    // AUTH RESPONSIVE LAYOUT HOTFIX (2026-08-26): the outer wrapper was
    // `flex` (row-direction by default) with `justify-center` -- on the
    // main axis that centers a flex item at its shrink-to-fit content
    // size rather than stretching it, so the Card's own `w-full` had
    // nothing to stretch against and the whole form collapsed to ~115px-
    // wide inputs inside a ~164px card at desktop widths (confirmed live
    // at 1366x768). `flex-col` fixes the axis mismatch; `max-w-sm` moved
    // off the row wrapper and onto the Card itself (mirrors the already-
    // correct ClaimAccountPage.tsx/ActivateAccountPage.tsx pattern) so
    // the card gets a real, professional 384-448px desktop width instead
    // of inheriting a shrunk flex-item size.
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-4 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-center text-xl">{t('auth.forgotPasswordPage.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {sent ? (
            <p className="text-center text-sm text-text-secondary">
              {t('auth.forgotPasswordPage.sentMessage')}
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <Input
                type="email"
                placeholder={t('auth.forgotPasswordPage.emailPlaceholder')}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button type="submit" disabled={submitting}>
                {submitting ? t('auth.forgotPasswordPage.sending') : t('auth.forgotPasswordPage.sendResetLink')}
              </Button>
              <p className="text-center text-sm text-text-secondary">
                <Link to="/login" className="text-accent-foreground hover:underline">
                  {t('auth.forgotPasswordPage.backToLogin')}
                </Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
