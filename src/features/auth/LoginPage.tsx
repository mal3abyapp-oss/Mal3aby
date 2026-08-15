import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// Bug found during Final Pre-Release Verification (2026-08-15): a
// confirmed user with zero club_memberships (never completed onboarding)
// was landing on /app's bare shell with no path forward -- RequireAuth
// only checks for a session, and AppLayout/TodayPage silently no-op when
// currentClubId is null (see docs/ARCHITECTURE.md#signup--onboarding-strategy,
// which already establishes /onboarding as ungated -- the gap was only in
// LoginPage never checking membership count before redirecting). This
// single post-login membership check closes that gap without touching
// the route guards themselves (RequireAuth intentionally stays session-only
// per its own comment -- the real boundary is RLS, not this check).
async function hasAnyActiveMembership(): Promise<boolean> {
  const { count } = await supabase
    .from('club_memberships')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
  return (count ?? 0) > 0
}

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })

    setSubmitting(false)

    if (signInError) {
      // Never surface the raw provider error string (docs pattern: error-state
      // never shows raw DB/HTTP errors) — map to a safe, generic Arabic message.
      setError('بيانات الدخول غير صحيحة، أو الحساب غير مفعّل بعد.')
      return
    }

    const from = (location.state as { from?: Location })?.from?.pathname
    if (from) {
      // Came from a specific protected route (RequireAuth's redirect state)
      // -- honor it as-is, same as before.
      navigate(from, { replace: true })
      return
    }

    const hasClub = await hasAnyActiveMembership()
    navigate(hasClub ? '/app' : '/onboarding', { replace: true })
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm items-center justify-center px-4 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-center text-xl">تسجيل الدخول</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-sm font-medium text-text-secondary">
                البريد الإلكتروني
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-sm font-medium text-text-secondary">
                كلمة المرور
              </label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
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
              {submitting ? 'جارٍ الدخول...' : 'دخول'}
            </Button>

            <div className="flex justify-between text-sm text-text-secondary">
              <Link to="/forgot-password" className="hover:underline">
                نسيت كلمة المرور؟
              </Link>
              <Link to="/signup" className="hover:underline">
                إنشاء حساب جديد
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
