import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  // PRODUCTION MONITORING (Phase 3, 2026-08-28): src/lib/version.ts
  // reads __MAL3ABY_BUILD_SHA__/__MAL3ABY_BUILD_TIME__, two compile-time
  // constants vite.config.ts injects via ITS OWN `define` block for the
  // real production build -- vitest.config.ts is a genuinely SEPARATE
  // Vite config (confirmed: vitest reads this file, not vite.config.ts)
  // and never inherited that block, so these constants were always
  // undefined under a test run. This went unnoticed until now because
  // nothing reachable from a component under test happened to import
  // version.ts -- ErrorBoundary's new incident-id/build-SHA display
  // (see src/components/ui/error-boundary.tsx) is the first thing that
  // does, via src/lib/errorReporting.ts, which surfaced the gap via
  // src/App.test.tsx (ReferenceError: __MAL3ABY_BUILD_SHA__ is not
  // defined). Fixed at the actual source (this config), not worked
  // around in the new files -- deterministic fixed strings are correct
  // here since no test asserts on a real git SHA/timestamp.
  define: {
    __MAL3ABY_BUILD_SHA__: JSON.stringify('test'),
    __MAL3ABY_BUILD_TIME__: JSON.stringify('1970-01-01T00:00:00.000Z'),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // vite-plugin-pwa's virtual module only exists when the VitePWA
      // plugin runs, which this config deliberately omits (see below)
      // -- redirect to an inert local stub so components importing it
      // (PwaUpdatePrompt.tsx) don't break test collection.
      'virtual:pwa-register/react': path.resolve(__dirname, './src/test-mocks/pwa-register-react.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // Master IA/UX audit (test architecture cleanup): vitest's default
    // include glob (`**/*.{test,spec}.*`) walks the whole repo tree
    // unless overridden, so it was reaching into `whatsapp-connector/`
    // (a fully independent Node subproject with its own `tsx`-based
    // self-test runner, not vitest -- see whatsapp-connector/src/
    // templates.test.ts, which has no describe/it blocks and is meant
    // to run standalone via `npx tsx`) and into stale `.claude/
    // worktrees/**` checkouts (duplicate copies of src/App.test.tsx
    // that were being discovered and counted twice). Setting `test.
    // exclude` REPLACES vitest's built-ins rather than extending them,
    // so the standard defaults are repeated here alongside the two
    // real additions.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{vite,vitest}.config.*',
      'whatsapp-connector/**',
      // Same class of problem as whatsapp-connector/ above --
      // cloudflare/email-worker/ is its own independent Node subproject
      // with its own tsx-based self-test runner (src/templates.test.ts,
      // plain node:assert, no describe/it blocks), not vitest.
      'cloudflare/**',
      '.claude/worktrees/**',
      // Same class of problem as whatsapp-connector/ above -- QA scratch
      // scripts and any subproject fixtures a session drops here are not
      // part of this app's test suite (and .codex-temp/ is gitignored
      // entirely, so it should never affect a real CI run either).
      '.codex-temp/**',
    ],
  },
})
