import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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

// Platform Owner routing fix: a platform_owner previously landed on
// /app (same as any club_owner) and had to manually type /platform --
// reuses the exact same is_platform_owner() RPC RequirePlatformOwner
// itself checks (see RequireAuth.tsx), so this is never a second,
// possibly-drifting definition of "who is a platform owner". Checked
// FIRST, ahead of the club-membership check: a platform_owner who also
// happens to hold a club membership (a real, supported multi-role
// scenario -- see AuthProvider's own dedupe comment) still lands on
// /platform by default. They are never locked out of /app -- the route
// itself has no platform-owner exclusion, so manual navigation to /app
// continues to work exactly as before this change.
async function isPlatformOwner(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_platform_owner')
  if (error) return false
  return data === true
}

// Gate 3 (Unified Accounts): a login with no staff membership is not
// necessarily a prospective club owner who hasn't onboarded yet -- it
// may be a customer/guardian who has claimed (or can claim) a
// self-service link to their own customer record. Route those to the
// customer portal instead of club-creation onboarding.
async function hasAnyLinkedCustomerRecord(): Promise<boolean> {
  const { count } = await supabase
    .from('customers')
    .select('id', { count: 'exact', head: true })
  return (count ?? 0) > 0
}

export function LoginPage() {
  const { t } = useTranslation()
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
      // never shows raw DB/HTTP errors) — map to a safe, generic localized message.
      setError(t('auth.loginError'))
      return
    }

    // P1 production bug (real account report, 2026-08-19): a platform_owner
    // who is ALSO a club_owner (a real, supported multi-role account --
    // see AuthProvider's own dedupe comment) landed on /app instead of
    // /platform after login. Root cause: this `from` location-state check
    // ran BEFORE the platform-owner check below and honored it
    // unconditionally. `from` gets populated by RequireAuth/RequirePortalAuth
    // whenever an unauthenticated (or session-expired) visit to a protected
    // route bounces through /login -- e.g. a stale /app bookmark, or a
    // browser tab left open on /app whose session had expired. For a
    // platform_owner, that stale `from=/app` silently overrode the correct
    // role-based redirect on every subsequent login, since it was checked
    // first and returned immediately.
    //
    // Fix: platform-owner status is checked FIRST, unconditionally -- a
    // platform_owner always lands on /platform by default, regardless of
    // any stale `from` state. `from` is still honored for every other
    // account (customers/club owners/staff bouncing back to the specific
    // page they were trying to reach), and a platform_owner can still
    // navigate to /app manually at any time -- this only changes the
    // POST-LOGIN DEFAULT LANDING, not route access.
    const isOwner = await isPlatformOwner()
    if (isOwner) {
      navigate('/platform', { replace: true })
      return
    }

    const from = (location.state as { from?: Location })?.from?.pathname
    if (from) {
      // Came from a specific protected route (RequireAuth's redirect state)
      // -- honor it as-is, same as before, for every non-platform-owner account.
      navigate(from, { replace: true })
      return
    }

    const hasClub = await hasAnyActiveMembership()
    if (hasClub) {
      navigate('/app', { replace: true })
      return
    }
    const hasCustomerRecord = await hasAnyLinkedCustomerRecord()
    navigate(hasCustomerRecord ? '/portal' : '/onboarding', { replace: true })
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm items-center justify-center px-4 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-center text-xl">{t('auth.login')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-sm font-medium text-text-secondary">
                {t('auth.emailLabel')}
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
                {t('auth.passwordLabel')}
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
              {submitting ? t('auth.loggingIn') : t('auth.login')}
            </Button>

            <div className="flex justify-between text-sm text-text-secondary">
              <Link to="/forgot-password" className="hover:underline">
                {t('auth.forgotPassword')}
              </Link>
              <Link to="/signup" className="hover:underline">
                {t('auth.createNewAccount')}
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
      {/* FINAL PRODUCT COMPLETENESS ROUND (2026-08-25) -- Customer
          persona: this page's own copy only ever framed "create new
          account" as club creation (-> /signup, the club-owner wizard),
          with zero cue that the exact same login form also correctly
          routes an existing customer to their portal (LoginPage's own
          post-auth logic already does this, unchanged by this fix --
          this is purely discoverability, not a routing change, so it
          carries none of the risk of touching that logic). A real
          customer landing here (a WhatsApp link expired, or they typed
          the URL) had no way to know this page was even for them. */}
      <p className="mt-4 text-center text-sm text-text-secondary">
        {t('auth.customerHint')}{' '}
        <Link to="/portal" className="text-accent-foreground hover:underline">
          {t('auth.customerHintLink')}
        </Link>
      </p>
    </div>
  )
}
