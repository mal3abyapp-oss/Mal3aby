import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { StatusBadge } from '@/components/ui/status-badge'
import { formatMoney } from '@/lib/domain/billing'
import { useDirection } from '@/app/providers/DirectionProvider'
import { Scale, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Phase F (F4/F5): the critical report -- cash payments vs cash shifts
// vs government receipts, cross-checked, with exceptions surfaced
// explicitly rather than folded into one aggregate number. Built on
// Phase D's payments.cash_shift_id / official_collection_receipts.payment_id
// linkage, which makes an exact cross-check possible instead of an
// approximate time-window comparison.
interface ReconciliationReport {
  cash_payments_total: number
  cash_payments_linked_to_shift: number
  cash_payments_unlinked_to_shift_count: number
  shifts_closed_count: number
  total_shortage: number
  total_overage: number
  unreceipted_required_payments: { payment_id: string; amount: number; method: string; received_at: string }[]
}

export function ReportReconciliationContent() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading } = useDateRangeReport<ReconciliationReport>('get_financial_reconciliation_report', startDate, endDate)

  const hasExceptions = !!data && (data.unreceipted_required_payments.length > 0 || data.total_shortage > 0)

  return (
    <div>
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {data && (
        <>
          {/* F5: exceptions surfaced clearly, not buried -- a clean
              reconciliation shows a positive confirmation, not silence. */}
          <div className={`mb-6 flex items-start gap-2 rounded-lg border p-3 text-sm ${hasExceptions ? 'border-status-danger/40 bg-status-danger/5 text-status-danger' : 'border-status-success/40 bg-status-success/5 text-status-success'}`}>
            {hasExceptions ? <AlertTriangle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
            <p>{hasExceptions ? t('reports.reconciliation.exceptionsFound') : t('reports.reconciliation.noExceptions')}</p>
          </div>

          <div className="mb-6 grid gap-4 md:grid-cols-3">
            <StatCard label={t('reports.reconciliation.cashPaymentsTotal')} value={formatMoney(data.cash_payments_total, 'EGP', locale)} icon={Scale} />
            <StatCard
              label={t('reports.reconciliation.totalShortage')}
              value={formatMoney(data.total_shortage, 'EGP', locale)}
              icon={AlertTriangle}
              tone={data.total_shortage > 0 ? 'danger' : 'default'}
            />
            <StatCard label={t('reports.reconciliation.totalOverage')} value={formatMoney(data.total_overage, 'EGP', locale)} icon={Scale} />
          </div>

          <div className="mb-6 rounded-lg border border-border p-3 text-sm">
            <p className="mb-2 font-medium">{t('reports.reconciliation.shiftLinkage')}</p>
            <div className="flex flex-col gap-1">
              <p>{t('reports.reconciliation.linkedToShift', { amount: formatMoney(data.cash_payments_linked_to_shift, 'EGP', locale) })}</p>
              <p>{t('reports.reconciliation.shiftsClosedCount', { count: data.shifts_closed_count })}</p>
              {data.cash_payments_unlinked_to_shift_count > 0 && (
                <p className="text-status-warning">
                  {t('reports.reconciliation.unlinkedCount', { count: data.cash_payments_unlinked_to_shift_count })}
                </p>
              )}
            </div>
          </div>

          <div>
            <p className="mb-2 font-medium">{t('reports.reconciliation.unreceiptedHeading')}</p>
            {data.unreceipted_required_payments.length === 0 ? (
              <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {data.unreceipted_required_payments.map((p) => (
                  <li key={p.payment_id} className="flex items-center justify-between rounded-md border border-status-danger/30 bg-status-danger/5 p-2 text-sm">
                    <span>
                      {formatMoney(p.amount, 'EGP', locale)} — {t(`common.paymentMethodLabels.${p.method}`, { defaultValue: p.method })}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-text-secondary tabular-nums">{new Date(p.received_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}</span>
                      <StatusBadge tone="danger" label={t('reports.reconciliation.missingReceipt')} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function ReportReconciliationPage() {
  const { t } = useTranslation()
  return (
    <div>
      <PageHeader title={t('reports.title')} description={t('reports.reconciliation.description')} />
      <ReportsNav />
      <ReportReconciliationContent />
    </div>
  )
}
