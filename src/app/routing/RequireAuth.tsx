import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { lazy, Suspense, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/app/providers/AuthProvider'
import { canSeeNavDomain, type NavDomain } from '@/lib/domain/navigation'
import { Button } from '@/components/ui/button'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'

// Real production bug report (2026-08-29): a user with a genuinely
// valid, non-expired session navigated back to "/" (the marketing
// landing page) and saw the logged-out marketing/login CTAs, which
// they reasonably read as "I've been signed out" -- confirmed live
// that the session was NOT actually cleared (localStorage still held
// a valid, unexpired sb-...-auth-token; supabase.auth.getSession()
// still resolved it). The real bug: "/" and "/login"/"/signup" never
// checked whether a session already existed at all -- PublicLayout's
// route group renders the marketing/auth chrome unconditionally for
// any visitor, authenticated or not, so an already-logged-in user
// bookmarking or re-navigating to "/" (or "/login") just sees the
// guest-facing page with no redirect anywhere, indistinguishable from
// an actual logout.
//
// Guards the guest-only routes ("/", "/login", "/signup") the same
// way RequireAuth guards the authenticated ones, just inverted: an
// existing session means "you don't belong on this page", not "show
// it anyway". Reuses the exact same destination-resolution order
// LoginPage's own post-submit navigate() already established
// (platform owner -> /platform, active club membership -> /app,
// linked customer record -> /portal, else -> /onboarding) via the same
// three RPCs, so a returning already-authenticated visitor lands
// exactly where a fresh login would have sent them -- no second,
// possibly-drifting definition of "where does this account belong".
async function resolveAuthenticatedDestination(): Promise<string> {
  const { data: ownerData, error: ownerError } = await supabase.rpc('is_platform_owner')
  if (!ownerError && ownerData === true) return '/platform'

  const { count: clubCount } = await supabase
    .from('club_memberships')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
  if ((clubCount ?? 0) > 0) return '/app'

  const { count: customerCount } = await supabase
    .from('customers')
    .select('id', { count: 'exact', head: true })
  return (customerCount ?? 0) > 0 ? '/portal' : '/onboarding'
}

export function RequireGuest() {
  const { session, loading } = useAuth()
  const location = useLocation()
  const { data: destination, isLoading: resolving } = useQuery({
    queryKey: ['guest-guard-destination', session?.user.id],
    queryFn: resolveAuthenticatedDestination,
    enabled: !!session,
  })

  // Deliberately NOT gated on `loading` the way RequireAuth/RequirePlatformOwner
  // are -- those protect a page that must never flash its authenticated
  // content before a session is confirmed, so blocking on `loading` there
  // is the safe default. Here it is backwards: "/" is the very first
  // thing an anonymous visitor sees, the overwhelming majority of hits,
  // and it has nothing sensitive to hide -- forcing it to wait on
  // AuthProvider's own getSession() round-trip (a real async microtask
  // even when there is no session at all) would regress every anonymous
  // visitor's first paint to fix a redirect that only matters for the
  // rare already-authenticated case. Instead: render the guest page
  // immediately by default, and only ever redirect once `loading` is
  // done AND a real session is confirmed -- so an anonymous visit is
  // exactly as fast as before this guard existed, while an
  // authenticated visit still gets redirected the moment that becomes
  // knowable (one render later, not on first paint).
  if (loading || !session) return <Outlet />

  // A stale `from` location (e.g. an old bookmark to a protected route
  // whose session had expired, later resolved by a fresh login) can
  // still legitimately name a real destination -- honor it exactly
  // like LoginPage's own post-submit logic already does, before
  // falling back to the role-based default.
  const from = (location.state as { from?: Location })?.from?.pathname
  if (from) return <Navigate to={from} replace />

  // Session confirmed but destination not resolved yet -- still render
  // the guest page rather than a blank screen; the redirect below fires
  // the moment resolveAuthenticatedDestination() resolves.
  if (resolving || !destination) return <Outlet />

  return <Navigate to={destination} replace />
}

const ClaimAccountPageLazy = lazy(() =>
  import('@/features/portal/ClaimAccountPage').then((m) => ({ default: m.ClaimAccountPage })),
)

// Guards /app and /platform. Client-side redirect only — the real security
// boundary is always RLS on the server (docs/SECURITY_ANTI_FRAUD.md); this
// just prevents rendering an authenticated shell with no session.
export function RequireAuth() {
  const { session, loading } = useAuth()
  const location = useLocation()

  if (loading) return null

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <Outlet />
}

// Mirrors the role-aware navigation at the routing boundary. RLS remains the
// data-security boundary, but a user must not bypass the product role matrix
// merely by typing a hidden URL directly.
//
// DUAL-IDENTITY STAFF + CUSTOMER AUTH AUDIT (2026-08-25): a genuinely
// zero-membership account (a customer-only auth session with no
// club_membership row at all) hitting /app used to hit an infinite
// self-redirect loop. canSeeNavDomain(undefined, ...)'s "unrecognized
// role -> permissive" fallback (see navigation.ts) can't distinguish "no
// role at all" from "a role this nav matrix doesn't know about", so the
// old redirect target computation (canSeeNavDomain(currentMembership?.
// roleKey, 'today') ? '/app' : '/scan') resolved to '/app' for a null
// currentMembership -- and /app's own index route is itself wrapped in
// RequireNavDomain domain="today", so the redirect pointed straight back
// at the component currently rendering it, on every remount. This never
// leaked any data (RLS was never in question -- this is client-side
// routing only, per this file's own header comment), but it is a real,
// silently-broken UX: a customer-only account got a frozen/looping
// screen instead of the explicit "no club access" state the audit's own
// section 4 requires ("BLOCKED بالكامل ... لا تعتمد على UI hiding" --
// this fixes the UI side of that; RLS already enforces the real
// boundary, proven separately in dual-identity-email-isolation.
// integration.test.ts).
export function RequireNavDomain({ domain, children }: { domain: NavDomain; children: ReactNode }) {
  const { loading, currentMembership, memberships, signOut, supportSession } = useAuth()
  const { t } = useTranslation()

  if (loading) return null

  // Zero real memberships -- not "an unrecognized role", a genuine
  // customer-only (or freshly-deauthorized) account with nothing to
  // route into. Render an explicit terminal state instead of computing
  // a redirect target that can point back at the very route currently
  // rendering it.
  //
  // MASTER ADMIN / PLATFORM SUPPORT CONTEXT: a platform_owner (or, once
  // Platform Staff exists, any platform employee) can legitimately have
  // ZERO real club_memberships rows of their own -- that is the clean,
  // correct shape for a pure platform-side account, not an error state.
  // `memberships` here is only ever the platform_owner's OWN real
  // club_memberships rows (AuthProvider never mixes support-session
  // state into it) -- an active supportSession must bypass this
  // "no club access" terminal state entirely, since currentMembership is
  // already correctly synthesized for the supported club in that case.
  if (memberships.length === 0 && !supportSession) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-sm text-text-secondary">{t('routing.noClubAccess')}</p>
        <Button variant="outline" onClick={() => void signOut()}>
          {t('routing.signOut')}
        </Button>
      </div>
    )
  }

  if (!currentMembership || !canSeeNavDomain(currentMembership.permissionKeys, domain)) {
    return <Navigate to={canSeeNavDomain(currentMembership?.permissionKeys, 'today') ? '/app' : '/scan'} replace />
  }

  return children
}

