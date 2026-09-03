import { describe, it, expect, beforeEach, vi } from 'vitest'

// PERF-03 (bundle-size audit) regression test: src/lib/i18n/config.ts
// used to import BOTH ar/common.json and en/common.json at module scope
// and bundle both into i18next's resources on init, unconditionally --
// 126.5KB gzip (36% of the whole main chunk) shipped to every visitor
// regardless of which language they'd ever see. The fix makes initI18n()
// load only the resolved initial locale's resource bundle; the other
// locale is registered lazily, only once something actually switches to
// it. This test proves that shape directly against the real module
// (not a mock) -- each test gets a FRESH module instance (vi.resetModules
// + dynamic import inside the test) so one test's initI18n() call can't
// leak into another's "nothing loaded yet" assertion, and controls
// window.localStorage/navigator directly to make the detected locale
// deterministic instead of depending on jsdom's environment defaults.
describe('i18n/config.ts — lazy locale bundle loading (PERF-03)', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
  })

  it('after initI18n() resolves, only the detected initial locale (ar, the default with no stored/English-navigator signal) has a registered resource bundle -- English is NOT loaded', async () => {
    vi.stubGlobal('navigator', { language: 'ar-EG', languages: ['ar-EG'] })
    const { initI18n } = await import('./config')
    const i18n = await initI18n()

    expect(i18n.hasResourceBundle('ar', 'common')).toBe(true)
    expect(i18n.hasResourceBundle('en', 'common')).toBe(false)
  })

  it('for an English-detected environment, initI18n() loads English immediately plus Arabic as the configured fallbackLng -- this is the one case both load, and it is deliberate (fallback text must never be missing), not a regression of the "only the active locale" fix', async () => {
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
    const { initI18n } = await import('./config')
    const i18n = await initI18n()

    expect(i18n.hasResourceBundle('en', 'common')).toBe(true)
    expect(i18n.hasResourceBundle('ar', 'common')).toBe(true)
  })

  it('switching language via changeLanguage() lazily loads the alternate locale on demand, and it stays loaded afterwards', async () => {
    vi.stubGlobal('navigator', { language: 'ar-EG', languages: ['ar-EG'] })
    const { initI18n } = await import('./config')
    const i18n = await initI18n()

    expect(i18n.hasResourceBundle('en', 'common')).toBe(false)

    await i18n.changeLanguage('en')

    expect(i18n.hasResourceBundle('en', 'common')).toBe(true)
    expect(i18n.language).toBe('en')
    // Real translated text is now available, not a raw/missing key.
    expect(i18n.t('errorBoundary.title')).not.toBe('errorBoundary.title')
  })

  it('respects an explicit prior localStorage choice over navigator detection for which locale loads first', async () => {
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
    window.localStorage.setItem('mala3by.locale', 'ar')
    const { initI18n } = await import('./config')
    const i18n = await initI18n()

    expect(i18n.hasResourceBundle('ar', 'common')).toBe(true)
    expect(i18n.hasResourceBundle('en', 'common')).toBe(false)
  })
})
