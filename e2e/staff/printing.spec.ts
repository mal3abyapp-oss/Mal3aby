import { test, expect } from '@playwright/test'
import { authStatePath, hasMintedSession } from '../fixtures/qa-auth'

const FIXTURE = 'accountant'

// PRINTING REGRESSION COVERAGE. This project's print CSS
// (src/index.css) supports A4 (default) and 80mm thermal via a
// data-print-size attribute toggled by a real UI Select
// (BillingPage.tsx, rendered at /app/finance/invoices via
// FinanceInvoicesPage's 'invoices' sub-tab per the IA restructuring) --
// Phase 15 found and fixed a real gap where nothing ever set that
// attribute, making the 80mm path unreachable. CORRECTION (this
// phase): the selector is `.print-target[data-print-size]`, a CLASS
// selector, not `#invoice-print` -- src/index.css itself documents that
// the id was deliberately replaced in task #85 because the refund-
// receipt dialog added a second printable surface that can be mounted
// in the DOM at the same time as the invoice-detail dialog, and two
// elements sharing one id would be invalid HTML. This suite cannot
// trigger an actual OS print dialog (Playwright has no print-dialog
// automation), but CAN assert on the print-relevant DOM state
// (data-print-size attribute + the presence of print-scoped content)
// without ever opening a real print preview -- print CSS correctness
// itself (@media print rules) is a CSS-only concern with no JS behavior
// to browser-test beyond "does the toggle correctly write the
// attribute", which is what these tests check. data-testid coverage
// added this phase (invoice-row-{id}, invoice-print-view,
// invoice-print-size-toggle/-a4/-80mm, refund-payment-{id},
// refund-amount-input/-reason-input/-submit, refund-receipt-view) makes
// both tests below real DOM assertions instead of route checks.

test.describe('Invoice print view (accountant, authenticated)', () => {
  test.skip(!hasMintedSession(FIXTURE), `No minted session for '${FIXTURE}' -- run \`npm run e2e:setup\` first. See E2E_TEST_STRATEGY.md.`)
  test.use({ storageState: authStatePath(FIXTURE) })

  test('finance invoices page loads without error', async ({ page }) => {
    await page.goto('/app/finance/invoices')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.locator('body')).not.toBeEmpty()
  })

  // CORRECTION to this test's own name/doc comment vs. reality: the
  // print CSS target is NOT `#invoice-print` -- src/index.css itself
  // documents (see the comment directly above its print rules) that the
  // id was deliberately replaced with a `.print-target[data-print-size]`
  // CLASS selector in task #85, specifically because the refund-receipt
  // dialog added a second printable surface that can be mounted at the
  // same time as the invoice-detail dialog underneath it -- two elements
  // sharing one id would be invalid HTML. `data-testid="invoice-print-
  // view"` now sits on that exact div (BillingPage.tsx), and
  // `data-testid="invoice-print-size-toggle"` sits on the Select
  // trigger that sets it, so this is now a real DOM assertion instead
  // of a route-availability one.
  test('the A4/80mm print-size toggle correctly sets .print-target[data-print-size]', async ({ page }) => {
    await page.goto('/app/finance/invoices')
    await page.waitForLoadState('networkidle')

    const invoiceRow = page.locator('[data-testid^="invoice-row-"]').first()
    // No live QA fixture data has been confirmed to exist for this
    // phase (no minted session ever ran) -- if the invoices list is
    // genuinely empty this assertion documents that honestly instead of
    // hanging or false-passing on a route check alone.
    const hasInvoice = await invoiceRow.count() > 0
    test.skip(!hasInvoice, 'No invoice rows rendered for this QA fixture -- cannot open invoice detail to exercise the print-size toggle.')

    await invoiceRow.click()

    const printView = page.getByTestId('invoice-print-view')
    await expect(printView).toBeVisible()
    // Default is A4 (BillingPage.tsx: useState<'a4' | '80mm'>('a4')).
    await expect(printView).toHaveAttribute('data-print-size', 'a4')

    await page.getByTestId('invoice-print-size-toggle').click()
    await page.getByTestId('invoice-print-size-80mm').click()
    await expect(printView).toHaveAttribute('data-print-size', '80mm')

    // Toggle back to A4 to prove the attribute is genuinely reactive in
    // both directions, not just set once at a default.
    await page.getByTestId('invoice-print-size-toggle').click()
    await page.getByTestId('invoice-print-size-a4').click()
    await expect(printView).toHaveAttribute('data-print-size', 'a4')
  })

  // Drives a real refund end-to-end (dialog -> amount/reason -> submit)
  // rather than merely finding a pre-existing refunded payment in fixture
  // data, using the new refund-payment-{id} / refund-amount-input /
  // refund-reason-input / refund-submit / refund-receipt-view
  // data-testid attributes (BillingPage.tsx). This is a real mutation
  // against the live Supabase project (create_refund RPC) -- same
  // "real backend, always" philosophy as every other spec in this
  // suite (E2E_TEST_STRATEGY.md).
  test('refund receipt view renders for a refunded payment', async ({ page }) => {
    await page.goto('/app/finance/invoices')
    await page.waitForLoadState('networkidle')

    const invoiceRow = page.locator('[data-testid^="invoice-row-"]').first()
    const hasInvoice = await invoiceRow.count() > 0
    test.skip(!hasInvoice, 'No invoice rows rendered for this QA fixture -- cannot open invoice detail to find a refundable payment.')
    await invoiceRow.click()

    const refundButton = page.locator('[data-testid^="refund-payment-"]').first()
    const hasRefundablePayment = await refundButton.count() > 0
    test.skip(!hasRefundablePayment, 'No refundable payment rendered on this invoice for the current QA fixture data.')

    await refundButton.click()
    await page.getByTestId('refund-amount-input').fill('1')
    await page.getByTestId('refund-reason-input').fill('E2E refund receipt regression test')
    await page.getByTestId('refund-submit').click()

    const receipt = page.getByTestId('refund-receipt-view')
    await expect(receipt).toBeVisible()
    await expect(receipt).toHaveAttribute('data-print-size', 'a4')
    // The receipt renders the exact reason just submitted -- proves this
    // is the real just-created refund's data, not a stale/cached view.
    await expect(receipt).toContainText('E2E refund receipt regression test')
  })
})
