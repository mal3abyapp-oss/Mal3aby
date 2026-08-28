import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ReportPrintHeader } from '@/components/ui/report-print-header'
import { fetchFullReport } from '@/lib/fetchFullReport'
import { useDateRange } from '@/features/reports/hooks/useDateRangeReport'
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/billing'
import { REPORT_PAGE_SIZE, useOffsetPager, PagerControls, ReportHeaderActions, FullPrintNote } from '@/features/shop/reports/shopReportShared'

// Commerce Pro C7 -- report suite items 3 (Product Sales), 4 (Category
// Sales), 5 (Payment Method Sales), 6 (Cashier Sales), 7 (Customer
// Purchases). Each reuses an existing C5/C6 RPC (get_shop_top_products
// extended with real pagination in this phase, get_shop_sales_by_category,
// get_shop_payment_method_mix, list_shop_sales+client rollup matching
// C6's own precedent, get_customer_shop_purchases extended with date
// range + pagination) rather than inventing new ones -- see
// COMMERCE_C7_REPORTS_REPORT.md for the full per-item reuse-vs-new
// reasoning.

function DateRangeBar({ startDate, endDate, setStartDate, setEndDate }: {
  startDate: string; endDate: string; setStartDate: (v: string) => void; setEndDate: (v: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="mb-3 flex flex-wrap items-end gap-2 print:hidden">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-secondary">{t('shop.sales.filters.startDate')}</label>
        <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-text-secondary">{t('shop.sales.filters.endDate')}</label>
        <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// PRODUCT SALES (item 3) -- get_shop_top_products extended this phase
// with p_offset/p_category_id so "top 10" becomes a full, filterable,
// paginated report rather than staying a fixed-size dashboard widget.
// ---------------------------------------------------------------------
interface ProductSalesRow { productId: string; productNameAr: string; unitsSold: number; unitsReturned: number; revenue: number }
interface ProductSalesApiRow { product_id: string; product_name_ar: string; units_sold: number | string; units_returned: number | string; revenue: number | string }

function mapProductSales(rows: ProductSalesApiRow[]): ProductSalesRow[] {
  return rows.map((r) => ({ productId: r.product_id, productNameAr: r.product_name_ar, unitsSold: Number(r.units_sold), unitsReturned: Number(r.units_returned), revenue: Number(r.revenue) }))
}

export function ReportShopProductSalesContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { offset, setOffset, reset } = useOffsetPager()

  const args = { p_club_id: currentClubId as string, p_start_date: startDate || undefined, p_end_date: endDate || undefined, p_limit: REPORT_PAGE_SIZE, p_offset: offset }
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['shop-report-product-sales', currentClubId, startDate, endDate, offset],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_shop_top_products', args)
      if (error) throw error
      return mapProductSales((data ?? []) as ProductSalesApiRow[])
    },
    enabled: !!currentClubId,
  })

  const [fullRows, setFullRows] = useState<ProductSalesRow[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const fullPrint = useMutation({
    mutationFn: () => fetchFullReport<ProductSalesApiRow>('get_shop_top_products', { p_club_id: currentClubId, p_start_date: startDate || undefined, p_end_date: endDate || undefined }),
    onSuccess: (result) => { setFullRows(mapProductSales(result.rows)); setTruncated(result.truncated); requestAnimationFrame(() => requestAnimationFrame(() => window.print())) },
  })
  const printed = fullRows ?? rows

  const columns: DataTableColumn<ProductSalesRow>[] = [
    { key: 'product', header: t('reports.shop.columns.product'), render: (r) => r.productNameAr },
    { key: 'unitsSold', header: t('reports.shop.columns.unitsSold'), render: (r) => r.unitsSold },
    { key: 'unitsReturned', header: t('reports.shop.columns.unitsReturned'), render: (r) => r.unitsReturned },
    { key: 'revenue', header: t('reports.shop.columns.revenue'), render: (r) => <MoneyDisplay amount={r.revenue} size="sm" /> },
  ]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 print:hidden">
        <DateRangeBar startDate={startDate} endDate={endDate} setStartDate={(v) => { setStartDate(v); reset() }} setEndDate={(v) => { setEndDate(v); reset() }} />
        <ReportHeaderActions hasRows={rows.length > 0} onPrintFull={() => { setFullRows(null); fullPrint.mutate() }} printFullPending={fullPrint.isPending} />
      </div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.productSales.title')} />
        <FullPrintNote fullCount={fullRows?.length ?? null} truncated={truncated} screenLimit={REPORT_PAGE_SIZE} />
        <DataTable columns={columns} rows={printed} rowKey={(r) => r.productId} isLoading={isLoading} emptyTitle={t('reports.shop.emptyTitle')} />
        {fullRows === null && <PagerControls offset={offset} pageSize={REPORT_PAGE_SIZE} rowCount={rows.length} onPrev={() => setOffset(Math.max(0, offset - REPORT_PAGE_SIZE))} onNext={() => setOffset(offset + REPORT_PAGE_SIZE)} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// CATEGORY SALES (item 4) -- get_shop_sales_by_category (C6), wrapped
// with real date-range UI. No pagination: category count is naturally
// small/bounded (one row per club category, never "can grow large"
// the way a sales/movement list can), so a print-full action would add
// UI for a case that structurally cannot need it.
// ---------------------------------------------------------------------
interface CategorySalesRow { categoryId: string | null; categoryName: string | null; unitsSold: number; revenue: number }

export function ReportShopCategorySalesContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['shop-report-category-sales', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_shop_sales_by_category', { p_club_id: currentClubId as string, p_start_date: startDate || undefined, p_end_date: endDate || undefined })
      if (error) throw error
      return (data ?? []).map((r) => ({ categoryId: r.category_id, categoryName: r.category_name, unitsSold: Number(r.units_sold), revenue: Number(r.revenue) })) as CategorySalesRow[]
    },
    enabled: !!currentClubId,
  })

  const columns: DataTableColumn<CategorySalesRow>[] = [
    { key: 'category', header: t('shop.reports.categorySales.category'), render: (r) => r.categoryName ?? t('shop.reports.categorySales.uncategorized') },
    { key: 'unitsSold', header: t('reports.shop.columns.unitsSold'), render: (r) => r.unitsSold },
    { key: 'revenue', header: t('reports.shop.columns.revenue'), render: (r) => <MoneyDisplay amount={r.revenue} size="sm" /> },
  ]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 print:hidden">
        <DateRangeBar startDate={startDate} endDate={endDate} setStartDate={setStartDate} setEndDate={setEndDate} />
        <ReportHeaderActions hasRows={rows.length > 0} />
      </div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.categorySales.title')} />
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.categoryId ?? '__uncategorized__'} isLoading={isLoading} emptyTitle={t('reports.shop.emptyTitle')} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// PAYMENT METHOD SALES (item 5) -- get_shop_payment_method_mix (C6),
// same date-range wrapper treatment, same "naturally small/bounded"
// no-pagination reasoning as Category Sales.
// ---------------------------------------------------------------------
interface PaymentMixRow { method: string; transactionCount: number; totalAmount: number }

export function ReportShopPaymentMethodSalesContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['shop-report-payment-mix', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_shop_payment_method_mix', { p_club_id: currentClubId as string, p_start_date: startDate || undefined, p_end_date: endDate || undefined })
      if (error) throw error
      return (data ?? []).map((r) => ({ method: r.method, transactionCount: Number(r.transaction_count), totalAmount: Number(r.total_amount) })) as PaymentMixRow[]
    },
    enabled: !!currentClubId,
  })

  const columns: DataTableColumn<PaymentMixRow>[] = [
    { key: 'method', header: t('shop.sales.filters.paymentMethod'), render: (r) => t(`common.paymentMethodLabels.${r.method}`, { defaultValue: PAYMENT_METHOD_LABELS[r.method] ?? r.method }) },
    { key: 'count', header: t('shop.reports.paymentMethodSales.transactions'), render: (r) => r.transactionCount },
    { key: 'total', header: t('shop.reports.paymentMethodSales.totalCollected'), render: (r) => <MoneyDisplay amount={r.totalAmount} size="sm" /> },
  ]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 print:hidden">
        <DateRangeBar startDate={startDate} endDate={endDate} setStartDate={setStartDate} setEndDate={setEndDate} />
        <ReportHeaderActions hasRows={rows.length > 0} />
      </div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.paymentMethodSales.title')} />
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.method} isLoading={isLoading} emptyTitle={t('reports.shop.emptyTitle')} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// CASHIER SALES (item 6) -- per the plan's own explicit suggestion,
// derived client-side from list_shop_sales (matching C6's own "Sales
// by Cashier" dashboard precedent, C5 report Section 3a) rather than a
// new RPC. Bounded to p_limit: 500 for the selected date range -- the
// exact same bound C6 used for its single-day dashboard rollup; here
// the range is user-controlled, so a very wide range with genuinely
// more than 500 sales will undercount -- documented in the on-screen
// note, not hidden.
// ---------------------------------------------------------------------
interface CashierSalesRow { cashierId: string; cashierName: string; transactionCount: number; grossSales: number; itemsSold: number }
interface SaleApiRowForCashier { sold_by: string | null; sold_by_name: string | null; total: number | string; item_count: number | string }

