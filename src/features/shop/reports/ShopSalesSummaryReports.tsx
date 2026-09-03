import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { FormattedDate } from '@/components/ui/formatted-date'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatCard } from '@/components/ui/stat-card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { StatusBadge } from '@/components/ui/status-badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ReportPrintHeader } from '@/components/ui/report-print-header'
import { fetchFullReport } from '@/lib/fetchFullReport'
import { useDateRange } from '@/features/reports/hooks/useDateRangeReport'
import { REPORT_PAGE_SIZE, useOffsetPager, PagerControls, ReportHeaderActions, FullPrintNote } from '@/features/shop/reports/shopReportShared'
import { ArrowRight, Receipt, ShoppingBag, TrendingUp, Wallet, TrendingDown } from 'lucide-react'

// Commerce Pro C7 -- report suite item 1 (SALES SUMMARY) and item 2
// (SALES DETAIL).
//
// SALES SUMMARY decision (documented per the task's own instruction to
// state this explicitly): C6's Shop Dashboard already covers every
// genuine "summary" need (KPI row, top products, category/payment
// breakdowns, low stock, recent sales/returns/cashier -- all scoped to
// "today" by the dashboard's own design). Building a SECOND, separate
// Sales Summary report page here would either (a) duplicate the
// dashboard's exact content with a date-range picker bolted on, or
// (b) become a shallow "KPI row only" page with less information than
// the dashboard already has. Decision: Sales Summary in THIS report
// suite is a genuine, date-range-scoped KPI card (reusing
// get_shop_sales_kpis, the same RPC the Sales page's own KPI row
// uses) PLUS an explicit link to both the live Dashboard (for "today,
// with more detail") and Sales Detail (below, for the transaction-
// level list) -- giving the report suite a real, addressable "summary"
// entry point without re-deriving what C6 already built well.
export function ReportShopSalesSummaryContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data: kpis } = useQuery({
    queryKey: ['shop-report-sales-summary-kpis', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_shop_sales_kpis', {
        p_club_id: currentClubId as string, p_start_date: startDate || undefined, p_end_date: endDate || undefined,
      }).maybeSingle()
      if (error) throw error
      return data
    },
    enabled: !!currentClubId,
  })

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2 print:hidden">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.sales.filters.startDate')}</label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.sales.filters.endDate')}</label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/app/shop/dashboard">{t('shop.reports.salesSummary.openDashboard')}<ArrowRight className="ms-1 size-4" aria-hidden="true" /></Link>
          </Button>
        </div>
      </div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.salesSummary.title')} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="report-sales-summary-stats">
          <StatCard label={t('shop.sales.kpi.grossSales')} value={<span data-testid="report-sales-summary-gross-sales"><MoneyDisplay amount={Number(kpis?.gross_sales ?? 0)} size="md" /></span>} icon={ShoppingBag} />
          <StatCard label={t('shop.sales.kpi.transactions')} value={<span data-testid="report-sales-summary-transactions">{Number(kpis?.transaction_count ?? 0)}</span>} icon={Receipt} />
          <StatCard label={t('shop.sales.kpi.averageBasket')} value={<MoneyDisplay amount={Number(kpis?.average_basket ?? 0)} size="md" />} icon={TrendingUp} />
          <StatCard label={t('shop.sales.kpi.itemsSold')} value={Number(kpis?.items_sold ?? 0)} icon={Wallet} />
          <StatCard label={t('shop.sales.kpi.refunds')} value={<MoneyDisplay amount={Number(kpis?.refund_total ?? 0)} size="md" />} icon={TrendingDown} tone={Number(kpis?.refund_total ?? 0) > 0 ? 'danger' : 'default'} />
          <StatCard label={t('shop.sales.kpi.netSales')} value={<MoneyDisplay amount={Number(kpis?.net_sales ?? 0)} size="md" />} icon={ShoppingBag} tone="success" />
        </div>
        <p className="mt-4 text-sm text-text-secondary print:hidden">
          {t('shop.reports.salesSummary.detailHint')}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// SALES DETAIL (item 2) -- extends C5's list_shop_sales (already has