// Guards /portal (the customer/guardian self-service area, Gate 3).
// Session-only, same as RequireAuth — a customer never needs a
// club_membership row (that would incorrectly grant staff-side RLS
// access). The real boundary is still RLS: customers_self_service_*
// policies scoped to customers.user_id = auth.uid().
export function RequirePortalAuth() {
  const { session, loading } = useAuth()
  const location = useLocation()

  if (loading) return null

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <Outlet />
}

// PERSONA COUNCIL AUDIT (2026-08-25) — Customer persona, P0 finding: this
// guard closes the "claim-gate bypass" dead end. The claim-vs-dashboard
// check used to live ONLY inline in PortalRoot, on the bare /portal index
// route — router.tsx's own prior comment on the sibling routes ("this
// route bypasses that gate entirely since reaching it at all requires
// RequirePortalAuth, which already implies a linked customer record
// exists") was simply false: RequirePortalAuth only checks session
// existence, never customer linkage. A real, live-reproduced account with
// a valid session but zero customers.user_id link got a DIFFERENT,
// misleading "empty" screen on every /portal/* sub-route (bookings: "no
// bookings yet", academy: "no players linked", profile: "no data linked
// to your account") with no path back to the one screen that would have
// explained why and offered the fix — a genuine dead end, not merely an
// empty state.
//
// This guard now wraps the WHOLE /portal subtree (every child of
// PortalLayout, index route included) so the claim gate is structurally
// impossible to bypass via a different sub-route, bookmark, deep link, or
// the bottom nav. Uses the same get_my_portal_customers() RPC as
// PortalClubProvider/PortalRoot -- SECURITY DEFINER, checks
// customers.user_id = auth.uid() directly, never RLS's OR-combined
// policy set (see the cross-persona authorization fix). This is a
// client-side UX guard only, same disclosure as every guard in this file
// -- RLS already independently enforces that an unlinked session can
// never read another customer's data regardless of this guard.
export function RequirePortalCustomer({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const { data: linkedCount, isLoading } = useQuery({
    queryKey: ['portal', 'linked-customer-count'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_my_portal_customers')
      if (error) throw error
      return (data ?? []).length
    },
  })

  if (isLoading) return null

  if (!linkedCount || linkedCount === 0) {
    return (
      <Suspense fallback={null}>
        <ClaimAccountPageLazy
          onClaimed={() => {
            void queryClient.invalidateQueries({ queryKey: ['portal'] })
          }}
        />
      </Suspense>
    )
  }

  return children
}

// Real gap found in live QA (2026-08-30), confirmed against
// set_club_module_active()'s actual live permission check before
// building this (has_permission('club.update', p_club_id) alone is
// already sufficient -- no backend change needed, this UI was simply
// missing): a club whose module is entitled but not yet ACTIVE showed
// this exact "not activated" screen telling the owner to go activate
// it -- but that instruction was unreachable, since this screen IS
// what replaces the entire /app/shop (or /app/academy, /app/fields,
// /app/memberships) subtree, including that module's own Settings
// page, whenever active=false. A club owner had no way to reach any
// activation control at all without a Platform Owner or a raw SQL
// call. This button closes that loop directly from the blocked screen
// itself -- gated on the same club.update permission the RPC already
// requires, so a staff member without that permission simply doesn't
// see it (still correctly told to contact their owner).
function ActivateModuleButton({ moduleKey, queryKey }: { moduleKey: string; queryKey: readonly unknown[] }) {
  const { t } = useTranslation()
  const { currentClubId, currentMembership } = useAuth()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const canActivate = currentMembership?.permissionKeys.includes('club.update') ?? false

  const activateMutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('set_club_module_active', {
        p_club_id: currentClubId as string,
        p_module_key: moduleKey,
        p_active: true,
      })
      if (err) throw err
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey })
    },
    onError: (err) => setError(translateSupabaseError(err, t('routing.moduleActivateError'))),
  })

  if (!canActivate) return null

  return (
    <div className="mt-2 flex flex-col items-center gap-2">
      <Button size="sm" disabled={activateMutation.isPending} onClick={() => activateMutation.mutate()}>
        {activateMutation.isPending ? t('routing.moduleActivating') : t('routing.moduleActivateNow')}
      </Button>
      {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
    </div>
  )
}

