import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { Button } from '@/components/ui/button'

// Fix for the observed stale-bundle issue (Service Worker
// investigation): 'autoUpdate' alone only checks for a new worker in
// the background -- it never forces an already-open tab to actually
// move onto it, so a tab left open across a deploy can keep serving
// old JS/CSS indefinitely with no visible signal anything is wrong.
//
// This component:
//   1. Registers the service worker and polls for updates every 60s
//      (in addition to the check vite-plugin-pwa already runs on
//      navigation) -- catches an update even in a tab that's never
//      navigated since the deploy.
//   2. Shows a persistent, dismissable-by-action toast the moment a
//      new version is actually installed and waiting -- never a
//      silent skipWaiting()/clientsClaim() swap, which would risk
//      replacing code out from under an in-flight action (mid-payment,
//      mid-form-submit) in a financial app.
//   3. Clicking "Reload" calls updateServiceWorker(true), which
//      activates the waiting worker and reloads the page onto it --
//      the one moment code truly changes under the user is a moment
//      they explicitly chose.
//
// REAL BUG FOUND live in production (2026-08-28), fixed here: a tab
// that already had a worker sitting in the `waiting` state BEFORE this
// component mounted (e.g. a deploy landed while the tab was open, or
// registration timing meant workbox-window's synthetic `waiting` event
// on register() didn't fire the way `useRegisterSW`'s `onNeedRefresh`
// expects) never showed the update toast at all -- `onNeedRefresh` only
// fires in reaction to a live Workbox `waiting` EVENT, never by reading
// existing registration state. Confirmed live:
// `navigator.serviceWorker.getRegistrations()` showed a real `waiting`
// worker with zero visible prompt to the user, on a device serving a
// stale bundle while curl-verified production was already current.
// Fixed by explicitly checking `registration.waiting` right after
// registration and on every visibility/interval check, not only
// reacting to the `waiting` event -- this makes the prompt reliably
// appear for a worker that was already waiting before this component
// ever ran, closing the exact gap that produced the stale-bundle
// symptom without requiring any manual cache/site-data clearing.
export function PwaUpdatePrompt() {
  const { t } = useTranslation()
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return

      const checkForWaitingWorker = () => {
        if (registration.waiting) setNeedRefresh(true)
      }
      // Catches a worker that was ALREADY waiting before this component
      // mounted -- the real gap: useRegisterSW's onNeedRefresh only
      // fires on a live 'waiting' EVENT, never by inspecting existing
      // registration state at startup.
      checkForWaitingWorker()

      // SECOND REAL GAP FOUND (2026-08-29, live report: user had to
      // clear cache/history to see a deploy that had already shipped
      // minutes earlier): the check above only inspects EXISTING
      // registration state -- it never actively asks the browser "is
      // there a newer service worker on the server right now?" On a
      // freshly opened tab (the common case: user opens the app after
      // a deploy landed), there is nothing yet in `.waiting` to find,
      // and the ONLY thing that would have triggered a real network
      // check was the 60s interval below -- so a user who opened the
      // app and didn't leave the tab open for a full minute could
      // navigate the whole session on a stale precached shell with
      // zero visible signal, exactly the reported symptom. Fixed by
      // firing a real update() check immediately on registration too,
      // not only every 60s afterward -- this is a network request
      // (workbox-window's registration.update()), not a local read, so
      // it actually asks the server rather than only reflecting
      // whatever this tab already knew.
      void registration.update().then(checkForWaitingWorker)

      // Explicit periodic check -- vite-plugin-pwa's own default
      // check only fires on page load/navigation, which a
      // long-lived open tab may never do again.
      const interval = setInterval(() => {
        void registration.update().then(checkForWaitingWorker)
      }, 60_000)
      // Registration objects aren't re-created per render, but guard
      // against leaking the interval if this component ever unmounts.
      window.addEventListener('beforeunload', () => clearInterval(interval), { once: true })

      // Belt-and-suspenders: if a worker enters `waiting` at any point
      // after registration (the normal live-update case this component
      // already handled before this fix), still catch it directly
      // rather than relying solely on useRegisterSW's own event wiring.
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            setNeedRefresh(true)
          }
        })
      })
    },
  })

  // Also re-check immediately whenever the tab regains focus/visibility
  // -- catches the common case of a user switching back to a
  // long-backgrounded tab shortly after a deploy.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return
      void navigator.serviceWorker?.getRegistration().then((r) => {
        if (!r) return
        void r.update()
        if (r.waiting) setNeedRefresh(true)
      })
    }
    document.addEventListener('visibilitychange', onVisible)
    onVisible()
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [setNeedRefresh])

  if (!needRefresh) return null

  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-sm items-center justify-between gap-3 rounded-lg border border-border bg-background p-3 shadow-lg sm:inset-x-auto sm:end-4"
    >
      <p className="text-sm">{t('app.updateAvailable')}</p>
      <Button size="sm" onClick={() => updateServiceWorker(true)}>
        {t('app.reload')}
      </Button>
    </div>
  )
}