export function ReportShopCashierSalesContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data: sales = [], isLoading } = useQuery({
    queryKey: ['shop-report-cashier-sales-raw', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_shop_sales', {
        p_club_id: currentClubId as string, p_start_date: startDate || undefined, p_end_date: endDate || undefined, p_limit: 500,
      })
      if (error) throw error
      return (data ?? []) as SaleApiRowForCashier[]
    },
    enabled: !!currentClubId,
  })

  const rows = useMemo<CashierSalesRow[]>(() => {
    const byCashier = new Map<string, CashierSalesRow>()
    for (const s of sales) {
      const id = s.sold_by ?? '__unknown__'
      const name = s.sold_by_name ?? t('shop.reports.cashierSales.unknown')
      const existing = byCashier.get(id) ?? { cashierId: id, cashierName: name, transactionCount: 0, grossSales: 0, itemsSold: 0 }
      existing.transactionCount += 1
      existing.grossSales += Number(s.total)
      existing.itemsSold += Number(s.item_count)
      byCashier.set(id, existing)
    }
    return Array.from(byCashier.values()).sort((a, b) => b.grossSales - a.grossSales)
  }, [sales, t])

  const columns: DataTableColumn<CashierSalesRow>[] = [
    { key: 'cashier', header: t('shop.sales.columns.cashier'), render: (r) => r.cashierName },
    { key: 'count', header: t('shop.reports.paymentMethodSales.transactions'), render: (r) => r.transactionCount },
    { key: 'items', header: t('reports.shop.columns.unitsSold'), render: (r) => r.itemsSold },
    { key: 'gross', header: t('reports.shop.columns.revenue'), render: (r) => <MoneyDisplay amount={r.grossSales} size="sm" /> },
  ]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 print:hidden">
        <DateRangeBar startDate={startDate} endDate={endDate} setStartDate={setStartDate} setEndDate={setEndDate} />
        <ReportHeaderActions hasRows={rows.length > 0} />
      </div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.cashierSales.title')} />
        <p className="mb-2 text-xs text-text-secondary">{t('shop.reports.cashierSales.boundNote', { count: 500 })}</p>
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.cashierId} isLoading={isLoading} emptyTitle={t('reports.shop.emptyTitle')} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// CUSTOMER PURCHASES (item 7) -- get_customer_shop_purchases, extended
// this phase with date range + pagination. Needs a customer picker
// since the RPC is per-customer by design (unlike every other report
// here, which is club-wide).
// ---------------------------------------------------------------------
interface CustomerOption { id: string; label: string }
interface CustomerPurchaseRow {
  saleId: string; invoiceNumber: string; saleStatus: string; productNameAr: string; variantLabel: string | null
  quantity: number; unitPrice: number; lineTotal: number; returnedQuantity: number; createdAt: string
}
interface CustomerPurchaseApiRow {
  sale_id: string; invoice_number: string; sale_status: string; product_name_ar: string; variant_label: string | null
  quantity: number | string; unit_price: number | string; line_total: number | string; returned_quantity: number | string; created_at: string
}

