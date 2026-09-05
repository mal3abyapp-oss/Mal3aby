import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18next, { initI18n, LOCALE_STORAGE_KEY } from '@/lib/i18n/config'
import { DirectionProvider } from '@/app/providers/DirectionProvider'
import { HomePage } from './HomePage'
import { PricingPage } from './PricingPage'

// Regression coverage for the 2026-09-06 homepage/pricing-page
// unification: HomePage.tsx's pricing preview used to render every
// public_plans row as its own flat card (6 cards: 3 packages x
// monthly+annual), a real UX inconsistency against PricingPage.tsx's
// correct toggle-driven single-card-per-package model (user-reported
// against live production). Both pages now share one commercial data
// source (usePublicPricing.ts) and one card component (PricingCard.tsx)
// -- this file proves both pages render ONE logical set of package
// cards with a working Monthly/Annual toggle, using the exact approved
// commercial prices, and that neither page can show legacy pricing.

// Real approved plan rows, shaped exactly like public_plans -- the same
// fixture used across both HomePage and PricingPage assertions below,
// so a future price change only needs updating in one place here too.
const REAL_PLAN_ROWS = [
  { id: 'starter-m', name: 'Starter', name_ar: 'الأساسية', description_ar: 'فرع واحد', billing_interval: 'month', billing_interval_count: 1, price: 1790, currency: 'EGP', discount_label: null, features_summary: null, default_grace_period_days: 7, default_branch_limit: 1, default_field_limit: 3, default_academy_limit: 1, default_staff_limit: 5, default_active_player_limit: 300, display_order: 10 },
  { id: 'starter-y', name: 'Starter (Annual)', name_ar: 'الأساسية (سنوي)', description_ar: null, billing_interval: 'year', billing_interval_count: 1, price: 18000, currency: 'EGP', discount_label: 'وفّر 16.2%', features_summary: null, default_grace_period_days: 7, default_branch_limit: 1, default_field_limit: 3, default_academy_limit: 1, default_staff_limit: 5, default_active_player_limit: 300, display_order: 11 },
  { id: 'growth-m', name: 'Growth', name_ar: 'النمو', description_ar: '3 فروع', billing_interval: 'month', billing_interval_count: 1, price: 2990, currency: 'EGP', discount_label: null, features_summary: null, default_grace_period_days: 7, default_branch_limit: 3, default_field_limit: 10, default_academy_limit: 3, default_staff_limit: 15, default_active_player_limit: 1000, display_order: 20 },
  { id: 'growth-y', name: 'Growth (Annual)', name_ar: 'النمو (سنوي)', description_ar: null, billing_interval: 'year', billing_interval_count: 1, price: 30000, currency: 'EGP', discount_label: 'وفّر 16.4%', features_summary: null, default_grace_period_days: 7, default_branch_limit: 3, default_field_limit: 10, default_academy_limit: 3, default_staff_limit: 15, default_active_player_limit: 1000, display_order: 21 },
  { id: 'pro-m', name: 'Pro', name_ar: 'الاحترافية', description_ar: '6 فروع', billing_interval: 'month', billing_interval_count: 1, price: 4990, currency: 'EGP', discount_label: null, features_summary: null, default_grace_period_days: 7, default_branch_limit: 6, default_field_limit: 25, default_academy_limit: 6, default_staff_limit: 40, default_active_player_limit: 3000, display_order: 30 },
  { id: 'pro-y', name: 'Pro (Annual)', name_ar: 'الاحترافية (سنوي)', description_ar: null, billing_interval: 'year', billing_interval_count: 1, price: 50000, currency: 'EGP', discount_label: 'وفّر 16.5%', features_summary: null, default_grace_period_days: 7, default_branch_limit: 6, default_field_limit: 25, default_academy_limit: 6, default_staff_limit: 40, default_active_player_limit: 3000, display_order: 31 },
  // Legacy plans -- must NEVER render on either page, regardless of query success.
  { id: 'legacy-m', name: 'Monthly', name_ar: 'شهري', description_ar: null, billing_interval: 'month', billing_interval_count: 1, price: 499, currency: 'EGP', discount_label: null, features_summary: null, default_grace_period_days: 7, default_branch_limit: 1, default_field_limit: 3, default_academy_limit: 1, default_staff_limit: 5, default_active_player_limit: 300, display_order: 1 },
  { id: 'legacy-y', name: 'Annual', name_ar: 'سنوي', description_ar: null, billing_interval: 'year', billing_interval_count: 1, price: 4499, currency: 'EGP', discount_label: 'وفر 25%', features_summary: null, default_grace_period_days: 7, default_branch_limit: 1, default_field_limit: 3, default_academy_limit: 1, default_staff_limit: 5, default_active_player_limit: 300, display_order: 4 },
]

