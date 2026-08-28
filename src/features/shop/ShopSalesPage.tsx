import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatDate, type SupportedLocale } from '@/lib/i18n/config'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { StatCard } from '@/components/ui/stat-card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
import { ReportPrintButton, ReportPrintHeader } from '@/components/ui/report-print-header'
import { fetchFullReport } from '@/lib/fetchFullReport'
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/billing'
import { Printer, Receipt, Search, Wallet, ShoppingBag, TrendingDown, TrendingUp } from 'lucide-react'
import { ShopInvoiceDialog } from '@/features/shop/ShopInvoiceDocument'

// COMMERCIAL MODULE (2026-08-26), rebuilt for COMMERCE PRO C5
// (2026-08-28) -- Sales history + KPIs + filters + Returns UX (plan
// Section 43/44/64 and COMMERCE_PRO_UPGRADE_PLAN.md Phase C5).
interface SaleRow {
  saleId: string
  invoiceNumber: string
  customerName: string | null
  soldById: string | null
  soldByName: string | null
  status: string
  total: number
  createdAt: string
  branchId: string | null
  itemCount: number
  discountAmount: number
  refundAmount: number
}

interface SaleItemRow {
  itemId: string
  productNameAr: string
  variantLabel: string | null
  sku: string | null
  quantity: number
  unitPrice: number
  lineTotal: number
  returnedQuantity: number
}

interface SaleApiRow {
  sale_id: string; invoice_number: string; customer_name: string | null; sold_by: string | null; sold_by_name: string | null; status: string
  total: number | string; created_at: string; branch_id: string | null; item_count: number | string
  discount_amount: number | string; refund_amount: number | string
}

interface KpiData {
  transactionCount: number
  grossSales: number
  discountTotal: number
  refundTotal: number
  netSales: number
  itemsSold: number
  averageBasket: number
}

interface SalePaymentRow {
  paymentId: string
  amount: number
  method: string
  reference: string | null
  receivedAt: string
  receivedByName: string | null
}

interface SaleInvoiceData {
  saleId: string
  clubId: string
  invoiceId: string
  invoiceNumber: string
  customerName: string | null
  soldByName: string | null
  createdAt: string
  subtotal: number
  discountAmount: number
  discountReason: string | null
  total: number
  // invoices.status ('draft'/'issued'/'void') -- distinct from
  // saleStatus below (shop_sales.status). Not used for the Sales page
  // status badge or return-eligibility check -- that must be the
  // sale's own status, not the invoice's.
  invoiceStatus: string
  // shop_sales.status ('draft'/'completed'/'cancelled'/
  // 'partially_returned'/'returned') -- the real state return_shop_sale
  // itself checks against ('completed'/'partially_returned') before
  // allowing a return. Added in this phase after finding
  // invoiceStatus was being conflated with this during self-review --
  // see 20260828150300_shop_sale_invoice_data_sale_status.sql.
  saleStatus: string
  payments: SalePaymentRow[]
}

interface ReturnHistoryLine {
  saleItemId: string
  quantity: number
  productNameAr: string
  variantLabel: string | null
}

interface ReturnHistoryRow {
  returnId: string
  processedByName: string | null
  restock: boolean
  reason: string
  createdAt: string
  refundAmount: number | null
  refundMethod: string | null
  refundStatus: string | null
  lines: ReturnHistoryLine[]
}

function mapSaleRows(rows: SaleApiRow[]): SaleRow[] {
  return rows.map((r) => ({
    saleId: r.sale_id, invoiceNumber: r.invoice_number, customerName: r.customer_name, soldById: r.sold_by, soldByName: r.sold_by_name, status: r.status,
    total: Number(r.total), createdAt: r.created_at, branchId: r.branch_id, itemCount: Number(r.item_count),
    discountAmount: Number(r.discount_amount), refundAmount: Number(r.refund_amount),
  }))
}

interface SalesFilters {
  startDate: string
  endDate: string
  branchId: string
  cashierId: string
  customerId: string
  paymentMethod: string
  categoryId: string
  productId: string
  invoiceNumber: string
  status: string
}

const EMPTY_FILTERS: SalesFilters = {
  startDate: '', endDate: '', branchId: '', cashierId: '', customerId: '', paymentMethod: '',
  categoryId: '', productId: '', invoiceNumber: '', status: '',
}

function todayFilters(): SalesFilters {
  const today = new Date().toISOString().slice(0, 10)
  return { ...EMPTY_FILTERS, startDate: today, endDate: today }
}

function filtersToRpcArgs(clubId: string, f: SalesFilters) {
  return {
    p_club_id: clubId,
    p_start_date: f.startDate || undefined,
    p_end_date: f.endDate || undefined,
    p_branch_id: f.branchId || undefined,
    p_cashier_id: f.cashierId || undefined,
    p_customer_id: f.customerId || undefined,
    p_payment_method: f.paymentMethod || undefined,
    p_category_id: f.categoryId || undefined,
    p_product_id: f.productId || undefined,
    p_invoice_number: f.invoiceNumber || undefined,
    p_status: f.status || undefined,
  }
}

async function fetchSales(clubId: string, filters: SalesFilters): Promise<SaleRow[]> {
  const { data, error } = await supabase.rpc('list_shop_sales', { ...filtersToRpcArgs(clubId, filters), p_limit: 50 })
  if (error) throw error
  return mapSaleRows((data ?? []) as SaleApiRow[])
}