function mapCustomerPurchases(rows: CustomerPurchaseApiRow[]): CustomerPurchaseRow[] {
  return rows.map((r) => ({
    saleId: r.sale_id, invoiceNumber: r.invoice_number, saleStatus: r.sale_status, productNameAr: r.product_name_ar, variantLabel: r.variant_label,
    quantity: Number(r.quantity), unitPrice: Number(r.unit_price), lineTotal: Number(r.line_total), returnedQuantity: Number(r.returned_quantity), createdAt: r.created_at,
  }))
}

export function ReportShopCustomerPurchasesContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { offset, setOffset, reset } = useOffsetPager()
  const [customerId, setCustomerId] = useState('')

  const { data: customers = [] } = useQuery({
    queryKey: ['shop-report-customers', currentClubId],
    queryFn: async () => {
      const { data, error } = await supabase.from('customers').select('id, full_name').eq('club_id', currentClubId as string).order('full_name').limit(200)
      if (error) throw error
      return (data ?? []).map((c) => ({ id: c.id, label: c.full_name })) as CustomerOption[]
    },
    enabled: !!currentClubId,
  })

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['shop-report-customer-purchases', currentClubId, customerId, startDate, endDate, offset],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_customer_shop_purchases', {
        p_club_id: currentClubId as string, p_customer_id: customerId, p_start_date: startDate || undefined, p_end_date: endDate || undefined,
        p_limit: REPORT_PAGE_SIZE, p_offset: offset,
      })
      if (error) throw error
      return mapCustomerPurchases((data ?? []) as CustomerPurchaseApiRow[])
    },
    enabled: !!currentClubId && !!customerId,
  })

  const columns: DataTableColumn<CustomerPurchaseRow>[] = [
    { key: 'invoice', header: t('shop.sales.columns.invoice'), render: (r) => <bdi>{r.invoiceNumber}</bdi> },
    { key: 'product', header: t('reports.shop.columns.product'), render: (r) => r.productNameAr + (r.variantLabel ? ` (${r.variantLabel})` : '') },
    { key: 'qty', header: t('shop.reports.customerPurchases.qty'), render: (r) => r.quantity },
    { key: 'unitPrice', header: t('shop.reports.customerPurchases.unitPrice'), render: (r) => <MoneyDisplay amount={r.unitPrice} size="sm" /> },
    { key: 'lineTotal', header: t('reports.shop.columns.revenue'), render: (r) => <MoneyDisplay amount={r.lineTotal} size="sm" /> },
    { key: 'returned', header: t('reports.shop.columns.unitsReturned'), render: (r) => r.returnedQuantity },
  ]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 print:hidden">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.sales.filters.customer')}</label>
            <Select value={customerId} onValueChange={(v) => { setCustomerId(v); reset() }}>
              <SelectTrigger className="w-56"><SelectValue placeholder={t('shop.sales.filters.customer')} /></SelectTrigger>
              <SelectContent>
                {customers.map((c) => <SelectItem key={c.id} value={c.id}><bdi>{c.label}</bdi></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DateRangeBar startDate={startDate} endDate={endDate} setStartDate={(v) => { setStartDate(v); reset() }} setEndDate={(v) => { setEndDate(v); reset() }} />
        </div>
        <ReportHeaderActions hasRows={rows.length > 0} />
      </div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.customerPurchases.title')} filterSummary={customers.find((c) => c.id === customerId)?.label} />
        {!customerId ? (
          <p className="py-8 text-center text-sm text-text-secondary">{t('shop.reports.customerPurchases.pickCustomer')}</p>
        ) : (
          <>
            <DataTable columns={columns} rows={rows} rowKey={(r) => `${r.saleId}-${r.productNameAr}-${r.createdAt}`} isLoading={isLoading} emptyTitle={t('reports.shop.emptyTitle')} />
            <PagerControls offset={offset} pageSize={REPORT_PAGE_SIZE} rowCount={rows.length} onPrev={() => setOffset(Math.max(0, offset - REPORT_PAGE_SIZE))} onNext={() => setOffset(offset + REPORT_PAGE_SIZE)} />
          </>
        )}
      </div>
    </div>
  )
}
