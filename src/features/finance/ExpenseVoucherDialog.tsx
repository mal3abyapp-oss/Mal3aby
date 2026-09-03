import { useTranslation } from 'react-i18next'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatDateIsolated } from '@/lib/i18n/config'
import { FormattedDate } from '@/components/ui/formatted-date'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Printer } from 'lucide-react'

// PRINTING PRODUCTION ACCEPTANCE (2026-08-30), Section 9: Expenses had
// no print surface at all -- confirmed by grep across
// FinanceExpensesPage.tsx (real gap, not a false negative). Reuses the
// exact same print-target / .visible-for-print / A4-only mechanism
// already established for every other document in this codebase (see
// index.css's @media print block, BillingPage.tsx, ShopInvoiceDocument.tsx)
// -- not a second print system. A4 only: an expense voucher is an
// internal accounting document, not a customer-facing receipt handed
// over a counter, so there is no operational need for an 80mm variant
// (matches the directive's own framing of what belongs on each paper
// mode -- thermal is for POS/payment/booking receipts, A4 is for
// formal/internal documents).
//
// Every field this component renders comes directly from
// list_expenses()'s widened row (recorded_by_name, voided_by_name,
// voided_at, cash_shift_reference) -- no client-side recomputation of
// any financial value, matching the "printed totals must come from
// authoritative server data" principle already enforced everywhere
// else. Optional fields (category, paid_to, reference, cash shift)
// are rendered ONLY when present, matching this codebase's established
// "do not display meaningless empty fields" convention.
export interface ExpenseVoucherData {
  id: string
  branchName: string
  categoryName: string | null
  amount: number
  paymentMethod: string
  description: string
  reference: string | null
  paidTo: string | null
  expenseDate: string
  status: 'recorded' | 'voided'
  recordedByName: string | null
  voidedByName: string | null
  voidedAt: string | null
  voidReason: string | null
  cashShiftReference: string | null
}

const PAYMENT_METHOD_KEY: Record<string, string> = {
  cash: 'billing.paymentMethods.underlyingMethodLabels.cash',
  card: 'billing.paymentMethods.underlyingMethodLabels.card',
  bank_transfer: 'billing.paymentMethods.underlyingMethodLabels.bank_transfer',
  wallet: 'billing.paymentMethods.underlyingMethodLabels.wallet',
  other: 'billing.paymentMethods.underlyingMethodLabels.other',
}

export function ExpenseVoucherDialog({
  expense,
  onClose,
}: {
  expense: ExpenseVoucherData
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const isVoided = expense.status === 'voided'

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isVoided ? t('finance.expenses.voucher.voidedTitle') : t('finance.expenses.voucher.dialogTitle')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div
            data-testid="expense-voucher-print-view"
            data-print-size="a4"
            className="print-target visible-for-print rounded-md border border-border p-4 text-sm print:border-0"
          >
            <p className="mb-3 border-b border-border pb-2 font-bold">
              {isVoided ? t('finance.expenses.voucher.voidedTitle') : t('finance.expenses.voucher.title')}
            </p>

            {/* VOIDED must be unmistakable on the printed page -- directive
                Section 8/19: a document must never let its presentation
                imply a voided expense still counts. Red banner, not just
                a small status word, so it reads correctly even skimmed. */}
            {isVoided && (
              <p className="mb-3 rounded-md border border-status-danger bg-status-danger/5 p-2 text-center text-xs font-bold text-status-danger">
                {t('finance.expenses.voucher.voidedBanner')}
              </p>
            )}

            <div className="flex flex-col gap-1">
              <p>
                {t('finance.expenses.voucher.reference')}: <bdi className="tabular-nums">{expense.reference ?? expense.id.slice(0, 8).toUpperCase()}</bdi>
              </p>
              <p>
                {t('finance.expenses.voucher.date')}: <FormattedDate value={expense.expenseDate} timeZone="Africa/Cairo" options={{ year: 'numeric', month: 'short', day: 'numeric' }} />
              </p>
              <p>{t('finance.expenses.voucher.branch')}: {expense.branchName}</p>
              {expense.categoryName && <p>{t('finance.expenses.voucher.category')}: {expense.categoryName}</p>}
              {expense.paidTo && <p>{t('finance.expenses.voucher.paidTo')}: {expense.paidTo}</p>}
              <p>{t('finance.expenses.voucher.description')}: {expense.description}</p>
              <p>
                {t('finance.expenses.voucher.method')}: {t(PAYMENT_METHOD_KEY[expense.paymentMethod] ?? 'billing.paymentMethods.underlyingMethodLabels.other')}
              </p>
              {expense.recordedByName && <p>{t('finance.expenses.voucher.recordedBy')}: {expense.recordedByName}</p>}
              {expense.cashShiftReference && (
                <p>
                  {t('finance.expenses.voucher.cashShiftReference')}: <bdi className="tabular-nums" dir="ltr">{expense.cashShiftReference}</bdi>
                </p>
              )}
            </div>

            <div className="mt-3 flex items-center justify-end gap-2 border-t border-border pt-2">
              <span className="text-xs text-text-secondary">{t('finance.expenses.voucher.amount')}</span>
              <MoneyDisplay amount={expense.amount} size="lg" tone={isVoided ? 'default' : 'danger'} />
            </div>

            {isVoided && (
              <div className="mt-2 border-t border-border pt-2 text-xs text-text-secondary">
                {expense.voidedByName && <p>{t('finance.expenses.voucher.voidedBy', { name: expense.voidedByName })}</p>}
                {expense.voidedAt && (
                  <p>
                    {t('finance.expenses.voucher.voidedAt', {
                      date: formatDateIsolated(expense.voidedAt, locale === 'en' ? 'en' : 'ar', 'Africa/Cairo', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                    })}
                  </p>
                )}
                {expense.voidReason && <p>{t('finance.expenses.voucher.voidReason', { reason: expense.voidReason })}</p>}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 print:hidden">
            <Button variant="outline" size="sm" className="w-fit" onClick={() => window.print()}>
              <Printer className="me-1 size-4" aria-hidden="true" />
              {t('finance.expenses.voucher.print')}
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
