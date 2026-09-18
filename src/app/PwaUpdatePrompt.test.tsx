import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// Real bug reproduced here (found live in production 2026-08-28): a
// tab whose service worker registration ALREADY has a `.waiting`
// worker at the moment PwaUpdatePrompt mounts must show the update
// toast immediately -- not only in reaction to a live Workbox
// `waiting` EVENT fired during this component's own lifetime. This is
// exactly the state a real deploy leaves an already-open tab in: the
// new worker installs and waits while the tab is open, and by the
// time the app re-renders/re-mounts (e.g. after a client-side route
// change), the worker is already sitting in `.waiting` with no future
// event left to fire.
//
// The default test stub (src/test-mocks/pwa-register-react.ts) is
// deliberately inert and never invokes onRegisteredSW at all, so it
// cannot exercise this path -- this file supplies its own local mock
// of 'virtual:pwa-register/react' that behaves like the real
// vite-plugin-pwa runtime closely enough to prove the fix: it calls
// the real onRegisteredSW callback with a fake registration object
// exposing a pre-populated `.waiting`.
const mockRegistration = {
  waiting: { postMessage: vi.fn() } as unknown as ServiceWorker,
  installing: null,
  active: { state: 'activated' } as unknown as ServiceWorker,
  update: vi.fn().mockResolvedValue(undefined),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}

const setNeedRefreshSpy = vi.fn()
const updateServiceWorkerSpy = vi.fn()

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options?: { onRegisteredSW?: (url: string, registration: unknown) => void }) => {
    // Simulate the real vite-plugin-pwa runtime precisely: the real
    // registerSW() only invokes onRegisteredSW inside a `.then()` on
    // wb.register(...) -- genuinely asynchronous (a real Promise
    // microtask), always AFTER useRegisterSW has already returned and
    // the caller's destructured setNeedRefresh is in scope. Firing it
    // synchronously here (as an earlier draft of this mock did) is not
    // representative of the real library and produces a false
    // TDZ ReferenceError that cannot happen in production -- this
    // queueMicrotask matches the real timing.
    queueMicrotask(() => options?.onRegisteredSW?.('/sw.js', mockRegistration))
    return {
      needRefresh: [true, setNeedRefreshSpy],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: updateServiceWorkerSpy,
    }
  },
}))

// Re-import after the mock is registered.
const { PwaUpdatePrompt } = await import('./PwaUpdatePrompt')

describe('PwaUpdatePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true })
  })

  it('shows the update toast when a worker is already waiting at registration time', async () => {
    render(<PwaUpdatePrompt />)

    // The toast must be visible -- this is the real symptom fixed:
    // previously nothing rendered here because onNeedRefresh never
    // fires for a worker that was already waiting before mount.
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })
  })

  it('registers an updatefound listener as a belt-and-suspenders fallback for future updates', async () => {
    render(<PwaUpdatePrompt />)

    await waitFor(() => {
      expect(mockRegistration.addEventListener).toHaveBeenCalledWith('updatefound', expect.any(Function))
    })
  })

  // Owner directive (2026-09-18): updates must reach users without
  // requiring them to notice/click the toast, but never by silently
  // yanking code out from under an in-flight action (the exact risk
  // the 2026-08-27 fix above guarded against). These two tests prove
  // the two provably-safe auto-activation paths this component adds.
  it('auto-activates the waiting worker the instant the tab is hidden, with no click required', async () => {
    render(<PwaUpdatePrompt />)
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })

    expect(updateServiceWorkerSpy).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(updateServiceWorkerSpy).toHaveBeenCalledWith(true)
  })

  it('auto-activates after a real idle stretch on a visible tab, but not while the user is actively interacting', async () => {
    vi.useFakeTimers()
    try {
      render(<PwaUpdatePrompt />)
      await vi.waitFor(() => {
        expect(screen.getByRole('status')).toBeInTheDocument()
      })

      // Activity resets the idle clock -- still not safe to swap.
      vi.advanceTimersByTime(4 * 60_000)
      window.dispatchEvent(new Event('pointerdown'))
      vi.advanceTimersByTime(4 * 60_000)
      expect(updateServiceWorkerSpy).not.toHaveBeenCalled()

      // A full idle stretch with zero activity: now safe.
      vi.advanceTimersByTime(60_000 + 1)
      expect(updateServiceWorkerSpy).toHaveBeenCalledWith(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
