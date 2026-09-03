import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DirectionProvider } from '@/app/providers/DirectionProvider'
import { initI18n } from '@/lib/i18n/config'
import { FormattedDate, FormattedNumber } from './formatted-date'
import { FormattedCurrency } from './formatted-currency'

// i18next is now initialized lazily via initI18n() (see lib/i18n/config.ts's
// own PERF-03 comment) rather than synchronously at module load, so tests
// that mount <DirectionProvider> -- which calls i18n.changeLanguage() in an
// effect -- must await initialization first, or that call throws.
beforeAll(async () => {
  await initI18n()
})

// Production audit finding H-1 (RTL-bidi gap): lib/i18n/config.ts's
// formatDate()/formatCurrency()/formatNumber() return plain strings
// with no bidi isolation, unlike MoneyDisplay (money-display.tsx),
// which has always wrapped its output in <bdi>. This exact defect
// class was fixed piecemeal ~10 times across billing, reports,
// dashboard, WhatsApp activity/audit logs, and the public invoice-
// verification page before FormattedDate/FormattedCurrency/
// FormattedNumber existed to fix it once, at the root. These tests
// assert the actual DOM structure (a real <bdi> element wrapping the
// formatted value) rather than just the text content, since a
// same-text assertion would pass even if the isolation wrapper were
// silently dropped again -- the exact regression this defect class
// keeps recurring as.
describe('FormattedDate / FormattedCurrency / FormattedNumber (H-1 bidi isolation)', () => {
  it('FormattedDate renders its formatted value inside a real <bdi> element', () => {
    render(
      <DirectionProvider>
        <FormattedDate value="2026-09-03T10:00:00Z" timeZone="Africa/Cairo" options={{ day: 'numeric', month: 'long', year: 'numeric' }} />
      </DirectionProvider>,
    )
    // jsdom's navigator-based language detection resolves to English in
    // this test environment (the same documented behavior LoginPage.test.tsx/
    // PortalLoginPage.test.tsx already rely on -- see config.ts's own
    // detectInitialLocale() comment), so the assertion checks for the
    // formatted value being present inside a real <bdi> rather than
    // asserting a specific locale's digit script -- the DOM structure is
    // what this test exists to guard, not which locale rendered first.
    const bdi = document.querySelector('bdi')
    expect(bdi).not.toBeNull()
    expect(bdi?.textContent).toBeTruthy()
    expect(bdi?.textContent).toMatch(/2026|٢٠٢٦/)
  })

  it('FormattedDate renders the em-dash fallback (not a <bdi>) when value is null', () => {
    render(
      <DirectionProvider>
        <FormattedDate value={null} timeZone="Africa/Cairo" />
      </DirectionProvider>,
    )
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(document.querySelector('bdi')).toBeNull()
  })

  it('FormattedCurrency renders its formatted value inside a real <bdi> element', () => {
    render(
      <DirectionProvider>
        <FormattedCurrency value={1250} />
      </DirectionProvider>,
    )
    const bdi = document.querySelector('bdi')
    expect(bdi).not.toBeNull()
    expect(bdi?.textContent).toBeTruthy()
    // The formatted amount (1,250 or its Arabic-Indic equivalent
    // ١٬٢٥٠) must be present inside the <bdi> -- bidi isolate marks
    // wrap the text but never alter the digits themselves.
    expect(bdi?.textContent).toMatch(/1,250|١٬٢٥٠/)
  })

  it('FormattedCurrency renders the em-dash fallback (not a <bdi>) when value is null', () => {
    render(
      <DirectionProvider>
        <FormattedCurrency value={null} />
      </DirectionProvider>,
    )
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(document.querySelector('bdi')).toBeNull()
  })

  it('FormattedNumber renders its formatted value inside a real <bdi> element', () => {
    render(
      <DirectionProvider>
        <FormattedNumber value={220} />
      </DirectionProvider>,
    )
    const bdi = document.querySelector('bdi')
    expect(bdi).not.toBeNull()
    expect(bdi?.textContent).toBeTruthy()
  })
})