// COMMERCIAL MODULE (2026-08-26) -- guards every /app/shop/* route.
// canSeeNavDomain('shop', ...) (RequireNavDomain, already applied at
// the route level) only checks the shop.view PERMISSION -- a
// completely separate concern from whether the Shop module is actually
// entitled+active for THIS club (COMMERCIAL_DOMAIN_ARCHITECTURE.md
// Section 3's two-level model). A staff member could hold shop.view
// yet the club owner never turned Shop on, or the platform never
// entitled it -- this guard is what shows the real "not available"
// state instead of an empty/broken product list. Same disclosure as
// every guard in this file: RLS/RPC's own _shop_module_active() check
// inside every write RPC remains the real security boundary; this is
// UX only.
function RequireShopModule({ children }: { children: ReactNode }) {
  const { currentClubId } = useAuth()
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({
    queryKey: ['shop-module-state', currentClubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_club_modules', { p_club_id: currentClubId as string })
      if (error) throw error
      return (data ?? []).find((m) => m.module_key === 'shop') ?? null
    },
    enabled: !!currentClubId,
  })

  if (isLoading) return null

  if (!data || !data.entitled || !data.active) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-lg font-medium text-text-primary">{t('shop.moduleNotActive.title')}</p>
        <p className="max-w-sm text-sm text-text-secondary">
          {!data || !data.entitled ? t('shop.moduleNotActive.notEntitled') : t('shop.moduleNotActive.notActivated')}
        </p>
        {data?.entitled && !data.active && (
          <ActivateModuleButton moduleKey="shop" queryKey={['shop-module-state', currentClubId]} />
        )}
      </div>
    )
  }

  return children
}

