// Test-only stub for the "virtual:pwa-register/react" module that
// vite-plugin-pwa injects at build/dev time. That virtual module only
// exists when the VitePWA plugin actually runs, which it deliberately
// does not under Vitest (see vitest.config.ts -- a separate, minimal
// config from vite.config.ts). Service worker registration has no
// meaningful behavior under jsdom anyway, so this stub returns inert
// state: no update ever "needs" a refresh in tests.
export function useRegisterSW(_options?: unknown) {
  return {
    needRefresh: [false, () => {}] as [boolean, (v: boolean) => void],
    offlineReady: [false, () => {}] as [boolean, (v: boolean) => void],
    updateServiceWorker: async (_reloadPage?: boolean) => {},
  }
}
