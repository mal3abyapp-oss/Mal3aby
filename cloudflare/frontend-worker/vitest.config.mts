import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

// Runs tests INSIDE the real Workers runtime (Miniflare), not a plain
// Node.js mock -- this is what makes the cache-contract tests in
// src/index.test.ts able to assert on REAL Response objects/headers
// produced by the actual Worker code, not source-string matching.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
})
