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
    // AUTH RESPONSIVE LAYOUT HOTFIX (2026-08-26): a production design
    // defect confirmed live at 1366x768/1440x900 -- the previous wrapper
    // was `flex` (row-direction) with `justify-center`, which on the main
    // axis centers a flex item at its shrink-to-fit content size rather
    // than stretching it. The Card's own `w-full` had nothing to stretch
    // against, so the whole form collapsed to ~115px-wide inputs inside a
    // ~164px card, floating in a sea of empty viewport, with the customer
    // hint paragraph trapped in that same narrow column below it.
    //
    // Fix: a real two-column desktop composition inside one centered
    // ~980px container (`lg:max-w-[980px]`) -- the customer-portal helper
    // as its own card on one side, the login card on the other, both
    // vertically centered together (`lg:items-center`). Below `lg` (the
    // breakpoint where two ~380px+ columns plus gap would overflow a
    // tablet viewport) it collapses to the original single-column stack,
    // login card first. This intentionally does NOT reuse the row-flex
    // wrapper pattern that caused the bug -- `flex-col` is the base
    // layout, `lg:flex-row` opts into the two-column composition only
    // once there is genuinely enough width for it.
    <div className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col-reverse items-center justify-center gap-6 px-4 py-12 lg:max-w-[980px] lg:flex-row lg:items-center lg:gap-10">
      <Card className="w-full max-w-md shrink-0">
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

            {/* Was `justify-between` on a now-wider card -- fine at the
                old accidental ~164px width where both links happened to
                sit close together, but at a real 384-448px card width
                `justify-between` pushed them to the far edges with a
                large empty gap, and either link wrapping mid-word reads
                as broken. `flex-wrap` + `gap-x-4 gap-y-1` keeps them
                readable as a unit at any width without ever splitting a
                link's own text across lines. */}
            <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-center text-sm text-text-secondary">
              <Link to="/forgot-password" className="whitespace-nowrap hover:underline">
                {t('auth.forgotPassword')}
              </Link>
              <Link to="/signup" className="whitespace-nowrap hover:underline">
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
          the URL) had no way to know this page was even for them.

          AUTH RESPONSIVE LAYOUT HOTFIX: previously a bare paragraph
          floating below the (collapsed, narrow) card with no visual
          relationship to the Login section at all. Now its own bordered
          card, matching the Login card's own visual identity (border/
          radius/shadow via the shared Card component) so the two
          visibly belong to the same auth section -- second column on
          desktop, stacked above the login card on mobile (this is the
          `flex-col-reverse` on the outer wrapper: DOM order keeps the
          login form first for keyboard/screen-reader users, but visually
          the discoverability hint reads first on a phone, matching how a
          customer arriving here is more likely to need the portal
          pointer than the login form itself). */}
      <Card className="w-full max-w-md shrink-0 bg-muted/20 lg:self-center">
        <CardContent className="flex flex-col items-center gap-2 p-6 text-center">
          <p className="text-sm text-text-secondary">{t('auth.customerHint')}</p>
          <Link to="/portal" className="text-sm font-medium text-accent-foreground hover:underline">
            {t('auth.customerHintLink')}
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