function makeResolvingQuery(rows: typeof REAL_PLAN_ROWS) {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'order']
  for (const m of methods) {
    chain[m] = vi.fn(() => chain)
  }
  // .order(...) is the terminal call in usePublicPricing.ts's fetch --
  // must itself be thenable so `await` on it resolves.
  chain.then = (resolve: (v: { data: typeof rows; error: null }) => void) => Promise.resolve({ data: rows, error: null }).then(resolve)
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null })) // founding-offer query (PricingPage only) -- absent is a valid, handled state
  return chain
}

const mockFrom = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}))

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <DirectionProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </DirectionProvider>
    </QueryClientProvider>,
  )
}

// MoneyDisplay renders "{amount} {currency}" as ONE text node inside a
// <bdi> (e.g. "١٬٧٩٠٫٠٠ EGP"), so an exact-string match on the amount
// alone never matches. This matches any element whose OWN text content
// (not a parent aggregating multiple descendants) contains the given
// substring -- works for both Arabic-Indic and Western-numeral prices.
function byTextContaining(substring: string) {
  return (_content: string, element: Element | null) => {
    if (!element) return false
    const hasText = (el: Element) => el.textContent?.includes(substring) ?? false
    const childrenDontHaveText = Array.from(element.children).every((child) => !hasText(child))
    return hasText(element) && childrenDontHaveText
  }
}

async function findPrice(substring: string) {
  return screen.findByText(byTextContaining(substring))
}

function queryPrice(substring: string) {
  return screen.queryByText(byTextContaining(substring))
}

