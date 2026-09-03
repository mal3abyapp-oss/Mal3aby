import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { FormattedDate } from '@/components/ui/formatted-date'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ReportPrintHeader } from '@/components/ui/report-print-header'
import { fetchFullReport } from '@/lib/fetchFullReport'
import { useDateRange } from '@/features/reports/hooks/useDateRangeReport'
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/billing'
import { REPORT_PAGE_SIZE, useOffsetPager, PagerControls, ReportHeaderActions, FullPrintNote } from '@/features/shop/reports/shopReportShared'

// Commerce Pro C7 -- report suite item 8 (RETURNS / REFUNDS). A
// genuine filterable/paginated report, not C6's "recent 10" dashboard
// feed (list_shop_recent_returns has no filters and no p_offset --
// deliberately narrow, per that RPC's own header comment). New RPC
// list_shop_sale_returns (this phase) provides the real filter/
// pagination surface this report needs.
interface ReturnRow {
  returnId: string; saleId: string; invoiceNumber: string; processedByName: string | null; restock: boolean
  reason: string; createdAt: string; refundAmount: number | null; refundMethod: string | null
}
interface ReturnApiRow {
  return_id: string; sale_id: string; invoice_number: string; processed_by_name: string | null; restock: boolean
  reason: string; created_at: string; refund_amount: number | string | null; refund_method: string | null
}

function mapReturns(rows: ReturnApiRow[]): ReturnRow[] {
  return rows.map((r) => ({
    returnId: r.return_id, saleId: r.sale_id, invoiceNumber: r.invoice_number, processedByName: r.processed_by_name, restock: r.restock,
    reason: r.reason, createdAt: r.created_at, refundAmount: r.refund_amount === null ? null : Number(r.refund_amount), refundMethod: r.refund_method,
  }))
}

const REFUND_FILTER_ALL = '__all__'

export function ReportShopReturnsContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { offset, setOffset, reset } = useOffsetPager()
  const [refundedOnly, setRefundedOnly] = useState<string>(REFUND_FILTER_ALL)

  const refundedOnlyValue = refundedOnly === REFUND_FILTER_ALL ? undefined : refundedOnly === 'true'
  const args = { p_club_id: currentClubId as string, p_start_date: startDate || undefined, p_end_date: endDate || undefined, p_refunded_only: refundedOnlyValue }
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['shop-report-returns', currentClubId, startDate, endDate, refundedOnly, offset],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_shop_sale_returns', { ...args, p_limit: REPORT_PAGE_SIZE, p_offset: offset })
      if (error) throw error
      return mapReturns((data ?? []) as ReturnApiRow[])
    },
    enabled: !!currentClubId,
  })

  const [fullRows, setFullRows] = useState<ReturnRow[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const fullPrint = useMutation({
    mutationFn: () => fetchFullReport<ReturnApiRow>('list_shop_sale_returns', args),
    onSuccess: (result) => { setFullRows(mapReturns(result.rows)); setTruncated(result.truncated); requestAnimationFrame(() => requestAnimationFrame(() => window.print())) },
  })
  const printed = fullRows ?? rows

  const columns: DataTableColumn<ReturnRow>[] = [
    { key: 'invoice', header: t('shop.sales.columns.invoice'), render: (r) => <bdi>{r.invoiceNumber}</bdi> },
    { key: 'date', header: t('shop.sales.columns.date'), render: (r) => <FormattedDate value={r.createdAt} timeZone="Africa/Cairo" options={{ year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }} /> },
    { key: 'processedBy', header: t('shop.reports.returns.processedBy'), render: (r) => r.processedByName ?? '—' },
    { key: 'reason', header: t('shop.sales.reasonLabel'), render: (r) => r.reason },
    { key: 'restock', header: t('shop.sales.restockLabel'), render: (r) => (r.restock ? t('common.yes') : t('common.no')) },
    { key: 'refund', header: t('shop.reports.returns.refund'), render: (r) => r.refundAmount !== null ? <MoneyDisplay amount={r.refundAmount} size="sm" tone="danger" /> : t('shop.reports.returns.noRefund') },
    { key: 'method', header: t('shop.sales.filters.paymentMethod'), render: (r) => r.refundMethod ? t(`common.paymentMethodLabels.${r.refundMethod}`, { defaultValue: PAYMENT_METHOD_LABELS[r.refundMethod] ?? r.refundMethod }) : '—' },
  ]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 print:hidden">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.sales.filters.startDate')}</label>
            <Input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); reset() }} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.sales.filters.endDate')}</label>
            <Input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); reset() }} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.reports.returns.refund')}</label>
            <Select value={refundedOnly} onValueChange={(v) => { setRefundedOnly(v); reset() }}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={REFUND_FILTER_ALL}>{t('shop.sales.filters.allStatuses')}</SelectItem>
                <SelectItem value="true">{t('shop.reports.returns.refundedOnly')}</SelectItem>
                <SelectItem value="false">{t('shop.reports.returns.noRefund')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <ReportHeaderActions hasRows={rows.length > 0} onPrintFull={() => { setFullRows(null); fullPrint.mutate() }} printFullPending={fullPrint.isPending} />
      </div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.returns.title')} />
        <FullPrintNote fullCount={fullRows?.length ?? null} truncated={truncated} screenLimit={REPORT_PAGE_SIZE} />
        <DataTable columns={columns} rows={printed} rowKey={(r) => r.returnId} isLoading={isLoading} emptyTitle={t('reports.shop.emptyTitle')} />
        {fullRows === null && <PagerControls offset={offset} pageSize={REPORT_PAGE_SIZE} rowCount={rows.length} onPrev={() => setOffset(Math.max(0, offset - REPORT_PAGE_SIZE))} onNext={() => setOffset(offset + REPORT_PAGE_SIZE)} />}
      </div>
    </div>
  )
}
