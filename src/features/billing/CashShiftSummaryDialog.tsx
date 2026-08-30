import { useTranslation } from 'react-i18next'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatMoney } from '@/lib/domain/billing'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Printer } from 'lucide-react'

// PRINTING PRODUCTION ACCEPTANCE (2026-08-30), Section 15 (USEFUL,
// implemented per the directive's "implement high-value USEFUL items
// when low-risk"): CashShiftPage.tsx had no print surface at all --
// confirmed via grep. This reuses the exact same print-target /
// .visible-for-print / A4-only mechanism as every other document in
// this codebase (see index.css, BillingPage.tsx, ExpenseVoucherDialog.tsx).
// A4 only -- like the Expense Voucher, this is an internal end-of-shift
// handoff document, not a customer-facing receipt.
//
// Deliberately built from the SAME row data CashShiftPage.tsx's own
// history table already fetches (opening_float, expected_cash,
// closing_count, variance, opened/closed by/at) -- no new RPC, no
// client-side recomputation of any of those authoritative figures
// (they are all frozen server-side at close time by close_cash_shift(),
// per that RPC's own documented contract). This intentionally does
// NOT attempt to reconstruct the cash-collected/refunded/expenses
// breakdown for a CLOSED historical shift -- that live breakdown only
// exists via get_open_cash_shift_status(), which is scoped to OPEN
// shifts. Showing opening/expected/counted/variance/who/when is a
// genuinely useful, low-risk summary on its own; inventing a second
// historical-breakdown RPC for a USEFUL (not REQUIRED) surface would
// be exactly the kind of over-scoped work the directive's own
// "Do NOT add pointless Print buttons" / low-risk framing warns against.
export interface CashShiftSummaryData {
  id: string
  branchName: string
  openedByName: string | null
  closedByName: string | null
  openedAt: string
  closedAt: string | null
  openingFloat: number
  expectedCash: number | null
  closingCount: number | null
  variance: number | null
  status: string
}

export function CashShiftSummaryDialog({
  shift,
  onClose,
}: {
  shift: CashShiftSummaryData
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const isOpen = shift.status === 'open'

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('billing.cashShift.summary.dialogTitle')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div
            data-testid="cash-shift-summary-print-view"
            data-print-size="a4"
            className="print-target visible-for-print rounded-md border border-border p-4 text-sm print:border-0"
          >
            <p className="mb-3 border-b border-border pb-2 font-bold">{t('billing.cashShift.summary.title')}</p>

            {isOpen && (
              <p className="mb-3 rounded-md border border-status-warning bg-status-warning/5 p-2 text-xs text-status-warning">
                {t('billing.cashShift.summary.stillOpen')}
              </p>
            )}

            <div className="flex flex-col gap-1">
              <p>{t('billing.cashShift.summary.branch')}: {shift.branchName}</p>
              <p>{t('billing.cashShift.summary.openedBy')}: {shift.openedByName ?? '—'}</p>
              <p>{t('billing.cashShift.summary.openedAt')}: {new Date(shift.openedAt).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}</p>
              {shift.closedByName && <p>{t('billing.cashShift.summary.closedBy')}: {shift.closedByName}</p>}
              {shift.closedAt && (
                <p>{t('billing.cashShift.summary.closedAt')}: {new Date(shift.closedAt).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}</p>
              )}
            </div>

            <div className="mt-3 flex flex-col gap-1 border-t border-border pt-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-secondary">{t('billing.cashShift.summary.openingFloat')}</span>
                <span className="tabular-nums">{formatMoney(shift.openingFloat, 'EGP', locale)}</span>
              </div>
              {shift.expectedCash !== null && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">{t('billing.cashShift.summary.expectedCash')}</span>
                  <span className="tabular-nums">{formatMoney(shift.expectedCash, 'EGP', locale)}</span>
                </div>
              )}
              {shift.closingCount !== null && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">{t('billing.cashShift.summary.countedCash')}</span>
                  <span className="tabular-nums">{formatMoney(shift.closingCount, 'EGP', locale)}</span>
                </div>
              )}
              {shift.variance !== null && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">{t('billing.cashShift.summary.variance')}</span>
                  <MoneyDisplay amount={shift.variance} size="md" tone={shift.variance === 0 ? 'success' : 'danger'} />
                </div>
              )}
            </div>

            {shift.variance !== null && (
              <p className={`mt-2 text-xs ${shift.variance === 0 ? 'text-status-success' : 'text-status-danger'}`}>
                {shift.variance === 0
                  ? t('billing.cashShift.summary.varianceBalanced')
                  : shift.variance < 0
                    ? t('billing.cashShift.summary.varianceShortage')
                    : t('billing.cashShift.summary.varianceOverage')}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 print:hidden">
            <Button variant="outline" size="sm" className="w-fit" onClick={() => window.print()}>
              <Printer className="me-1 size-4" aria-hidden="true" />
              {t('billing.cashShift.summary.print')}
            </Button>
            <Button variant="ghost" size="sm" className="w-fit" onClick={onClose}>
              {t('common.close')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
