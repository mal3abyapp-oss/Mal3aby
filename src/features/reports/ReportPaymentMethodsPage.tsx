import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { formatMoney, PAYMENT_METHOD_LABELS } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { translateSupabaseError } from '@/lib/errors'
import { Banknote, Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's PaymentMethodReportTab. Confirmed by the Reports
// architecture audit as the clear outlier among the original 9 tabs --
// this owns a second query (payment_reconciliations) AND a mutation
// (confirm_payment_reconciliation) with its own error state, making it
// a reconciliation WORKFLOW, not a passive report. Gets its own
// dedicated screen for that reason, independent of the "which reports
// are similar enough to stay grouped" question that applied to the
// others.
interface PaymentMethodReport {
  total_collected: number
  total_refunded: number
  by_method: {
    method: string
    collected: number
    collected_count: number
    refunded: number
    refunded_count: number
    net: number
  }[]
}

interface ReconciliationRecord {
  id: string
  method: string
  period_start: string
  period_end: string
  reconciled_total: number
  note: string | null
  reconciled_at: string
}

async function fetchReconciliations(clubId: string, startDate: string, endDate: string): Promise<ReconciliationRecord[]> {
  const { data, error } = await supabase
    .from('payment_reconciliations')
    .select('id, method, period_start, period_end, reconciled_total, note, reconciled_at')
    .eq('club_id', clubId)
    .gte('period_start', startDate)
    .lte('period_end', endDate)
    .order('reconciled_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    method: r.method,
    period_start: r.period_start,
    period_end: r.period_end,
    reconciled_total: Number(r.reconciled_total),
    note: r.note,
    reconciled_at: r.reconciled_at,
  }))
}

export function ReportPaymentMethodsPage() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const [reconcileError, setReconcileError] = useState<string | null>(null)

  const { data, isLoading } = useDateRangeReport<PaymentMethodReport>('get_payment_method_report', startDate, endDate)

  const { data: reconciliations = [] } = useQuery({
    queryKey: ['payment-reconciliations', currentClubId, startDate, endDate],
    queryFn: () => fetchReconciliations(currentClubId!, startDate, endDate),
    enabled: !!currentClubId,
  })
  const reconciledMethods = new Set(reconciliations.map((r) => r.method))

  const confirmMutation = useMutation({
    mutationFn: async (method: string) => {
      const { error } = await supabase.rpc('confirm_payment_reconciliation', {
        p_club_id: currentClubId!,
        p_method: method,
        p_period_start: startDate,
        p_period_end: endDate,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setReconcileError(null)
      void queryClient.invalidateQueries({ queryKey: ['payment-reconciliations', currentClubId] })
    },
    onError: (error) => setReconcileError(translateSupabaseError(error, 'تعذّر تأكيد التسوية.')),
  })

  return (
    <div>
      <PageHeader title="التقارير" description="تسوية طرق الدفع -- تحصيل، استرداد، وتأكيد يدوي لكل طريقة" />
      <ReportsNav />
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {data && (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <StatCard label="إجمالي التحصيلات" value={formatMoney(data.total_collected)} icon={Banknote} />
            <StatCard label="إجمالي المستردات" value={formatMoney(data.total_refunded)} tone="danger" />
            <StatCard label="الصافي" value={formatMoney(data.total_collected - data.total_refunded)} />
          </div>
          <div className="mb-2 flex items-center justify-between">
            <p className="font-medium">التسوية حسب طريقة الدفع</p>
            {data.by_method.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadCsv(
                    `payment-method-reconciliation-${startDate}-${endDate}.csv`,
                    rowsToCsv(
                      data.by_method.map((m) => ({
                        method: PAYMENT_METHOD_LABELS[m.method] ?? m.method,
                        collected: m.collected,
                        collected_count: m.collected_count,
                        refunded: m.refunded,
                        refunded_count: m.refunded_count,
                        net: m.net,
                      })),
                      {
                        method: 'طريقة الدفع',
                        collected: 'التحصيل',
                        collected_count: 'عدد الدفعات',
                        refunded: 'المسترد',
                        refunded_count: 'عدد المستردات',
                        net: 'الصافي',
                      },
                    ),
                  )
                }
              >
                <Download className="me-1 size-4" />
                تصدير CSV
              </Button>
            )}
          </div>
          {reconcileError && <p className="mb-2 text-sm text-status-danger">{reconcileError}</p>}
          {data.by_method.length === 0 ? (
            <p className="text-sm text-text-secondary">لا توجد بيانات</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-border text-text-secondary">
                    <th className="p-2 text-start">طريقة الدفع</th>
                    <th className="p-2 text-start">التحصيل</th>
                    <th className="p-2 text-start">المسترد</th>
                    <th className="p-2 text-start">الصافي</th>
                    <th className="p-2 text-start">التسوية اليدوية</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_method.map((m) => (
                    <tr key={m.method} className="border-b border-border">
                      <td className="p-2 font-medium">{PAYMENT_METHOD_LABELS[m.method] ?? m.method}</td>
                      <td className="p-2">{formatMoney(m.collected)} — {m.collected_count} دفعة</td>
                      <td className="p-2 text-status-danger">
                        {m.refunded > 0 ? `${formatMoney(m.refunded)} — ${m.refunded_count} استرداد` : '—'}
                      </td>
                      <td className="p-2 font-medium">{formatMoney(m.net)}</td>
                      <td className="p-2">
                        {reconciledMethods.has(m.method) ? (
                          <span className="text-status-success">تمت التسوية ✓</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={confirmMutation.isPending}
                            onClick={() => confirmMutation.mutate(m.method)}
                          >
                            تأكيد التسوية
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {reconciliations.length > 0 && (
            <div className="mt-6">
              <p className="mb-2 font-medium">سجل التسويات</p>
              <ul className="flex flex-col gap-1">
                {reconciliations.map((r) => (
                  <li key={r.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                    <span>
                      {PAYMENT_METHOD_LABELS[r.method] ?? r.method} — {formatMoney(r.reconciled_total)}
                      {r.note && <span className="text-text-secondary"> — {r.note}</span>}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {new Date(r.reconciled_at).toLocaleString('ar-EG')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}
