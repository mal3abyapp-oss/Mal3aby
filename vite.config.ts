import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // ROOT CAUSE (found 2026-08-27, production auth-refresh + stale-
      // cache bugfix directive): this file's own PREVIOUS comment here
      // claimed "silent skipWaiting()/clientsClaim() was deliberately
      // NOT used" -- that was only ever true of the hand-written
      // PwaUpdatePrompt.tsx UI, not of what actually got built. In
      // vite-plugin-pwa (confirmed by reading its own source,
      // node_modules/vite-plugin-pwa/dist/index.js around the
      // registerType handling): `registerType: 'autoUpdate'`
      // unconditionally sets `workbox.skipWaiting = true` and
      // `workbox.clientsClaim = true` on the GENERATED service worker
      // itself -- confirmed live against the actual deployed
      // https://mal3aby.app/sw.js, whose compiled body calls
      // `self.skipWaiting()` and `clientsClaim()` unconditionally at
      // top level. So every deploy's new service worker installed and
      // took over every open tab's requests IMMEDIATELY and silently,
      // with no coordination with PwaUpdatePrompt's "new version
      // available" toast at all -- the toast's `needRefresh` signal
      // effectively never had anything meaningful left to prompt for
      // by the time a user would see it, and a tab could have its
      // active service worker (and therefore its index.html/asset
      // resolution) swapped out from under it mid-session with zero
      // visible warning, which is also a plausible contributor to the
      // reported "refresh sometimes loses my session" symptom (a
      // mid-navigation SW takeover can race the app's own hydration).
      //
      // FIX: 'prompt' is vite-plugin-pwa's own default and is the mode
      // that does NOT auto-inject skipWaiting/clientsClaim -- the new
      // worker installs and waits (Workbox's normal, safe default)
      // until PwaUpdatePrompt.tsx's own explicit
      // updateServiceWorker(true) call activates it, exactly as this
      // file's comment always claimed but the config didn't actually
      // implement. No other code change was needed: PwaUpdatePrompt.tsx
      // was already written correctly for 'prompt' semantics (periodic
      // update() polling, visibilitychange re-check, explicit
      // reload-on-click) -- it was only ever paired with the wrong
      // registerType.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icons.svg'],
      manifest: {
        name: 'ملعبي | Mal3aby',
        short_name: 'Mal3aby',
        description: 'Club & Academy Operations Platform',
        theme_color: '#0B1220',
        background_color: '#0B1220',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // App shell + static assets only — no offline financial mutation queue,
        // see docs/ARCHITECTURE.md#pwa-strategy
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