describe('Homepage/PricingPage pricing unification', () => {
  beforeAll(async () => {
    await initI18n()
  })

  beforeEach(async () => {
    mockFrom.mockReset()
    mockFrom.mockImplementation(() => makeResolvingQuery(REAL_PLAN_ROWS))
    // DirectionProvider (the actual source of the "en" vs "ar" locale
    // consumed by MoneyDisplay/formatNumberIsolated) reads its own React
    // state from localStorage at mount time, NOT from i18next.language
    // directly -- calling i18next.changeLanguage() alone does not
    // update it. Clearing storage here (deterministic "ar" default,
    // matching readInitialLocale()'s own fallback) is the correct way
    // to reset locale between tests in this file; the English-locale
    // tests below set the storage key explicitly before rendering.
    window.localStorage.removeItem(LOCALE_STORAGE_KEY)
    await i18next.changeLanguage('ar')
  })

  describe('HomePage pricing preview', () => {
    it('1. renders exactly one logical set of package cards (3 packages, not 6 flat rows)', async () => {
      renderWithProviders(<HomePage />)
      await findPrice('١٬٧٩٠')
      // Each package name appears exactly once -- proving one card per
      // package, not a separate monthly-row card and annual-row card.
      expect(screen.getAllByText('الأساسية')).toHaveLength(1)
      expect(screen.getAllByText('النمو')).toHaveLength(1)
      expect(screen.getAllByText('الاحترافية')).toHaveLength(1)
    })

    it('2. defaults to Monthly pricing on first render', async () => {
      renderWithProviders(<HomePage />)
      await findPrice('١٬٧٩٠')
      // Annual prices must NOT be visible before any toggle interaction.
      expect(queryPrice('١٨٬٠٠٠')).not.toBeInTheDocument()
    })

    it('3. Annual toggle updates the SAME cards in place (still exactly 3 package names, now annual prices)', async () => {
      const { container } = renderWithProviders(<HomePage />)
      await findPrice('١٬٧٩٠')

      const annualButtons = screen.getAllByRole('button', { name: /^سنوي$/ })
      const toggleButton = annualButtons.find((b) => container.contains(b))!
      fireEvent.click(toggleButton)

      await findPrice('١٨٬٠٠٠')
      // Still exactly one card per package after the toggle -- not a second set alongside the first.
      expect(screen.getAllByText('الأساسية')).toHaveLength(1)
      expect(screen.getAllByText('النمو')).toHaveLength(1)
      expect(screen.getAllByText('الاحترافية')).toHaveLength(1)
      expect(queryPrice('١٬٧٩٠')).not.toBeInTheDocument()
    })

    it('4/5/6. correct monthly/annual prices and annual discounts render (Starter/Growth/Pro)', async () => {
      const { container } = renderWithProviders(<HomePage />)
      await findPrice('١٬٧٩٠')
      expect(queryPrice('٢٬٩٩٠')).toBeInTheDocument()
      expect(queryPrice('٤٬٩٩٠')).toBeInTheDocument()

      const annualButtons = screen.getAllByRole('button', { name: /^سنوي$/ })
      fireEvent.click(annualButtons.find((b) => container.contains(b))!)

      await findPrice('١٨٬٠٠٠')
      expect(queryPrice('٣٠٬٠٠٠')).toBeInTheDocument()
      expect(queryPrice('٥٠٬٠٠٠')).toBeInTheDocument()
      expect(screen.getByText(/16\.2|١٦٫٢/)).toBeInTheDocument()
      expect(screen.getByText(/16\.4|١٦٫٤/)).toBeInTheDocument()
      expect(screen.getByText(/16\.5|١٦٫٥/)).toBeInTheDocument()
    })

    it('7. Growth remains marked as the recommended/most-popular plan', async () => {
      renderWithProviders(<HomePage />)
      await waitFor(() => expect(screen.getByText('النمو')).toBeInTheDocument())
      expect(screen.getByText('الأكثر اختيارًا')).toBeInTheDocument()
    })

    it('8. Trial remains 14 days', async () => {
      renderWithProviders(<HomePage />)
      await findPrice('١٬٧٩٠')
      expect(screen.getAllByText(/14 يومًا/).length).toBeGreaterThan(0)
    })

    it('9/10. legacy 499/4,499 EGP plans never render, even though they are in the fetched data', async () => {
      renderWithProviders(<HomePage />)
      await findPrice('١٬٧٩٠')
      expect(queryPrice('٤٩٩')).not.toBeInTheDocument()
      expect(queryPrice('٤٬٤٩٩')).not.toBeInTheDocument()
      // Legacy rows' own package name ("شهري"/"سنوي") must not appear as
      // a package card title -- distinct from the billing-cycle toggle
      // buttons, which legitimately show that same text as labels.
      expect(screen.queryAllByText('شهري', { selector: 'p' })).toHaveLength(0)
    })

    it('12. mobile-width interaction: the toggle buttons remain real, clickable, accessible buttons (not just styled divs)', async () => {
      renderWithProviders(<HomePage />)
      await findPrice('١٬٧٩٠')
      const monthlyButtons = screen.getAllByRole('button', { name: /^شهري$/ })
      const annualButtons = screen.getAllByRole('button', { name: /^سنوي$/ })
      expect(monthlyButtons.length).toBeGreaterThan(0)
      expect(annualButtons.length).toBeGreaterThan(0)
      for (const btn of [...monthlyButtons, ...annualButtons]) {
        expect(btn.tagName).toBe('BUTTON')
        expect(btn).not.toHaveAttribute('disabled')
      }
    })
  })

  describe('PricingPage (full page) — still correct after extraction into shared hook/component', () => {
    it('1/2. renders one card per package, Monthly default', async () => {
      renderWithProviders(<PricingPage />)
      await findPrice('١٬٧٩٠')
      expect(screen.getAllByText('الأساسية')).toHaveLength(1)
      expect(queryPrice('١٨٬٠٠٠')).not.toBeInTheDocument()
    })

    it('9/10. legacy plans absent on the dedicated pricing page too', async () => {
      renderWithProviders(<PricingPage />)
      await findPrice('١٬٧٩٠')
      expect(queryPrice('٤٩٩')).not.toBeInTheDocument()
      expect(queryPrice('٤٬٤٩٩')).not.toBeInTheDocument()
    })
  })

  describe('11. English locale', () => {
    it('HomePage renders correct English pricing, toggle, and badge', async () => {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
      renderWithProviders(<HomePage />)
      await findPrice('1,790')
      expect(screen.getByText('Growth')).toBeInTheDocument()
      expect(screen.getByText('Most popular')).toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: /^Monthly$/ }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: /^Annual$/ }).length).toBeGreaterThan(0)
    })

    it('PricingPage renders correct English pricing and Recommended badge', async () => {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
      renderWithProviders(<PricingPage />)
      await findPrice('1,790')
      expect(screen.getByText('Recommended')).toBeInTheDocument()
    })
  })
})