async function fetchKpis(clubId: string, filters: SalesFilters): Promise<KpiData> {
  const { data, error } = await supabase.rpc('get_shop_sales_kpis', filtersToRpcArgs(clubId, filters)).maybeSingle()
  if (error) throw error
  return {
    transactionCount: Number(data?.transaction_count ?? 0),
    grossSales: Number(data?.gross_sales ?? 0),
    discountTotal: Number(data?.discount_total ?? 0),
    refundTotal: Number(data?.refund_total ?? 0),
    netSales: Number(data?.net_sales ?? 0),
    itemsSold: Number(data?.items_sold ?? 0),
    averageBasket: Number(data?.average_basket ?? 0),
  }
}

async function fetchSaleDetail(saleId: string): Promise<SaleItemRow[]> {
  const { data, error } = await supabase.rpc('get_shop_sale_detail', { p_sale_id: saleId })
  if (error) throw error
  return (data ?? []).map((r) => ({
    itemId: r.item_id, productNameAr: r.product_name_ar, variantLabel: r.variant_label, sku: r.sku ?? null,
    quantity: Number(r.quantity), unitPrice: Number(r.unit_price), lineTotal: Number(r.line_total),
    returnedQuantity: Number(r.returned_quantity),
  }))
}

async function fetchSaleInvoiceData(saleId: string): Promise<SaleInvoiceData> {
  const { data, error } = await supabase.rpc('get_shop_sale_invoice_data', { p_sale_id: saleId }).maybeSingle()
  if (error) throw error
  if (!data) throw new Error('sale not found')
  const payments = (Array.isArray(data.payments) ? data.payments : []) as unknown as Array<{
    payment_id: string; amount: number | string; method: string; reference: string | null; received_at: string; received_by_name: string | null
  }>
  return {
    saleId: data.sale_id, clubId: data.club_id, invoiceId: data.invoice_id, invoiceNumber: data.invoice_number,
    customerName: data.customer_name, soldByName: data.sold_by_name, createdAt: data.created_at,
    subtotal: Number(data.subtotal), discountAmount: Number(data.discount_amount), discountReason: data.discount_reason,
    total: Number(data.total), invoiceStatus: data.invoice_status, saleStatus: data.sale_status,
    payments: payments.map((p) => ({
      paymentId: p.payment_id, amount: Number(p.amount), method: p.method, reference: p.reference,
      receivedAt: p.received_at, receivedByName: p.received_by_name,
    })),
  }
}

async function fetchReturnsHistory(saleId: string): Promise<ReturnHistoryRow[]> {
  const { data, error } = await supabase.rpc('get_shop_sale_returns_history', { p_sale_id: saleId })
  if (error) throw error
  return (data ?? []).map((r) => ({
    returnId: r.return_id, processedByName: r.processed_by_name, restock: r.restock, reason: r.reason,
    createdAt: r.created_at, refundAmount: r.refund_amount === null ? null : Number(r.refund_amount),
    refundMethod: r.refund_method, refundStatus: r.refund_status,
    lines: (Array.isArray(r.lines) ? r.lines : []) as unknown as ReturnHistoryLine[],
  }))
}

async function findSaleByInvoiceNumber(clubId: string, invoiceNumber: string): Promise<SaleRow[]> {
  const { data, error } = await supabase.rpc('list_shop_sales', {
    p_club_id: clubId, p_invoice_number: invoiceNumber, p_limit: 10,
  })
  if (error) throw error
  return mapSaleRows((data ?? []) as SaleApiRow[])
}

interface FilterOption { id: string; label: string }

async function fetchBranches(clubId: string): Promise<FilterOption[]> {
  const { data, error } = await supabase.from('branches').select('id, name').eq('club_id', clubId).order('name')
  if (error) throw error
  return (data ?? []).map((b) => ({ id: b.id, label: b.name }))
}

async function fetchCategories(clubId: string): Promise<FilterOption[]> {
  const { data, error } = await supabase.rpc('list_shop_categories', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((c) => ({ id: c.category_id, label: c.name_ar }))
}

async function fetchProducts(clubId: string): Promise<FilterOption[]> {
  const { data, error } = await supabase.rpc('list_shop_products', { p_club_id: clubId, p_status: undefined })
  if (error) throw error
  return (data ?? []).map((p) => ({ id: p.product_id, label: p.name_ar }))
}

async function fetchCustomersForFilter(clubId: string): Promise<FilterOption[]> {
  const { data, error } = await supabase
    .from('customers')
    .select('id, full_name')
    .eq('club_id', clubId)
    .order('full_name')
    .limit(200)
  if (error) throw error
  return (data ?? []).map((c) => ({ id: c.id, label: c.full_name }))
}

const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'wallet', 'other']

const STATUS_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'danger'> = {
  completed: 'success', partially_returned: 'warning', returned: 'neutral', cancelled: 'danger', draft: 'neutral',
}

const ALL_VALUE = '__all__'