export { RequireShopModule }

// PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 3 (P2): the same
// route-level "not available" UX RequireShopModule already gives Shop,
// generalized for Academy/Fields/Club Membership now that Phase 1/2 of
// this program gave those modules the same real RPC-layer enforcement
// Shop already had (_academy_module_active/_fields_module_active/
// _club_membership_module_active). Same disclosure as RequireShopModule:
// this is UX only, not the security boundary -- the RPC-layer check
// inside every write RPC is what actually enforces the module state.
function RequireModule({ moduleKey, titleKey, notEntitledKey, notActivatedKey, children }: {
  moduleKey: string
  titleKey: string
  notEntitledKey: string
  notActivatedKey: string
  children: ReactNode
}) {
  const { currentClubId } = useAuth()
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({
    queryKey: ['module-state', moduleKey, currentClubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_club_modules', { p_club_id: currentClubId as string })
      if (error) throw error
      return (data ?? []).find((m) => m.module_key === moduleKey) ?? null
    },
    enabled: !!currentClubId,
  })

  if (isLoading) return null

  if (!data || !data.entitled || !data.active) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-lg font-medium text-text-primary">{t(titleKey)}</p>
        <p className="max-w-sm text-sm text-text-secondary">
          {!data || !data.entitled ? t(notEntitledKey) : t(notActivatedKey)}
        </p>
        {data?.entitled && !data.active && (
          <ActivateModuleButton moduleKey={moduleKey} queryKey={['module-state', moduleKey, currentClubId]} />
        )}
      </div>
    )
  }

  return children
}

function RequireAcademyModule({ children }: { children: ReactNode }) {
  return (
    <RequireModule
      moduleKey="academy"
      titleKey="academy.moduleNotActive.title"
      notEntitledKey="academy.moduleNotActive.notEntitled"
      notActivatedKey="academy.moduleNotActive.notActivated"
    >
      {children}
    </RequireModule>
  )
}

function RequireFieldsModule({ children }: { children: ReactNode }) {
  return (
    <RequireModule
      moduleKey="fields"
      titleKey="bookings.moduleNotActive.title"
      notEntitledKey="bookings.moduleNotActive.notEntitled"
      notActivatedKey="bookings.moduleNotActive.notActivated"
    >
      {children}
    </RequireModule>
  )
}

function RequireClubMembershipModule({ children }: { children: ReactNode }) {
  return (
    <RequireModule
      moduleKey="club_membership"
      titleKey="clubMemberships.moduleNotActive.title"
      notEntitledKey="clubMemberships.moduleNotActive.notEntitled"
      notActivatedKey="clubMemberships.moduleNotActive.notActivated"
    >
      {children}
    </RequireModule>
  )
}

export { RequireAcademyModule, RequireFieldsModule, RequireClubMembershipModule }

// Guards /platform specifically — requires the platform_owner role on at
// least one active membership. Real enforcement is still server-side
// (public.is_platform_owner() SECURITY DEFINER + RLS policies); this only
// prevents rendering the console shell for non-owners.
export function RequirePlatformOwner() {
  const { session, loading, isPlatformOwner } = useAuth()
  const location = useLocation()

  if (loading) return null

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (!isPlatformOwner) {
    return <Navigate to="/app" replace />
  }

  return <Outlet />
}
