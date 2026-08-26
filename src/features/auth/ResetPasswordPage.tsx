import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// Reached via the link Supabase Auth sends from resetPasswordForEmail — the
// session is already established by Supabase's own redirect handling by
// the time this page renders; we just call updateUser with the new password.
export function ResetPasswordPage() {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    const { error: updateError } = await supabase.auth.updateUser({ password })

    setSubmitting(false)

    if (updateError) {
      setError(t('auth.resetPasswordPage.updateError'))
      return
    }

    setDone(true)
    setTimeout(() => navigate('/login', { replace: true }), 1500)
  }

  return (
    // AUTH RESPONSIVE LAYOUT HOTFIX (2026-08-26): see ForgotPasswordPage.tsx's
    // identical fix comment -- same row/column flex-axis bug, same fix.
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-4 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-center text-xl">{t('auth.resetPasswordPage.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {done ? (
            <p className="text-center text-sm text-status-success">{t('auth.resetPasswordPage.successMessage')}</p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <Input
                type="password"
                placeholder={t('auth.resetPasswordPage.newPasswordPlaceholder')}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {error && (
                <p role="alert" className="text-sm text-status-danger">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={submitting}>
                {submitting ? t('auth.resetPasswordPage.saving') : t('auth.resetPasswordPage.savePassword')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