// the full filter set the plan asks for). Deliberately NOT a copy of
// ShopSalesPage.tsx's own rich UI (returns processing, invoice viewing,
// sale-detail dialog all stay owned by the Sales page itself) -- this
// is the reports-suite's own line-item-level list: same data source,
// simpler read-only presentation, real pagination + print-full, so it
// belongs structurally alongside the other 15 reports rather than only
// being reachable via /app/shop/sales.
// ---------------------------------------------------------------------
interface SaleDetailReportRow {
  saleId: string; invoiceNumber: string; customerName: string | null; soldByName: string | null; status: string
  total: number; createdAt: string; discountAmount: number; refundAmount: number
}
interface SaleDetailApiRow {
  sale_id: string; invoice_number: string; customer_name: string | null; sold_by_name: string | null; status: string
  total: number | string; created_at: string; discount_amount: number | string; refund_amount: number | string
}

function mapSaleDetailRows(rows: SaleDetailApiRow[]): SaleDetailReportRow[] {
  return rows.map((r) => ({
    saleId: r.sale_id, invoiceNumber: r.invoice_number, customerName: r.customer_name, soldByName: r.sold_by_name, status: r.status,
    total: Number(r.total), createdAt: r.created_at, discountAmount: Number(r.discount_amount), refundAmount: Number(r.refund_amount),
  }))
}

const STATUS_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'danger'> = {
  completed: 'success', partially_returned: 'warning', returned: 'neutral', cancelled: 'danger', draft: 'neutral',
}

export function ReportShopSalesDetailContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { offset, setOffset, reset } = useOffsetPager()

  const args = { p_club_id: currentClubId as string, p_start_date: startDate || undefined, p_end_date: endDate || undefined }
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['shop-report-sales-detail', currentClubId, startDate, endDate, offset],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_shop_sales', { ...args, p_limit: REPORT_PAGE_SIZE, p_offset: offset })
      if (error) throw error
      return mapSaleDetailRows((data ?? []) as SaleDetailApiRow[])
    },
    enabled: !!currentClubId,
  })

  const [fullRows, setFullRows] = useState<SaleDetailReportRow[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const fullPrint = useMutation({
    mutationFn: () => fetchFullReport<SaleDetailApiRow>('list_shop_sales', args),
    onSuccess: (result) => { setFullRows(mapSaleDetailRows(result.rows)); setTruncated(result.truncated); requestAnimationFrame(() => requestAnimationFrame(() => window.print())) },
  })
  const printed = fullRows ?? rows

  const columns: DataTableColumn<SaleDetailReportRow>[] = [
    { key: 'invoice', header: t('shop.sales.columns.invoice'), render: (r) => <bdi>{r.invoiceNumber}</bdi> },
    { key: 'customer', header: t('shop.sales.columns.customer'), render: (r) => r.customerName ?? '—' },
    { key: 'cashier', header: t('shop.sales.columns.cashier'), render: (r) => r.soldByName ?? '—' },
    { key: 'date', header: t('shop.sales.columns.date'), render: (r) => <FormattedDate value={r.createdAt} timeZone="Africa/Cairo" options={{ year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }} /> },
    { key: 'total', header: t('shop.sales.columns.total'), render: (r) => <MoneyDisplay amount={r.total} size="sm" /> },
    { key: 'discount', header: t('shop.sales.columns.discount'), render: (r) => (r.discountAmount > 0 ? <MoneyDisplay amount={r.discountAmount} size="sm" tone="danger" /> : '—') },
    { key: 'refund', header: t('shop.sales.columns.refund'), render: (r) => (r.refundAmount > 0 ? <MoneyDisplay amount={r.refundAmount} size="sm" tone="danger" /> : '—') },
    { key: 'status', header: t('shop.sales.columns.status'), render: (r) => <StatusBadge tone={STATUS_TONE[r.status] ?? 'neutral'} label={t(`shop.sales.status.${r.status}`, { defaultValue: r.status })} /> },
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
        </div>
        <ReportHeaderActions hasRows={rows.length > 0} onPrintFull={() => { setFullRows(null); fullPrint.mutate() }} printFullPending={fullPrint.isPending} />
      </div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.salesDetail.title')} />
        <FullPrintNote fullCount={fullRows?.length ?? null} truncated={truncated} screenLimit={REPORT_PAGE_SIZE} />
        <DataTable columns={columns} rows={printed} rowKey={(r) => r.saleId} isLoading={isLoading} emptyTitle={t('reports.shop.emptyTitle')} />
        {fullRows === null && <PagerControls offset={offset} pageSize={REPORT_PAGE_SIZE} rowCount={rows.length} onPrev={() => setOffset(Math.max(0, offset - REPORT_PAGE_SIZE))} onNext={() => setOffset(offset + REPORT_PAGE_SIZE)} />}
      </div>
    </div>
  )
}
