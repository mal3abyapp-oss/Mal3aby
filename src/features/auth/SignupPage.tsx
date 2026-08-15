import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// Supabase Auth's built-in signup flow — no custom password-reset/
// verification system (ADR-041). On success, redirect to /onboarding
// (which itself only requires an authenticated session, not email
// confirmation, so a user with confirmation pending can still proceed if
// email confirmation is disabled/deferred — see PROJECT_STATE.md's known
// gap note on the mailer rate limit).
export function SignupPage() {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsConfirmation, setNeedsConfirmation] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    })

    setSubmitting(false)

    if (signUpError) {
      setError('تعذّر إنشاء الحساب. تأكد من صحة البيانات أو أن البريد غير مستخدم من قبل.')
      return
    }

    if (data.session) {
      navigate('/onboarding', { replace: true })
    } else {
      setNeedsConfirmation(true)
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm items-center justify-center px-4 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-center text-xl">إنشاء حساب جديد</CardTitle>
        </CardHeader>
        <CardContent>
          {needsConfirmation ? (
            <p className="text-center text-sm text-text-secondary">
              تم إنشاء حسابك. يرجى تأكيد بريدك الإلكتروني ثم{' '}
              <Link to="/login" className="text-accent-foreground hover:underline">
                تسجيل الدخول
              </Link>{' '}
              لإكمال إعداد ناديك.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="full-name" className="text-sm font-medium text-text-secondary">
                  الاسم الكامل
                </label>
                <Input id="full-name" required value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="signup-email" className="text-sm font-medium text-text-secondary">
                  البريد الإلكتروني
                </label>
                <Input
                  id="signup-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="signup-password" className="text-sm font-medium text-text-secondary">
                  كلمة المرور
                </label>
                <Input
                  id="signup-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              {error && (
                <p role="alert" className="text-sm text-status-danger">
                  {error}
                </p>
              )}

              <Button type="submit" disabled={submitting} className="mt-2">
                {submitting ? 'جارٍ الإنشاء...' : 'إنشاء حساب وبدء التجربة المجانية'}
              </Button>

              <p className="text-center text-sm text-text-secondary">
                لديك حساب بالفعل؟{' '}
                <Link to="/login" className="text-accent-foreground hover:underline">
                  تسجيل الدخول
                </Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
