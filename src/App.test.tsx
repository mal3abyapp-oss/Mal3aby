import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App'
import { initI18n } from './lib/i18n/config'

describe('App', () => {
  // i18n/config.ts (PERF-03 lazy-load fix) resolves its initial locale's
  // resource bundle via a real dynamic import() now, instead of both
  // languages being bundled and ready synchronously at module-import
  // time -- exactly mirroring production, where src/main.tsx awaits
  // initI18n() before its own first render. This suite asserts real
  // translated Arabic text and needs that same guarantee before
  // rendering <App/> (which never calls initI18n() itself -- only
  // src/main.tsx does, deliberately, so importing App/DirectionProvider
  // alone never triggers network/chunk loading as a side effect).
  beforeAll(async () => {
    await initI18n()
  })

  it('renders the public homepage by default', () => {
    render(<App />)
    // Landing page redesign (2026-08-29): matched by a stable substring
    // of the hero headline rather than the full string, since the
    // headline now spans two lines (whitespace-pre-line) -- a partial
    // match keeps this test from breaking on future copy wording
    // tweaks while still proving the real homepage rendered.
    expect(screen.getByText(/نادك، كله، في مكان واحد/)).toBeInTheDocument()
  })

  it('sets document direction to rtl by default', () => {
    render(<App />)
    expect(document.documentElement.dir).toBe('rtl')
  })
})
