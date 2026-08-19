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
export function PwaUpdatePrompt() {
  const { t } = useTranslation()
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return
      // Explicit periodic check -- vite-plugin-pwa's own default
      // check only fires on page load/navigation, which a
      // long-lived open tab may never do again.
      const interval = setInterval(() => {
        void registration.update()
      }, 60_000)
      // Registration objects aren't re-created per render, but guard
      // against leaking the interval if this component ever unmounts.
      window.addEventListener('beforeunload', () => clearInterval(interval), { once: true })
    },
  })

  // Also re-check immediately whenever the tab regains focus/visibility
  // -- catches the common case of a user switching back to a
  // long-backgrounded tab shortly after a deploy.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') {
        void navigator.serviceWorker?.getRegistration().then((r) => r?.update())
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

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
