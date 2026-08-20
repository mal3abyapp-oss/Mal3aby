// Finance IA consolidation directive: pure, testable classification
// logic extracted out of FinanceOverviewPage so it has real coverage
// (directive section 68: "financial statuses" is one of the explicit
// minimum test targets) independent of the query/render layer around it.

export interface OutstandingInvoiceLike {
  total: number
  outstanding: number
}

export interface OutstandingSplit {
  unpaidCount: number
  partialCount: number
}

/**
 * Classifies a club's outstanding_invoices rows into "fully unpaid"
 * (outstanding === total, i.e. zero has been collected) vs "partially
 * paid" (some but not all collected). Rows with outstanding <= 0 are
 * excluded entirely -- they are fully settled and do not belong on
 * either count, matching the same exclusion rule OutstandingPage.tsx
 * already applies at its own fetch boundary.
 */
export function classifyOutstandingInvoices(rows: OutstandingInvoiceLike[]): OutstandingSplit {
  let unpaidCount = 0
  let partialCount = 0
  for (const row of rows) {
    if (row.outstanding <= 0) continue
    if (row.outstanding >= row.total) unpaidCount += 1
    else partialCount += 1
  }
  return { unpaidCount, partialCount }
}
