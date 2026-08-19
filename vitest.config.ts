import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
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
      '.claude/worktrees/**',
    ],
  },
})
