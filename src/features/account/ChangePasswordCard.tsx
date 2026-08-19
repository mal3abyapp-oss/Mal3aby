import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Eye, EyeOff } from 'lucide-react'

// Platform Owner & Password Security directive: self-service password
// change, shared by every authenticated role (Platform Owner, Club
// Owner/staff via Settings, Customer via Portal Profile) -- one
// component, not four copies. Supabase Auth remains the sole source of
// truth: no custom password storage, no plaintext anywhere in this
// codebase (this component never even holds the OLD password in state
// after the reauth call resolves).
//
// Reauthentication: Supabase Auth (GoTrue) has no standalone "verify
// current password" endpoint -- signInWithPassword() against the
// user's own known email IS the officially supported mechanism (same
// approach Supabase's own docs use for "update password" flows), so a
// wrong "current password" is caught BEFORE any update is attempted,
// never trusting the existing session alone for a sensitive change.
//
// Minimum length (6) matches this project's own Supabase Auth
// configuration (supabase/config.toml minimum_password_length) --
// intentionally not a stricter invented rule that could disagree with
// what the server will actually accept/reject.
const MIN_PASSWORD_LENGTH = 6

interface ChangePasswordCardProps {
  userEmail: string
}

function PasswordInput({
  id,
  label,
  autoComplete,
  value,
  onChange,
}: {
  id: string
  label: string
  autoComplete: string
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text-secondary">{label}</label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pe-10"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? t('account.changePassword.hidePassword') : t('account.changePassword.showPassword')}
          className="absolute inset-y-0 end-0 flex items-center px-3 text-text-secondary hover:text-text-primary"
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    </div>
  )
}

export function ChangePasswordCard({ userEmail }: ChangePasswordCardProps) {
  const { t } = useTranslation()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const mutation = useMutation({
    mutationFn: async () => {
      // Step 1: reauthenticate with the CURRENT password -- if this
      // fails, nothing about the account is touched.
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: userEmail,
        password: currentPassword,
      })
      if (reauthError) {
        throw new Error('WRONG_CURRENT_PASSWORD')
      }

      // Step 2: only after reauth succeeds, apply the new password via
      // Supabase Auth's own update mechanism -- never a custom write.
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })
      if (updateError) throw updateError

      // Step 3: audit event only (no password/token value ever passed) --
      // best-effort, never blocks the success state the user already
      // achieved if this particular write fails for some reason.
      await supabase.rpc('log_own_password_changed').then(
        () => undefined,
        () => undefined,
      )
    },
    onSuccess: () => {
      setError(null)
      setSuccess(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setTimeout(() => setSuccess(false), 4000)
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : ''
      if (message === 'WRONG_CURRENT_PASSWORD') {
        setError(t('account.changePassword.wrongCurrentPassword'))
      } else {
        setError(t('account.changePassword.genericError'))
      }
    },
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError(t('account.changePassword.allFieldsRequired'))
      return
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(t('account.changePassword.tooShort', { min: MIN_PASSWORD_LENGTH }))
      return
    }
    if (newPassword !== confirmPassword) {
      setError(t('account.changePassword.mismatch'))
      return
    }
    if (newPassword === currentPassword) {
      setError(t('account.changePassword.sameAsCurrent'))
      return
    }

    mutation.mutate()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('account.changePassword.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <PasswordInput
            id="current-password"
            label={t('account.changePassword.currentPasswordLabel')}
            autoComplete="current-password"
            value={currentPassword}
            onChange={setCurrentPassword}
          />
          <PasswordInput
            id="new-password"
            label={t('account.changePassword.newPasswordLabel')}
            autoComplete="new-password"
            value={newPassword}
            onChange={setNewPassword}
          />
          <PasswordInput
            id="confirm-password"
            label={t('account.changePassword.confirmPasswordLabel')}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={setConfirmPassword}
          />

          <p className="text-xs text-text-secondary">{t('account.changePassword.requirementsHint', { min: MIN_PASSWORD_LENGTH })}</p>

          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          {success && <p role="status" className="text-sm text-status-success">{t('account.changePassword.success')}</p>}

          <Button type="submit" disabled={mutation.isPending} className="w-fit">
            {mutation.isPending ? t('account.changePassword.saving') : t('account.changePassword.save')}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
