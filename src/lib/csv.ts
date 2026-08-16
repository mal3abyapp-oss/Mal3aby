// V1 Implementation Gap Audit (2026-08-16): extracted from
// OutstandingPage.tsx (the only screen that had CSV export) so it can be
// reused on ReportsPage.tsx too -- docs/IMPLEMENTATION_PLAN.md's Phase 7
// scope was explicitly "CSV export on this AND OTHER APPLICABLE REPORTS",
// not Outstanding-only. Client-side generation, no library, per
// docs/ARCHITECTURE.md#reporting-strategy.
export function rowsToCsv<T extends Record<string, unknown>>(rows: T[], headers: Partial<Record<keyof T, string>>): string {
  const keys = Object.keys(headers) as (keyof T)[]
  const headerLine = keys.map((k) => headers[k] ?? String(k)).join(',')
  const lines = rows.map((row) =>
    keys
      .map((k) => {
        const value = row[k]
        const str = value === null || value === undefined ? '' : String(value)
        // Quote any field containing a comma, quote, or newline; double up embedded quotes.
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
      })
      .join(','),
  )
  return [headerLine, ...lines].join('\n')
}

export function downloadCsv(filename: string, csv: string): void {
  // Leading BOM so Excel opens Arabic content as UTF-8 instead of guessing
  // a legacy codepage and mangling it -- same fix already proven in
  // OutstandingPage's original implementation.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
