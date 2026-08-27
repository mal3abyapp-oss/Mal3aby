# Auth Session Bootstrap

Root-cause record for the "session lost on refresh" production report investigated 2026-08-27.

## Finding: could not reproduce as currently broken

Investigated the full auth bootstrap flow end-to-end and live-tested against real production (`https://mal3aby.app`, real Supabase project `gxkrtlvpjwxhcqdisyob`) under the three hardest conditions the class of bug described in the bugfix directive would show up in. **None reproduced.** This is documented as an already-fixed state, not left unexplained.

## What the flow actually does

- **Supabase client** (`src/lib/supabase/client.ts`): a single `createClient()` call, no explicit `auth: {...}` override — meaning the SDK's own defaults apply: `persistSession: true`, `autoRefreshToken: true`, `detectSessionInUrl: true`, `storage: window.localStorage`. Only one `createClient()` call exists in real app code (confirmed via search — the only other matches are test files, which construct isolated clients).
- **AuthProvider** (`src/app/providers/AuthProvider.tsx`): on mount, calls `supabase.auth.getSession()` and does **not** set `loading = false` until that resolves. `onAuthStateChange` keeps `session` in sync afterward. This is the standard, correct pattern — `loading` genuinely reflects "have we finished checking whether a session exists yet," distinct from `session === null` ("checked, and there isn't one").
- **Every route guard** (`src/app/routing/RequireAuth.tsx` — `RequireAuth`, `RequireNavDomain`, `RequirePortalAuth`, `RequirePlatformOwner`) begins with `if (loading) return null` before ever evaluating `!session`. None of them can redirect to `/login` while the session is still being resolved.
- **Provider mount order** (`src/App.tsx`): `AuthProvider` wraps `RouterProvider`, so `loading`/`session` are available to every guard before any route renders.

This is exactly the `AUTH_LOADING` / `AUTHENTICATED` / `UNAUTHENTICATED` three-state distinction the bugfix directive describes as the required fix — already implemented, and (per `git log`) built in an earlier session in direct response to a previously-reported instance of this same bug class, not new to this investigation.

## Live reproduction attempts (2026-08-27), all against real production

1. **Mid-session hard refresh** on a protected deep link (`/app/finance/payments`), with a genuine, currently-valid Supabase session already in `localStorage`. Result: stayed on the same route, full data rendered, zero console errors.
2. **True cold-storage new-tab deep link** — the closest real test to "browser restart with remember-me": a brand-new tab (first-ever load of the SPA JS in that tab), `localStorage` fully cleared first and confirmed empty (verified `/app` correctly redirected to `/login` in this state), then a real, valid, currently-unexpired session token written back into `localStorage` exactly as the SDK's own `persistSession` would leave it, then direct navigation to `/app/finance/payments`. Result: no redirect to `/login`, no flash, correct tenant/route context, zero console errors.
3. **Expired access token + invalid refresh token** (the "revoked/disabled user" / "expired session" case): `expires_at` set to one hour in the past, `refresh_token` replaced with a deliberately invalid value, same deep-link navigation. Result: correctly redirected to `/login` — the only console output was the expected `400` from Supabase rejecting the invalid refresh attempt (caught and handled, not a crash).

No scenario produced a login flash, a forced re-login of a still-valid session, or an unhandled error.

## What this means

The specific failure class described — "route guard evaluates 'not authenticated' before Supabase session hydration finishes" — is not present in the code as currently deployed, and does not reproduce under real production conditions. Two honest possibilities, neither of which this investigation can resolve further without more information:

1. This was a real bug in an earlier deploy that has since been fixed (most likely, given the code's own `loading`-gate pattern and the git history showing it was built specifically for this bug class).
2. A different, narrower trigger exists that these three tests didn't happen to hit (e.g. a specific role, a specific timing window relative to a deploy, a specific browser/extension interaction).

If this recurs, the most useful next report would include: the exact account/role affected, whether it happened during or shortly after a deploy, and — if reproducible — the browser console output at the moment of the redirect (none of this investigation's reproduction attempts produced any console output worth inspecting, since none of them redirected incorrectly).

## Not touched

No changes were made to `AuthProvider.tsx`, `RequireAuth.tsx`, `App.tsx`, or the Supabase client config as part of this investigation — nothing here needed fixing.
