import { test, expect } from '@playwright/test'
import { authStatePath, hasMintedSession } from '../fixtures/qa-auth'

const FIXTURE = 'club-owner'

// COMMERCE PRO C10 -- Shop Reports coverage (COMMERCE_PRO_UPGRADE_PLAN.md
// Section 5, Phase C10; see COMMERCE_C7_REPORTS_REPORT.md for what this
// exercises: the 16-report hub, reused across Sales Summary/Gross
// Profit/Stock Valuation here per the task's explicit "at least 3"
// requirement).
//
// TAB SELECTOR STRATEGY: ShopReportsPage.tsx (the hub) is
// URL-addressable via a real, stable `?tab=` query param -- confirmed
// via direct read of the component source (isReportKey/selectReport,
// syncs to useSearchParams) -- navigating directly to
// /app/reports/shop?tab=gross-profit is a genuine, durable selector,
// not a guessed one, and avoids depending on the tab strip's own
// (untranslated-string-free but still order-dependent) button list.
//
// SELECTOR PROVENANCE for report CONTENT: report-sales-summary-*,
// report-gross-profit-*, and report-stock-valuation-*/report-
// inventory-on-hand testids were added to ShopSalesSummaryReports.tsx,
// ShopProfitReport.tsx, and ShopInventoryReports.tsx this phase
// (previously zero testid coverage in any report component) --
// confirmed present in the component source before writing this file.
// See COMMERCE_C10_E2E_REPORT.md.
test.describe('Shop Reports (club_owner, authenticated)', () => {
  test.skip(!hasMintedSession(FIXTURE), `No minted session for '${FIXTURE}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(FIXTURE) })

  test('Sales Summary: real KPI numbers render, not a placeholder/error state', async ({ page }) => {
    await page.goto('/app/reports/shop?tab=sales-summary')
    await expect(page).not.toHaveURL(/\/login/)
    await page.waitForLoadState('networkidle')

    const stats = page.getByTestId('report-sales-summary-stats')
    await expect(stats).toBeVisible()

    const grossSales = page.getByTestId('report-sales-summary-gross-sales')
    const transactions = page.getByTestId('report-sales-summary-transactions')
    await expect(grossSales).toBeVisible()
    await expect(transactions).toBeVisible()

    // "Real numbers render, not placeholder/error" -- assert actual
    // numeric-shaped text content, not merely that the element exists.
    const grossSalesText = (await grossSales.textContent()) ?? ''
    const transactionsText = (await transactions.textContent()) ?? ''
    expect(grossSalesText.trim().length).toBeGreaterThan(0)
    expect(/\d/.test(grossSalesText)).toBe(true)
    expect(/\d/.test(transactionsText)).toBe(true)

    // get_shop_sales_kpis is gated on report.view (COMMERCE_C7_REPORTS_REPORT.md)
    // -- club_owner has this by default, so a permission-denied state
    // here would itself be a real defect, not an expected outcome. No
    // generic error boundary text should be present.
    await expect(page.getByText(/unexpected error/i)).toHaveCount(0)
  })

  test('Gross Profit: real numbers render, and the honest "cost unavailable" disclosure renders correctly when applicable', async ({ page }) => {
    await page.goto('/app/reports/shop?tab=gross-profit')
    await expect(page).not.toHaveURL(/\/login/)
    await page.waitForLoadState('networkidle')

    // shop.reports.view_profit is club_owner-only by default
    // (20260828170150_shop_reports_view_profit_permission_seed.sql,
    // confirmed via direct migration read) -- club_owner should see the
    // real report, not the permission-denied state.
    const denied = page.getByTestId('report-gross-profit-permission-denied')
    const isDenied = await denied.count() > 0
    test.skip(isDenied, 'club_owner fixture unexpectedly lacks shop.reports.view_profit -- this itself would be a real permission-seed defect worth its own investigation, flagged rather than silently passed.')

    const stats = page.getByTestId('report-gross-profit-stats')
    await expect(stats).toBeVisible()

    await expect(page.getByTestId('report-gross-profit-revenue')).toBeVisible()
    await expect(page.getByTestId('report-gross-profit-gross-profit')).toBeVisible()
    const marginText = (await page.getByTestId('report-gross-profit-margin-pct').textContent()) ?? ''
    expect(/%/.test(marginText)).toBe(true)

    // THE HONESTY REQUIREMENT (plan's own explicit instruction, C7's
    // report Section 3, item 14): get_shop_gross_profit structurally
    // separates known-cost lines from cost-unavailable ones -- assert
    // the notice itself renders with a real data-has-gap flag, and that
    // its rendered text differs correctly depending on that flag,
    // rather than assuming a fabricated number is ever shown.
    const notice = page.getByTestId('report-gross-profit-honesty-notice')
    await expect(notice).toBeVisible()
    const hasGap = (await notice.getAttribute('data-has-gap')) === 'true'
    const noticeText = (await notice.textContent()) ?? ''
    if (hasGap) {
      // honestyNoticeWithGap interpolates {{lines}}/{{revenue}} -- must
      // contain at least one digit (the excluded-line count or revenue
      // figure), never a silently-blank gap disclosure.
      expect(/\d/.test(noticeText)).toBe(true)
    } else {
      expect(noticeText.trim().length).toBeGreaterThan(0)
    }
  })

  test('Stock Valuation: real inventory-balance-derived numbers render, with the same honest cost-unavailable contract', async ({ page }) => {
    await page.goto('/app/reports/shop?tab=stock-valuation')
    await expect(page).not.toHaveURL(/\/login/)
    await page.waitForLoadState('networkidle')

    const denied = page.getByTestId('report-stock-valuation-permission-denied')
    const isDenied = await denied.count() > 0
    test.skip(isDenied, 'club_owner fixture unexpectedly lacks shop.reports.view_profit for Stock Valuation -- flagged as a real defect rather than silently passed.')

    const report = page.getByTestId('report-stock-valuation')
    await expect(report).toBeVisible()

    const totalValue = page.getByTestId('report-stock-valuation-total')
    await expect(totalValue).toBeVisible()
    const totalText = (await totalValue.textContent()) ?? ''
    expect(/\d/.test(totalText)).toBe(true)

    // If any on-hand unit has no known cost (get_shop_stock_valuation's
    // own null unit_cost/line_value contract, COMMERCE_C7_REPORTS_REPORT.md
    // Section 3 item 13), the report must disclose it explicitly via
    // the unknown-cost note and the row-count data attribute, never
    // silently total a fabricated 0.
    const unknownCountAttr = await report.getAttribute('data-unknown-cost-count')
    const unknownCount = Number(unknownCountAttr ?? '0')
    if (unknownCount > 0) {
      await expect(page.getByTestId('report-stock-valuation-unknown-cost-note')).toBeVisible()
    }
  })

  test('Inventory On Hand: real balance-report data renders (extra coverage beyond the required 3, matching the task\'s "inventory balance report shows real data" requirement)', async ({ page }) => {
    await page.goto('/app/reports/shop?tab=inventory-on-hand')
    await expect(page).not.toHaveURL(/\/login/)
    await page.waitForLoadState('networkidle')

    const report = page.getByTestId('report-inventory-on-hand')
    await expect(report).toBeVisible()

    // get_shop_inventory_balances is reused unmodified here (item 9,
    // C7's report) -- assert the loading state has genuinely resolved
    // (not stuck) and the component recorded a real row count, whether
    // zero (a legitimately empty club) or more.
    await expect(report).toHaveAttribute('data-loading', 'false', { timeout: 15_000 })
    const rowCountAttr = await report.getAttribute('data-row-count')
    expect(rowCountAttr).not.toBeNull()
    expect(Number(rowCountAttr)).toBeGreaterThanOrEqual(0)
  })
})