export function ShopSalesPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { locale } = useDirection()
  const [returningSale, setReturningSale] = useState<SaleRow | null>(null)
  const [viewingInvoiceSaleId, setViewingInvoiceSaleId] = useState<string | null>(null)
  const [viewingDetailSaleId, setViewingDetailSaleId] = useState<string | null>(null)
  const [filters, setFilters] = useState<SalesFilters>(todayFilters)
  const [returnLookupOpen, setReturnLookupOpen] = useState(false)

  const patchFilter = (patch: Partial<SalesFilters>) => setFilters((cur) => ({ ...cur, ...patch }))

  const { data: sales = [], isLoading } = useQuery({
    queryKey: ['shop-sales', currentClubId, filters],
    queryFn: () => fetchSales(currentClubId as string, filters),
    enabled: !!currentClubId,
  })
  const { data: kpis } = useQuery({
    queryKey: ['shop-sales-kpis', currentClubId, filters],
    queryFn: () => fetchKpis(currentClubId as string, filters),
    enabled: !!currentClubId,
  })
  const { data: branches = [] } = useQuery({ queryKey: ['shop-filter-branches', currentClubId], queryFn: () => fetchBranches(currentClubId as string), enabled: !!currentClubId })
  const { data: categories = [] } = useQuery({ queryKey: ['shop-filter-categories', currentClubId], queryFn: () => fetchCategories(currentClubId as string), enabled: !!currentClubId })
  const { data: products = [] } = useQuery({ queryKey: ['shop-filter-products', currentClubId], queryFn: () => fetchProducts(currentClubId as string), enabled: !!currentClubId })
  const { data: filterCustomers = [] } = useQuery({ queryKey: ['shop-filter-customers', currentClubId], queryFn: () => fetchCustomersForFilter(currentClubId as string), enabled: !!currentClubId })
  // Cashier filter options are derived from the currently-loaded sales
  // rows themselves (each row already carries sold_by/sold_by_name from
  // list_shop_sales) rather than a separate query -- shop_sales.sold_by
  // references auth.users directly (not profiles), so there is no FK
  // path PostgREST could embed profiles through from shop_sales, and no
  // dedicated "list club staff" RPC exists to resolve names otherwise.
  // This keeps the dropdown scoped to cashiers who actually appear in
  // the visible sales history, which is what staff care about here.
  const cashiers = useMemo<FilterOption[]>(() => {
    const seen = new Map<string, string>()
    for (const s of sales) {
      if (s.soldById && !seen.has(s.soldById)) seen.set(s.soldById, s.soldByName ?? s.soldById)
    }
    return Array.from(seen.entries()).map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [sales])

  // PRINTING -- FULL FILTERED PRINT: screen stays bounded to 50
  // (unchanged). "Print Full Report" pages through the same RPC with
  // the SAME filters currently applied via fetchFullReport() -- capped,
  // chunked, never silent.
  const [fullSales, setFullSales] = useState<SaleRow[] | null>(null)
  const [fullSalesTruncated, setFullSalesTruncated] = useState(false)
  const fullPrintMutation = useMutation({
    mutationFn: () => fetchFullReport<SaleApiRow>('list_shop_sales', filtersToRpcArgs(currentClubId as string, filters)),
    onSuccess: (result) => {
      setFullSales(mapSaleRows(result.rows))
      setFullSalesTruncated(result.truncated)
      requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
    },
  })
  const printedSales = fullSales ?? sales

  useEffect(() => {
    if (fullSales === null) return
    const handler = () => { setFullSales(null); setFullSalesTruncated(false) }
    window.addEventListener('afterprint', handler)
    return () => window.removeEventListener('afterprint', handler)
  }, [fullSales])

  const columns: DataTableColumn<SaleRow>[] = [
    {
      key: 'invoice',
      header: t('shop.sales.columns.invoice'),
      render: (s) => (
        <button
          data-testid={`shop-sale-row-${s.saleId}`}
          className="text-accent-foreground hover:underline"
          onClick={() => setViewingDetailSaleId(s.saleId)}
        >
          <bdi>{s.invoiceNumber}</bdi>
        </button>
      ),
    },
    { key: 'customer', header: t('shop.sales.columns.customer'), render: (s) => s.customerName ?? '—' },
    { key: 'cashier', header: t('shop.sales.columns.cashier'), render: (s) => s.soldByName ?? '—' },
    { key: 'items', header: t('shop.sales.columns.items'), render: (s) => s.itemCount },
    { key: 'date', header: t('shop.sales.columns.date'), render: (s) => formatDate(s.createdAt, locale as SupportedLocale, 'Africa/Cairo', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },
    { key: 'total', header: t('shop.sales.columns.total'), render: (s) => <MoneyDisplay amount={s.total} size="sm" /> },
    { key: 'discount', header: t('shop.sales.columns.discount'), render: (s) => (s.discountAmount > 0 ? <MoneyDisplay amount={s.discountAmount} size="sm" tone="danger" /> : '—') },
    { key: 'refund', header: t('shop.sales.columns.refund'), render: (s) => (s.refundAmount > 0 ? <MoneyDisplay amount={s.refundAmount} size="sm" tone="danger" /> : '—') },
    { key: 'net', header: t('shop.sales.columns.net'), render: (s) => <MoneyDisplay amount={s.total - s.refundAmount} size="sm" /> },
    {
      key: 'status',
      header: t('shop.sales.columns.status'),
      render: (s) => <StatusBadge tone={STATUS_TONE[s.status] ?? 'neutral'} label={t(`shop.sales.status.${s.status}`, { defaultValue: s.status })} />,
    },
    {
      key: 'actions',
      header: '',
      render: (s) => (
        <div className="flex items-center gap-1 print:hidden">
          <Button variant="ghost" size="sm" data-testid={`shop-sale-row-${s.saleId}-view-invoice`} onClick={() => setViewingInvoiceSaleId(s.saleId)}>
            <Printer className="me-1 size-4" aria-hidden="true" />
            {t('shop.sales.viewInvoice')}
          </Button>
          {(s.status === 'completed' || s.status === 'partially_returned') && (
            <Button variant="ghost" size="sm" data-testid={`shop-sale-row-${s.saleId}-process-return`} onClick={() => setReturningSale(s)}>{t('shop.sales.processReturn')}</Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div>
      <div className="print:hidden">
        <PageHeader
          title={t('shop.sales.title')}
          description={t('shop.sales.description')}
          actions={
            <>
              <Button variant="outline" size="sm" data-testid="sales-find-for-return" onClick={() => setReturnLookupOpen(true)}>
                <Search className="me-1 size-4" aria-hidden="true" />
                {t('shop.sales.findSaleForReturn')}
              </Button>
              {sales.length > 0 && (
                <>
                  <ReportPrintButton />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={fullPrintMutation.isPending}
                    onClick={() => { setFullSales(null); fullPrintMutation.mutate() }}
                  >
                    <Printer className="me-1 size-4" />
                    {fullPrintMutation.isPending ? t('reports.printFullPreparing') : t('reports.printFull')}
                  </Button>
                </>
              )}
            </>
          }
        />

        {/* KPI row -- plan Section 1: Today Sales, Transactions, Average
            Basket, Items Sold, Refunds, Net Sales. Reflects whatever
            filters are currently applied (defaults to "today"), not a
            hardcoded server-side "today" independent of the filter UI. */}
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="sales-kpi-row">
          <StatCard label={t('shop.sales.kpi.grossSales')} value={<span data-testid="sales-kpi-gross-sales"><MoneyDisplay amount={kpis?.grossSales ?? 0} size="md" /></span>} icon={ShoppingBag} />
          <StatCard label={t('shop.sales.kpi.transactions')} value={<span data-testid="sales-kpi-transactions">{kpis?.transactionCount ?? 0}</span>} icon={Receipt} />
          <StatCard label={t('shop.sales.kpi.averageBasket')} value={<MoneyDisplay amount={kpis?.averageBasket ?? 0} size="md" />} icon={TrendingUp} />
          <StatCard label={t('shop.sales.kpi.itemsSold')} value={kpis?.itemsSold ?? 0} icon={Wallet} />
          <StatCard label={t('shop.sales.kpi.refunds')} value={<MoneyDisplay amount={kpis?.refundTotal ?? 0} size="md" />} icon={TrendingDown} tone={kpis && kpis.refundTotal > 0 ? 'danger' : 'default'} />
          <StatCard label={t('shop.sales.kpi.netSales')} value={<span data-testid="sales-kpi-net-sales"><MoneyDisplay amount={kpis?.netSales ?? 0} size="md" /></span>} icon={ShoppingBag} tone="success" />
        </div>

        {/* Filters -- plan Section 2: date range, branch, cashier,
            customer, payment method, category, product, invoice number,
            sale status. Server-side (list_shop_sales/get_shop_sales_kpis
            both filter in the RPC, never client-side on a full fetch). */}
        <div className="mb-4 grid grid-cols-2 gap-2 rounded-md border border-border p-3 sm:grid-cols-3 lg:grid-cols-5">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.sales.filters.startDate')}</label>
            <Input type="date" value={filters.startDate} onChange={(e) => patchFilter({ startDate: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.sales.filters.endDate')}</label>
            <Input type="date" value={filters.endDate} onChange={(e) => patchFilter({ endDate: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.sales.filters.invoiceNumber')}</label>
            <Input value={filters.invoiceNumber} onChange={(e) => patchFilter({ invoiceNumber: e.target.value })} placeholder={t('shop.sales.filters.invoiceNumberPlaceholder')} />
          </div>
          <FilterSelect
            label={t('shop.sales.filters.branch')}
            value={filters.branchId}
            onChange={(v) => patchFilter({ branchId: v })}
            options={branches}
            allLabel={t('shop.sales.filters.allBranches')}
          />
          <FilterSelect
            label={t('shop.sales.filters.cashier')}
            value={filters.cashierId}
            onChange={(v) => patchFilter({ cashierId: v })}
            options={cashiers}
            allLabel={t('shop.sales.filters.allCashiers')}
          />
          <FilterSelect
            label={t('shop.sales.filters.customer')}
            value={filters.customerId}
            onChange={(v) => patchFilter({ customerId: v })}
            options={filterCustomers}
            allLabel={t('shop.sales.filters.allCustomers')}
          />
          <FilterSelect
            label={t('shop.sales.filters.paymentMethod')}
            value={filters.paymentMethod}
            onChange={(v) => patchFilter({ paymentMethod: v })}
            options={PAYMENT_METHODS.map((m) => ({ id: m, label: t(`common.paymentMethodLabels.${m}`, { defaultValue: PAYMENT_METHOD_LABELS[m] ?? m }) }))}
            allLabel={t('shop.sales.filters.allPaymentMethods')}
          />
          <FilterSelect
            label={t('shop.sales.filters.category')}
            value={filters.categoryId}
            onChange={(v) => patchFilter({ categoryId: v })}
            options={categories}
            allLabel={t('shop.sales.filters.allCategories')}
          />
          <FilterSelect
            label={t('shop.sales.filters.product')}
            value={filters.productId}
            onChange={(v) => patchFilter({ productId: v })}
            options={products}
            allLabel={t('shop.sales.filters.allProducts')}
          />
          <FilterSelect
            label={t('shop.sales.filters.status')}
            value={filters.status}
            onChange={(v) => patchFilter({ status: v })}
            options={Object.keys(STATUS_TONE).map((s) => ({ id: s, label: t(`shop.sales.status.${s}`) }))}
            allLabel={t('shop.sales.filters.allStatuses')}
          />
          <div className="flex items-end">
            <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>{t('shop.sales.filters.clear')}</Button>
          </div>
        </div>
      </div>

      {/* COMMERCE PRO C4/C5: this list's own print-target must stop
          being "visible for print" while a dialog with its own
          print-target is open on top of it (Radix Dialog doesn't
          unmount this page underneath an opened Dialog), matching
          BillingPage.tsx's own established pattern. */}
      <div className={`print-target ${(viewingInvoiceSaleId || viewingDetailSaleId || returningSale) ? '' : 'visible-for-print'}`}>
        <ReportPrintHeader reportName={t('shop.sales.title')} />
        {fullSales !== null ? (
          <>
            <p className="mb-2 text-xs text-text-secondary">{t('reports.printFullRowCount', { count: fullSales.length })}</p>
            {fullSalesTruncated && (
              <p className="mb-2 text-xs font-medium text-status-warning">{t('reports.printFullTruncated')}</p>
            )}
          </>
        ) : (
          <p className="mb-2 text-xs text-text-secondary print:block hidden">{t('shop.sales.printLimitNote', { count: 50 })}</p>
        )}
        <DataTable columns={columns} rows={printedSales} rowKey={(s) => s.saleId} isLoading={isLoading} emptyTitle={t('shop.sales.emptyTitle')} emptyDescription={t('shop.sales.emptyDescription')} />
      </div>

      {returnLookupOpen && (
        <ReturnLookupDialog
          onClose={() => setReturnLookupOpen(false)}
          onFound={(sale) => { setReturnLookupOpen(false); setReturningSale(sale) }}
        />
      )}

      {returningSale && (
        <ReturnDialog sale={returningSale} onClose={() => setReturningSale(null)} />
      )}

      {viewingInvoiceSaleId && (
        <ShopInvoiceDialog saleId={viewingInvoiceSaleId} onClose={() => setViewingInvoiceSaleId(null)} />
      )}

      {viewingDetailSaleId && (
        <SaleDetailDialog
          saleId={viewingDetailSaleId}
          onClose={() => setViewingDetailSaleId(null)}
          onPrintInvoice={() => { setViewingInvoiceSaleId(viewingDetailSaleId); setViewingDetailSaleId(null) }}
          onProcessReturn={(sale) => { setViewingDetailSaleId(null); setReturningSale(sale) }}
        />
      )}
    </div>
  )
}

function FilterSelect({ label, value, onChange, options, allLabel }: {
  label: string; value: string; onChange: (v: string) => void; options: FilterOption[]; allLabel: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-text-secondary">{label}</label>
      <Select value={value || ALL_VALUE} onValueChange={(v) => onChange(v === ALL_VALUE ? '' : v)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>{allLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}><bdi>{o.label}</bdi></SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

// Non-printable operational Sale Detail panel -- distinct from
// ShopInvoiceDialog (C4's printable A4/80mm document). Shows fuller
// operational info the printable document deliberately omits: per-line
// returned quantity, full payment list, and full return/refund
// history. Reuses get_shop_sale_detail/get_shop_sale_invoice_data
// (already built by C4) plus the new get_shop_sale_returns_history --
// no duplicated data-fetching logic beyond what's genuinely new.
function SaleDetailDialog({ saleId, onClose, onPrintInvoice, onProcessReturn }: {
  saleId: string
  onClose: () => void
  onPrintInvoice: () => void
  onProcessReturn: (sale: SaleRow) => void
}) {
  const { t } = useTranslation()
  const { locale } = useDirection()

  const { data: sale, isLoading: saleLoading, isError, error, refetch } = useQuery({
    queryKey: ['shop-sale-invoice-data', saleId],
    queryFn: () => fetchSaleInvoiceData(saleId),
  })
  const { data: items = [], isLoading: itemsLoading } = useQuery({
    queryKey: ['shop-sale-detail', saleId],
    queryFn: () => fetchSaleDetail(saleId),
  })
  const { data: returnsHistory = [] } = useQuery({
    queryKey: ['shop-sale-returns-history', saleId],
    queryFn: () => fetchReturnsHistory(saleId),
  })

  const isLoading = saleLoading || itemsLoading
  const paid = sale?.payments.reduce((sum, p) => sum + p.amount, 0) ?? 0
  // Real gate: shop_sales.status, the same state return_shop_sale
  // itself checks ('completed'/'partially_returned' only) -- not
  // invoices.status, which is a different state machine.
  const canReturn = sale && (sale.saleStatus === 'completed' || sale.saleStatus === 'partially_returned')

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{sale ? t('shop.sales.detail.title', { invoice: sale.invoiceNumber }) : t('shop.sales.detail.titleGeneric')}</DialogTitle>
        </DialogHeader>
        {isLoading && (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {isError && <ErrorState message={translateSupabaseError(error, t('shop.invoice.loadError'))} onRetry={() => void refetch()} />}
        {!isLoading && sale && (
          <div className="flex flex-col gap-4 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div><p className="text-xs text-text-secondary">{t('shop.sales.detail.customer')}</p><p>{sale.customerName ?? '—'}</p></div>
              <div><p className="text-xs text-text-secondary">{t('shop.invoice.cashier')}</p><p>{sale.soldByName ?? '—'}</p></div>
              <div><p className="text-xs text-text-secondary">{t('shop.sales.columns.date')}</p><p>{formatDate(sale.createdAt, locale as SupportedLocale, 'Africa/Cairo', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p></div>
              <div><p className="text-xs text-text-secondary">{t('shop.sales.columns.status')}</p><StatusBadge tone={STATUS_TONE[sale.saleStatus] ?? 'neutral'} label={t(`shop.sales.status.${sale.saleStatus}`, { defaultValue: sale.saleStatus })} /></div>
            </div>

            <div>
              <p className="mb-1 font-medium">{t('shop.sales.detail.items')}</p>
              <div className="flex flex-col gap-1">
                {items.map((item) => (
                  <div key={item.itemId} className="flex items-center justify-between rounded-md border border-border p-2">
                    <div>
                      <p>{item.productNameAr}{item.variantLabel ? ` (${item.variantLabel})` : ''}</p>
                      <p className="text-xs text-text-secondary">
                        {t('shop.sales.detail.qtyAndPrice', { qty: item.quantity, price: item.unitPrice })}
                        {item.returnedQuantity > 0 && ` · ${t('shop.sales.detail.returnedQty', { count: item.returnedQuantity })}`}
                      </p>
                    </div>
                    <MoneyDisplay amount={item.lineTotal} size="sm" />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col items-end gap-1 border-t border-border pt-2">
              <div className="flex items-center gap-2"><span className="text-xs text-text-secondary">{t('shop.invoice.subtotal')}</span><MoneyDisplay amount={sale.subtotal} size="sm" /></div>
              {sale.discountAmount > 0 && (
                <div className="flex items-center gap-2"><span className="text-xs text-text-secondary">{t('shop.invoice.discount')}</span><MoneyDisplay amount={sale.discountAmount} size="sm" tone="danger" /></div>
              )}
              <div className="flex items-center gap-2"><span className="text-xs text-text-secondary">{t('billing.detail.total')}</span><MoneyDisplay amount={sale.total} size="md" /></div>
              <div className="flex items-center gap-2"><span className="text-xs text-text-secondary">{t('billing.detail.paid')}</span><MoneyDisplay amount={paid} size="sm" tone="success" /></div>
            </div>

            {sale.payments.length > 0 && (
              <div>
                <p className="mb-1 font-medium">{t('billing.detail.paymentsHeading')}</p>
                <div className="flex flex-col gap-1">
                  {sale.payments.map((p) => (
                    <div key={p.paymentId} className="flex items-center justify-between rounded-md border border-border p-2 text-xs">
                      <span>{t(`common.paymentMethodLabels.${p.method}`, { defaultValue: PAYMENT_METHOD_LABELS[p.method] ?? p.method })}</span>
                      <span className="flex items-center gap-2">
                        <MoneyDisplay amount={p.amount} size="sm" />
                        <span className="text-text-secondary">{formatDate(p.receivedAt, locale as SupportedLocale, 'Africa/Cairo', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {returnsHistory.length > 0 && (
              <div>
                <p className="mb-1 font-medium">{t('shop.sales.detail.returnsHistory')}</p>
                <div className="flex flex-col gap-2">
                  {returnsHistory.map((r) => (
                    <div key={r.returnId} className="rounded-md border border-border p-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span>{formatDate(r.createdAt, locale as SupportedLocale, 'Africa/Cairo', { year: 'numeric', month: 'short', day: 'numeric' })} · {r.processedByName ?? '—'}</span>
                        {r.refundAmount !== null && <MoneyDisplay amount={r.refundAmount} size="sm" tone="danger" />}
                      </div>
                      <p className="mt-1 text-text-secondary">{r.reason}</p>
                      <ul className="mt-1 list-inside list-disc">
                        {r.lines.map((line) => (
                          <li key={line.saleItemId}>{line.productNameAr}{line.variantLabel ? ` (${line.variantLabel})` : ''} × {line.quantity}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
              <Button variant="outline" onClick={onPrintInvoice}>
                <Printer className="me-1 size-4" aria-hidden="true" />
                {t('shop.sales.viewInvoice')}
              </Button>
              {canReturn && (
                <Button onClick={() => onProcessReturn({
                  saleId: sale.saleId, invoiceNumber: sale.invoiceNumber, customerName: sale.customerName,
                  soldById: null, soldByName: sale.soldByName, status: sale.saleStatus, total: sale.total, createdAt: sale.createdAt,
                  branchId: null, itemCount: items.length, discountAmount: sale.discountAmount, refundAmount: 0,
                })}>
                  {t('shop.sales.processReturn')}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Returns UX entry point: real invoice-number lookup, per plan Section
// 4 ("Rebuild starting from a real sale/invoice/receipt lookup -- not a
// raw form"). Also reachable directly from a sales-list row action or
// from SaleDetailDialog -- this dialog is only needed when staff has no
// row in front of them yet (e.g. a customer walks up with a printed
// receipt and its invoice number).
function ReturnLookupDialog({ onClose, onFound }: { onClose: () => void; onFound: (sale: SaleRow) => void }) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { locale } = useDirection()
  const [search, setSearch] = useState('')
  const [submitted, setSubmitted] = useState('')

  const { data: results = [], isLoading, isFetched } = useQuery({
    queryKey: ['shop-return-lookup', currentClubId, submitted],
    queryFn: () => findSaleByInvoiceNumber(currentClubId as string, submitted),
    enabled: !!currentClubId && submitted.length > 0,
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('shop.sales.findSaleForReturn')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Input
              autoFocus
              data-testid="return-lookup-input"
              placeholder={t('shop.sales.filters.invoiceNumberPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSubmitted(search.trim()) }}
            />
            <Button data-testid="return-lookup-submit" onClick={() => setSubmitted(search.trim())} disabled={!search.trim()}>
              <Search className="size-4" aria-hidden="true" />
            </Button>
          </div>
          {isLoading && <Skeleton className="h-16 w-full" />}
          {isFetched && submitted && results.length === 0 && (
            <p className="text-sm text-text-secondary" data-testid="return-lookup-empty">{t('shop.sales.returnLookupEmpty')}</p>
          )}
          <div className="flex flex-col gap-1">
            {results.map((s) => (
              <button
                key={s.saleId}
                data-testid={`return-lookup-result-${s.saleId}`}
                className="flex items-center justify-between rounded-md border border-border p-2 text-start text-sm hover:bg-muted/40"
                onClick={() => onFound(s)}
                disabled={!(s.status === 'completed' || s.status === 'partially_returned')}
              >
                <span>
                  <bdi className="font-medium">{s.invoiceNumber}</bdi>
                  <span className="ms-2 text-text-secondary">{s.customerName ?? '—'}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary">{formatDate(s.createdAt, locale as SupportedLocale, 'Africa/Cairo', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                  <MoneyDisplay amount={s.total} size="sm" />
                  <StatusBadge tone={STATUS_TONE[s.status] ?? 'neutral'} label={t(`shop.sales.status.${s.status}`, { defaultValue: s.status })} />
                </span>
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const RETURN_REASONS = ['defective', 'incorrect_item', 'customer_return', 'other'] as const

// Returns UX rebuild (plan Section 4) -- shows purchased qty, already-
// returned qty, remaining refundable qty per line, prior refund total,
// a real REFUND SUMMARY before confirming (merchandise refund total,
// previous refund total, new refund amount, remaining refundable
// value), and -- the payment-selection-ambiguity fix -- lets staff pick
// WHICH payment to refund against when a sale has more than one
// (return_shop_sale's new, additive, optional p_payment_id).
//
// Reason: kept free-text (existing return_shop_sale.p_reason is
// already a plain, non-enum text column with no schema constraint
// beyond "not null/not empty" -- confirmed via direct read of
// 20260826210846_shop_sales_schema.sql). A reason-CODE picker is
// layered on top in the UI only (four common categories + "other" with
// its own free-text sub-field) -- no new enum/schema constraint
// invented, matching the task's own explicit instruction not to add
// one unless the existing free-text field couldn't satisfy this
// cleanly (it can).
function ReturnDialog({ sale, onClose }: { sale: SaleRow; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({})
  const [restock, setRestock] = useState(true)
  const [reasonCode, setReasonCode] = useState<typeof RETURN_REASONS[number]>('customer_return')
  const [reasonOther, setReasonOther] = useState('')
  const [selectedPaymentId, setSelectedPaymentId] = useState<string>('')
  const [refundEnabled, setRefundEnabled] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const { data: items = [] } = useQuery({ queryKey: ['shop-sale-detail', sale.saleId], queryFn: () => fetchSaleDetail(sale.saleId) })
  const { data: invoiceData } = useQuery({ queryKey: ['shop-sale-invoice-data', sale.saleId], queryFn: () => fetchSaleInvoiceData(sale.saleId) })
  const { data: returnsHistory = [] } = useQuery({ queryKey: ['shop-sale-returns-history', sale.saleId], queryFn: () => fetchReturnsHistory(sale.saleId) })

  const reason = reasonCode === 'other' ? reasonOther.trim() : t(`shop.sales.returnReasons.${reasonCode}`)

  const merchandiseRefundTotal = useMemo(() => {
    return items.reduce((sum, item) => {
      const qty = returnQuantities[item.itemId] ?? 0
      if (qty <= 0) return sum
      const unitNet = item.lineTotal / item.quantity
      return sum + unitNet * qty
    }, 0)
  }, [items, returnQuantities])

  const previousRefundTotal = useMemo(
    () => returnsHistory.reduce((sum, r) => sum + (r.refundAmount ?? 0), 0),
    [returnsHistory],
  )

  const paidTotal = invoiceData?.payments.reduce((sum, p) => sum + p.amount, 0) ?? 0
  const remainingRefundableValue = Math.max(0, paidTotal - previousRefundTotal - merchandiseRefundTotal)
  const newRefundAmount = refundEnabled ? merchandiseRefundTotal : 0
  const payments = invoiceData?.payments ?? []
  const needsPaymentChoice = refundEnabled && newRefundAmount > 0 && payments.length > 1

  const returnMutation = useMutation({
    mutationFn: async () => {
      const lines = Object.entries(returnQuantities)
        .filter(([, qty]) => qty > 0)
        .map(([itemId, qty]) => ({ sale_item_id: itemId, quantity: qty }))
      if (lines.length === 0) throw new Error('NO_LINES')
      if (!reason) throw new Error('NO_REASON')
      if (needsPaymentChoice && !selectedPaymentId) throw new Error('NO_PAYMENT_SELECTED')
      const { error: err } = await supabase.rpc('return_shop_sale', {
        p_sale_id: sale.saleId,
        p_lines: lines,
        p_restock: restock,
        p_refund_amount: newRefundAmount > 0 ? newRefundAmount : undefined,
        p_payment_id: newRefundAmount > 0 && selectedPaymentId ? selectedPaymentId : undefined,
        p_reason: reason,
        // Real double-click/network-retry protection (directive Section
        // 16) -- a fresh key per genuine submit attempt.
        p_idempotency_key: crypto.randomUUID(),
      })
      if (err) throw err
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['shop-sales'] })
      void queryClient.invalidateQueries({ queryKey: ['shop-sales-kpis'] })
      void queryClient.invalidateQueries({ queryKey: ['shop-inventory-balances'] })
      onClose()
    },
    onError: (err) => {
      if (err instanceof Error && err.message === 'NO_LINES') {
        setError(t('shop.sales.returnNoLinesError'))
      } else if (err instanceof Error && err.message === 'NO_REASON') {
        setError(t('shop.sales.returnNoReasonError'))
      } else if (err instanceof Error && err.message === 'NO_PAYMENT_SELECTED') {
        setError(t('shop.sales.returnNoPaymentSelectedError'))
      } else {
        setError(translateSupabaseError(err, t('shop.sales.returnError')))
      }
    },
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t('shop.sales.returnDialogTitle', { invoice: sale.invoiceNumber })}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          {previousRefundTotal > 0 && (
            <p className="rounded-md bg-muted/40 p-2 text-xs text-text-secondary">
              {t('shop.sales.priorRefundNote', { amount: previousRefundTotal.toFixed(2) })}
            </p>
          )}
          <div className="flex flex-col gap-2">
            {items.map((item) => {
              const remaining = item.quantity - item.returnedQuantity
              return (
                <div key={item.itemId} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
                  <div>
                    <p>{item.productNameAr}{item.variantLabel ? ` (${item.variantLabel})` : ''}</p>
                    <p className="text-xs text-text-secondary">
                      {t('shop.sales.detail.qtyAndPrice', { qty: item.quantity, price: item.unitPrice })}
                      {item.returnedQuantity > 0 && ` · ${t('shop.sales.detail.returnedQty', { count: item.returnedQuantity })}`}
                      {' · '}{t('shop.sales.remainingReturnable', { count: remaining })}
                    </p>
                  </div>
                  <Input
                    type="number"
                    min="0"
                    max={remaining}
                    step="1"
                    className="w-20"
                    disabled={remaining <= 0}
                    data-testid={`return-line-qty-${item.itemId}`}
                    value={returnQuantities[item.itemId] ?? ''}
                    onChange={(e) => setReturnQuantities((cur) => ({ ...cur, [item.itemId]: Number(e.target.value) }))}
                  />
                </div>
              )
            })}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={restock} data-testid="return-restock-toggle" onChange={(e) => setRestock(e.target.checked)} />
            {t('shop.sales.restockLabel')}
          </label>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.sales.reasonLabel')}</label>
            <Select value={reasonCode} onValueChange={(v) => setReasonCode(v as typeof reasonCode)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RETURN_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>{t(`shop.sales.returnReasons.${r}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {reasonCode === 'other' && (
              <Input required value={reasonOther} onChange={(e) => setReasonOther(e.target.value)} placeholder={t('shop.sales.reasonOtherPlaceholder')} />
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={refundEnabled} data-testid="return-issue-refund-toggle" onChange={(e) => setRefundEnabled(e.target.checked)} />
            {t('shop.sales.issueRefundLabel')}
          </label>

          {refundEnabled && needsPaymentChoice && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('shop.sales.refundPaymentChoiceLabel')}</label>
              <Select value={selectedPaymentId} onValueChange={setSelectedPaymentId}>
                <SelectTrigger data-testid="return-refund-payment-select"><SelectValue placeholder={t('shop.sales.refundPaymentChoicePlaceholder')} /></SelectTrigger>
                <SelectContent>
                  {payments.map((p) => (
                    <SelectItem key={p.paymentId} value={p.paymentId} data-testid={`return-refund-payment-${p.paymentId}`}>
                      {t(`common.paymentMethodLabels.${p.method}`, { defaultValue: PAYMENT_METHOD_LABELS[p.method] ?? p.method })} — {p.amount.toFixed(2)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-text-secondary">{t('shop.sales.refundPaymentChoiceHint')}</p>
            </div>
          )}

          {/* Real REFUND SUMMARY before confirming (plan Section 4). */}
          <div className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm" data-testid="return-refund-summary">
            <p className="mb-1 font-medium">{t('shop.sales.refundSummary.title')}</p>
            <div className="flex items-center justify-between"><span className="text-text-secondary">{t('shop.sales.refundSummary.merchandiseTotal')}</span><span data-testid="return-refund-summary-merchandise"><MoneyDisplay amount={merchandiseRefundTotal} size="sm" /></span></div>
            <div className="flex items-center justify-between"><span className="text-text-secondary">{t('shop.sales.refundSummary.previousRefunds')}</span><span data-testid="return-refund-summary-previous"><MoneyDisplay amount={previousRefundTotal} size="sm" /></span></div>
            <div className="flex items-center justify-between"><span className="text-text-secondary">{t('shop.sales.refundSummary.newRefund')}</span><span data-testid="return-refund-summary-new"><MoneyDisplay amount={newRefundAmount} size="sm" tone={newRefundAmount > 0 ? 'danger' : 'default'} /></span></div>
            <div className="flex items-center justify-between"><span className="text-text-secondary">{t('shop.sales.refundSummary.remainingRefundable')}</span><span data-testid="return-refund-summary-remaining"><MoneyDisplay amount={remainingRefundableValue} size="sm" tone="success" /></span></div>
          </div>

          {error && <p role="alert" data-testid="return-error-message" className="text-sm text-status-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!reason || returnMutation.isPending} data-testid="return-submit" onClick={() => { setError(null); returnMutation.mutate() }}>
              {returnMutation.isPending ? t('shop.sales.processing') : t('shop.sales.processReturn')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
