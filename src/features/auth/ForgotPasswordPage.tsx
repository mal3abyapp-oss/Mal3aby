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
    setSubmitting(false)
    // Always show the same success state regardless of whether the email
    // exists — never reveal account existence via response differences.
    setSent(true)
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm items-center justify-center px-4 py-12">
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
