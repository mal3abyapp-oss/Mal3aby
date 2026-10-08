import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AlertTriangle, Building, Download, FileSignature, Wallet } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { ErrorState } from '@/components/ui/error-state'
import { formatMoney } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { translateSupabaseError } from '@/lib/errors'
import { rentCycleLabel } from '@/lib/domain/rental'
import { useDirection } from '@/app/providers/DirectionProvider'
import type { RentalReport } from '@/features/rentals/types'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'
import { ReportPrintButton, ReportPrintHeader } from '@/components/ui/report-print-header'

// RENTALS MODULE (2026-10-07): module report over get_rental_report() --
// occupancy, collections in range (money actually received against
// rental invoice lines), dues, overdue, deposits held, per-space and
// per-cycle breakdowns. Same shape as ReportAcademyPage.
export function ReportRentalsPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading, isError, error, refetch } = useDateRangeReport<RentalReport>('get_rental_report', startDate, endDate)
  const money = (n: number) => formatMoney(Number(n), 'EGP', locale)
  const filterSummary = `${startDate} → ${endDate}`

  return (
    <div>
      <div className="print:hidden">
        <PageHeader title={t('reports.title')} description={t('reports.rentals.description')} />
        <ReportsNav />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
        {data && <ReportPrintButton />}
      </div>
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {isError && <ErrorState message={translateSupabaseError(error, t('reports.loadError'))} onRetry={() => void refetch()} />}
      {data && (
        <div className="print-target visible-for-print">
          <ReportPrintHeader reportName={t('reports.rentals.description')} filterSummary={filterSummary} />
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label={t('reports.rentals.collected')} value={money(data.collected_in_range)} icon={Wallet} tone="success" />
            <StatCard label={t('reports.rentals.dueInRange')} value={money(data.due_in_range)} />
            <StatCard label={t('reports.rentals.outstanding')} value={money(data.outstanding_total)} />
            <StatCard label={t('reports.rentals.overdue', { count: data.overdue_count })} value={money(data.overdue_total)} icon={AlertTriangle} tone={Number(data.overdue_total) > 0 ? 'danger' : 'default'} />
            <StatCard label={t('reports.rentals.occupancy')} value={`${data.spaces_occupied_today} / ${data.spaces_total}`} icon={Building} to="/app/rentals" />
            <StatCard label={t('reports.rentals.activeContracts')} value={data.active_contracts} icon={FileSignature} to="/app/rentals" />
            <StatCard label={t('reports.rentals.newContracts')} value={`${data.new_contracts_in_range} · ${money(data.contract_value_in_range)}`} />
            <StatCard label={t('reports.rentals.depositsHeld')} value={money(data.deposits_held)} />
            <StatCard label={t('reports.rentals.lateFees')} value={money(data.late_fees_in_range ?? 0)} />
            <StatCard label={t('reports.rentals.expenses')} value={money(data.expenses_in_range ?? 0)} tone={Number(data.expenses_in_range) > 0 ? 'danger' : 'default'} />
            <StatCard label={t('reports.rentals.net')} value={money(data.net_in_range ?? data.collected_in_range)} tone="success" />
            <StatCard label={t('reports.rentals.depositsCollected')} value={money(data.deposits_collected_in_range ?? 0)} />
            {Number(data.utilities_collected_in_range ?? 0) > 0 && (
              <StatCard label={t('reports.rentals.utilities')} value={money(data.utilities_collected_in_range ?? 0)} />
            )}
            {Number(data.vat_collected_in_range ?? 0) > 0 && (
              <StatCard label={t('reports.rentals.vat')} value={money(data.vat_collected_in_range ?? 0)} />
            )}
          </div>
          {(Number(data.deposits_refunded) > 0 || Number(data.deposits_kept) > 0) && (
            <p className="mb-4 text-xs text-text-secondary">
              {t('reports.rentals.depositsSettled', { refunded: money(data.deposits_refunded ?? 0), kept: money(data.deposits_kept ?? 0) })}
            </p>
          )}
          <p className="mb-4 text-xs text-text-secondary">{t('reports.rentals.depositNote')}</p>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">{t('reports.rentals.bySpace')}</p>
                {data.by_space.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="print:hidden"
                    onClick={() =>
                      downloadCsv(
                        `rentals-${startDate}-${endDate}.csv`,
                        rowsToCsv(
                          data.by_space.map((s) => ({ space: s.space_name, collected: s.collected, expenses: s.expenses ?? 0, net: s.net ?? s.collected, outstanding: s.outstanding })),
                          { space: t('reports.rentals.space'), collected: t('reports.rentals.collected'), expenses: t('reports.rentals.expenses'), net: t('reports.rentals.net'), outstanding: t('reports.rentals.outstanding') },
                        ),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    {t('reports.exportCsv')}
                  </Button>
                )}
              </div>
              {data.by_space.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_space.map((s) => (
                    <li key={s.space_id} className="flex justify-between gap-2 rounded-md border border-border p-2 text-sm">
                      <span>{s.space_name} <span className="text-xs text-text-secondary">· {s.occupied_today ? t('rentals.spaces.occupied') : t('rentals.spaces.vacant')}</span></span>
                      <span className="text-end">
                        {money(s.collected)}
                        {Number(s.expenses) > 0 && (
                          <span className="block text-xs text-text-secondary">
                            {t('reports.rentals.expenses')}: {money(s.expenses)} · {t('reports.rentals.net')}: {money(s.net)}
                          </span>
                        )}
                        {Number(s.outstanding) > 0 && <span className="block text-xs text-status-danger">{t('reports.rentals.outstanding')}: {money(s.outstanding)}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mb-2 mt-4 font-medium">{t('reports.rentals.byCycle')}</p>
              {data.by_cycle.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_cycle.map((c) => (
                    <li key={c.rent_cycle} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{rentCycleLabel(t, c.rent_cycle)} <span className="text-xs text-text-secondary">({c.contracts})</span></span>
                      <span>{money(c.value)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">{t('reports.rentals.overdueList')}</p>
                <Button asChild size="sm" variant="ghost" className="print:hidden">
                  <Link to="/app/rentals">{t('reports.rentals.manage')}</Link>
                </Button>
              </div>
              {data.overdue_rows.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('rentals.none')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.overdue_rows.map((r) => (
                    <li key={r.installment_id} className="flex justify-between gap-2 rounded-md border border-border p-2 text-sm">
                      <span>
                        {r.customer_name} · {r.space_name}
                        <span className="block text-xs text-text-secondary tabular-nums"><bdi>{r.contract_number}</bdi> · {r.due_date}</span>
                      </span>
                      <span className="text-status-danger">{money(r.outstanding)}</span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mb-2 mt-4 font-medium">{t('rentals.overview.expiringSoon')}</p>
              {data.expiring_soon.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('rentals.none')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.expiring_soon.map((c) => (
                    <li key={c.contract_id} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{c.customer_name} · {c.space_name}</span>
                      <span className="tabular-nums">{c.end_date}{c.renewed ? ` · ${t('rentals.renew.renewedBadge')}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
