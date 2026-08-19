import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Root cause of the observed stale-bundle issue: 'autoUpdate'
      // only auto-CHECKS for a new service worker in the background --
      // it does not force an already-open tab to actually swap onto
      // it (Workbox leaves the new worker 'waiting' until every tab
      // running the old one closes). A tab left open across a deploy
      // could therefore keep serving stale JS/CSS indefinitely, with
      // no signal to the user that anything was wrong.
      //
      // Fix (smallest correct one, not a blind cache disable): keep
      // 'autoUpdate' for the background check, but pair it with an
      // explicit periodic update check + a visible "new version
      // available" prompt (see src/app/PwaUpdatePrompt.tsx) that lets
      // the user reload onto the new version deliberately. Silent
      // skipWaiting()/clientsClaim() was deliberately NOT used here --
      // for a financial app, forcing a code swap out from under an
      // in-flight action (mid-payment, mid-form-submit) is worse than
      // a brief prompt asking the user to reload.
      registerType: 'autoUpdate',
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
