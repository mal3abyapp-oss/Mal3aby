import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { FormattedDate } from '@/components/ui/formatted-date'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatCard } from '@/components/ui/stat-card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/billing'
import {
  Wallet, ShoppingBag, TrendingUp, Package2, Undo2, AlertTriangle, XCircle, Receipt,
} from 'lucide-react'

// COMMERCE PRO C6 (Shop Dashboard, plan Section 5 Phase C6). Answers
// "how much did I sell / what sold / what needs restocking / what was
// returned / who sold it / how profitable am I" using only real data --
// see the "not tracked yet" ProfitabilityNotice below for the one
// question this dashboard cannot honestly answer today.
//
// Route placement decision: this is a NEW page at /app/shop/dashboard,
// reachable from ShopNav -- it does NOT replace /app/shop's existing
// index route (ShopPOSPage). The POS screen is the highest-frequency,
// most time-critical daily action for a cashier (ring up a sale); a
// dashboard is a glance-once-a-day, manager/owner-facing surface.
// Demoting checkout behind an extra click for every cashier, every
// transaction, to make room for a dashboard nobody opens mid-sale would
// be a real UX regression, not a neutral IA choice -- so this ships as
// an additional page, not the new default landing page.
//
// All figures are re-derived from the same real ledgers every other
// Shop RPC in this engagement uses (invoice_items for revenue,
// payments/payment_allocations for money received, refunds for
// returns) -- never a second, independently-tracked figure. Reuses
// get_shop_sales_kpis (C5) and get_shop_top_products/
// get_shop_inventory_summary (pre-existing, already read by
// ReportShopPage.tsx) unchanged. Three genuinely new, narrowly-scoped
// RPCs were added (supabase/migrations/20260828160000_shop_dashboard_rpcs.sql)
// for the three rollups nothing existing already covered: category
// revenue, payment-method mix, and a club-wide recent-returns feed.

interface KpiData {
  transactionCount: number
  grossSales: number
  discountTotal: number
  refundTotal: number
  netSales: number
  itemsSold: number
  averageBasket: number
}

interface TopProductRow {
  productId: string
  productNameAr: string
  unitsSold: number
  unitsReturned: number
  revenue: number
}

interface InventorySummary {
  activeProducts: number
  totalOnHand: number
  lowStockCount: number
  outOfStockCount: number
}

interface LowStockRow {
  locationId: string
  locationName: string
  productId: string
  productNameAr: string
  variantId: string | null
  variantLabel: string | null
  onHand: number
  reorderLevel: number | null
}

interface CategorySalesRow {
  categoryId: string | null
  categoryName: string | null
  unitsSold: number
  revenue: number
}

interface PaymentMixRow {
  method: string
  transactionCount: number
  totalAmount: number
}

interface RecentSaleRow {
  saleId: string
  invoiceNumber: string
  customerName: string | null
  soldByName: string | null
  total: number
  createdAt: string
}

interface RecentReturnRow {
  returnId: string
  saleId: string
  invoiceNumber: string
  processedByName: string | null
  restock: boolean
  reason: string
  createdAt: string
  refundAmount: number | null
  refundMethod: string | null
}

interface CashierSalesRow {
  soldByName: string
  transactionCount: number
  total: number
}

function todayRange() {
  const today = new Date().toISOString().slice(0, 10)
  return { start: today, end: today }
}

async function fetchKpis(clubId: string, start: string, end: string): Promise<KpiData> {
  const { data, error } = await supabase
    .rpc('get_shop_sales_kpis', { p_club_id: clubId, p_start_date: start, p_end_date: end })
    .maybeSingle()
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

async function fetchTopProducts(clubId: string, start: string, end: string): Promise<TopProductRow[]> {
  const { data, error } = await supabase.rpc('get_shop_top_products', { p_club_id: clubId, p_start_date: start, p_end_date: end, p_limit: 5 })
  if (error) throw error
  return (data ?? []).map((r) => ({
    productId: r.product_id, productNameAr: r.product_name_ar, unitsSold: Number(r.units_sold),
    unitsReturned: Number(r.units_returned), revenue: Number(r.revenue),
  }))
}

async function fetchInventorySummary(clubId: string): Promise<InventorySummary> {
  const { data, error } = await supabase.rpc('get_shop_inventory_summary', { p_club_id: clubId })
  if (error) throw error
  const row = data?.[0]
  return {
    activeProducts: row ? Number(row.active_products) : 0,
    totalOnHand: row ? Number(row.total_on_hand) : 0,
    lowStockCount: row ? Number(row.low_stock_count) : 0,
    outOfStockCount: row ? Number(row.out_of_stock_count) : 0,
  }
}

async function fetchLowStock(clubId: string): Promise<LowStockRow[]> {
  const { data, error } = await supabase.rpc('get_shop_inventory_balances', { p_club_id: clubId, p_low_stock_only: true })
  if (error) throw error
  return (data ?? []).slice(0, 8).map((r) => ({
    locationId: r.location_id, locationName: r.location_name, productId: r.product_id, productNameAr: r.product_name_ar,
    variantId: r.variant_id, variantLabel: r.variant_label, onHand: Number(r.on_hand),
    reorderLevel: r.reorder_level === null ? null : Number(r.reorder_level),
  }))
}

async function fetchCategorySales(clubId: string, start: string, end: string): Promise<CategorySalesRow[]> {
  const { data, error } = await supabase.rpc('get_shop_sales_by_category', { p_club_id: clubId, p_start_date: start, p_end_date: end })
  if (error) throw error
  return (data ?? []).map((r) => ({
    categoryId: r.category_id, categoryName: r.category_name, unitsSold: Number(r.units_sold), revenue: Number(r.revenue),
  }))
}

async function fetchPaymentMix(clubId: string, start: string, end: string): Promise<PaymentMixRow[]> {
  const { data, error } = await supabase.rpc('get_shop_payment_method_mix', { p_club_id: clubId, p_start_date: start, p_end_date: end })
  if (error) throw error
  return (data ?? []).map((r) => ({ method: r.method, transactionCount: Number(r.transaction_count), totalAmount: Number(r.total_amount) }))
}

async function fetchRecentSales(clubId: string, start: string, end: string): Promise<RecentSaleRow[]> {
  const { data, error } = await supabase.rpc('list_shop_sales', {
    p_club_id: clubId, p_start_date: start, p_end_date: end, p_limit: 8,
  })
  if (error) throw error
  return (data ?? []).map((r) => ({
    saleId: r.sale_id, invoiceNumber: r.invoice_number, customerName: r.customer_name, soldByName: r.sold_by_name,
    total: Number(r.total), createdAt: r.created_at,
  }))
}

async function fetchRecentReturns(clubId: string): Promise<RecentReturnRow[]> {
  const { data, error } = await supabase.rpc('list_shop_recent_returns', { p_club_id: clubId, p_limit: 6 })
  if (error) throw error
  return (data ?? []).map((r) => ({
    returnId: r.return_id, saleId: r.sale_id, invoiceNumber: r.invoice_number, processedByName: r.processed_by_name,
    restock: r.restock, reason: r.reason, createdAt: r.created_at,
    refundAmount: r.refund_amount === null ? null : Number(r.refund_amount), refundMethod: r.refund_method,
  }))
}

// "Who sold it" -- derived client-side from list_shop_sales (already
// fetched for Recent Sales / KPI-adjacent use), grouped by cashier.
// Checked whether a new RPC was needed first: list_shop_sales already
// carries sold_by_name and total per sale, and the dashboard only needs
// today's totals per cashier (not a paginated, filterable breakdown --
// that already exists on the Sales page's own cashier filter, C5) --
// deriving from a second, slightly larger list_shop_sales call (no
// p_limit cap needed here since it's for aggregation, not display)
// avoids a fourth new RPC for a rollup this cheap to compute client-side
// for a single day's data volume.
async function fetchSalesByCashier(clubId: string, start: string, end: string): Promise<CashierSalesRow[]> {
  const { data, error } = await supabase.rpc('list_shop_sales', {
    p_club_id: clubId, p_start_date: start, p_end_date: end, p_limit: 500,
  })
  if (error) throw error
  const byName = new Map<string, CashierSalesRow>()
  for (const r of data ?? []) {
    const name = r.sold_by_name ?? '—'
    const existing = byName.get(name)
    if (existing) {
      existing.transactionCount += 1
      existing.total += Number(r.total)
    } else {
      byName.set(name, { soldByName: name, transactionCount: 1, total: Number(r.total) })
    }
  }
  return Array.from(byName.values()).sort((a, b) => b.total - a.total)
}

export function ShopDashboardPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { start, end } = todayRange()

  const { data: kpis, isLoading: kpisLoading } = useQuery({
    queryKey: ['shop-dashboard-kpis', currentClubId, start, end],
    queryFn: () => fetchKpis(currentClubId as string, start, end),
    enabled: !!currentClubId,
  })
  const { data: topProducts = [], isLoading: topProductsLoading } = useQuery({
    queryKey: ['shop-dashboard-top-products', currentClubId, start, end],
    queryFn: () => fetchTopProducts(currentClubId as string, start, end),
    enabled: !!currentClubId,
  })
  const { data: summary } = useQuery({
    queryKey: ['shop-dashboard-inventory-summary', currentClubId],
    queryFn: () => fetchInventorySummary(currentClubId as string),
    enabled: !!currentClubId,
  })
  const { data: lowStock = [], isLoading: lowStockLoading } = useQuery({
    queryKey: ['shop-dashboard-low-stock', currentClubId],
    queryFn: () => fetchLowStock(currentClubId as string),
    enabled: !!currentClubId,
  })
  const { data: categorySales = [], isLoading: categorySalesLoading } = useQuery({
    queryKey: ['shop-dashboard-category-sales', currentClubId, start, end],
    queryFn: () => fetchCategorySales(currentClubId as string, start, end),
    enabled: !!currentClubId,
  })
  const { data: paymentMix = [], isLoading: paymentMixLoading } = useQuery({
    queryKey: ['shop-dashboard-payment-mix', currentClubId, start, end],
    queryFn: () => fetchPaymentMix(currentClubId as string, start, end),
    enabled: !!currentClubId,
  })
  const { data: recentSales = [], isLoading: recentSalesLoading } = useQuery({
    queryKey: ['shop-dashboard-recent-sales', currentClubId, start, end],
    queryFn: () => fetchRecentSales(currentClubId as string, start, end),
    enabled: !!currentClubId,
  })
  const { data: recentReturns = [], isLoading: recentReturnsLoading } = useQuery({
    queryKey: ['shop-dashboard-recent-returns', currentClubId],
    queryFn: () => fetchRecentReturns(currentClubId as string),
    enabled: !!currentClubId,
  })
  const { data: salesByCashier = [], isLoading: cashierLoading } = useQuery({
    queryKey: ['shop-dashboard-by-cashier', currentClubId, start, end],
    queryFn: () => fetchSalesByCashier(currentClubId as string, start, end),
    enabled: !!currentClubId,
  })

  const topProductColumns: DataTableColumn<TopProductRow>[] = [
    { key: 'product', header: t('shop.dashboard.columns.product'), render: (p) => p.productNameAr },
    { key: 'unitsSold', header: t('shop.dashboard.columns.unitsSold'), render: (p) => p.unitsSold },
    { key: 'revenue', header: t('shop.dashboard.columns.revenue'), render: (p) => <MoneyDisplay amount={p.revenue} size="sm" /> },
  ]

  const lowStockColumns: DataTableColumn<LowStockRow>[] = [
    { key: 'product', header: t('shop.dashboard.columns.product'), render: (r) => <>{r.productNameAr}{r.variantLabel ? ` (${r.variantLabel})` : ''}</> },
    { key: 'location', header: t('shop.dashboard.columns.location'), render: (r) => r.locationName },
    {
      key: 'onHand',
      header: t('shop.dashboard.columns.onHand'),
      render: (r) => <span className={r.onHand === 0 ? 'font-semibold text-status-danger' : 'font-semibold text-status-warning'}>{r.onHand}</span>,
    },
    { key: 'reorderLevel', header: t('shop.dashboard.columns.reorderLevel'), render: (r) => r.reorderLevel ?? '—' },
  ]

  const recentSalesColumns: DataTableColumn<RecentSaleRow>[] = [
    { key: 'invoice', header: t('shop.dashboard.columns.invoice'), render: (s) => <Link to="/app/shop/sales" className="text-accent-foreground hover:underline">{s.invoiceNumber}</Link> },
    { key: 'customer', header: t('shop.dashboard.columns.customer'), render: (s) => s.customerName ?? t('shop.dashboard.walkIn') },
    { key: 'cashier', header: t('shop.dashboard.columns.cashier'), render: (s) => s.soldByName ?? '—' },
    { key: 'time', header: t('shop.dashboard.columns.time'), render: (s) => <FormattedDate value={s.createdAt} timeZone="Africa/Cairo" options={{ hour: '2-digit', minute: '2-digit' }} /> },
    { key: 'total', header: t('shop.dashboard.columns.total'), render: (s) => <MoneyDisplay amount={s.total} size="sm" /> },
  ]

  const recentReturnsColumns: DataTableColumn<RecentReturnRow>[] = [
    { key: 'invoice', header: t('shop.dashboard.columns.invoice'), render: (r) => <Link to="/app/shop/sales" className="text-accent-foreground hover:underline">{r.invoiceNumber}</Link> },
    { key: 'reason', header: t('shop.dashboard.columns.reason'), render: (r) => r.reason },
    { key: 'date', header: t('shop.dashboard.columns.date'), render: (r) => <FormattedDate value={r.createdAt} timeZone="Africa/Cairo" options={{ year: 'numeric', month: 'short', day: 'numeric' }} /> },
    {
      key: 'refund',
      header: t('shop.dashboard.columns.refund'),
      render: (r) => (r.refundAmount === null
        ? <span className="text-text-secondary">{t('shop.dashboard.restockOnly')}</span>
        : <MoneyDisplay amount={r.refundAmount} size="sm" tone="danger" />),
    },
  ]

  const cashierColumns: DataTableColumn<CashierSalesRow>[] = [
    { key: 'cashier', header: t('shop.dashboard.columns.cashier'), render: (c) => c.soldByName },
    { key: 'transactions', header: t('shop.dashboard.columns.transactions'), render: (c) => c.transactionCount },
    { key: 'total', header: t('shop.dashboard.columns.total'), render: (c) => <MoneyDisplay amount={c.total} size="sm" /> },
  ]

  const maxCategoryRevenue = Math.max(1, ...categorySales.map((c) => c.revenue))
  const totalPaymentAmount = Math.max(1, paymentMix.reduce((sum, m) => sum + m.totalAmount, 0))

  return (
    <div>
      <PageHeader title={t('shop.dashboard.title')} description={t('shop.dashboard.description')} />

      {/* KPI row -- Today Sales, Net Sales, Orders, Average Order Value,
          Items Sold, Returns, Low Stock, Out of Stock. */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t('shop.dashboard.todaySales')} value={kpisLoading ? '—' : <MoneyDisplay amount={kpis?.grossSales ?? 0} size="lg" />} icon={Wallet} />
        <StatCard label={t('shop.dashboard.todayNetSales')} value={kpisLoading ? '—' : <MoneyDisplay amount={kpis?.netSales ?? 0} size="lg" />} icon={TrendingUp} />
        <StatCard label={t('shop.dashboard.orders')} value={kpis?.transactionCount ?? 0} icon={ShoppingBag} to="/app/shop/sales" />
        <StatCard label={t('shop.dashboard.averageOrderValue')} value={kpisLoading ? '—' : <MoneyDisplay amount={kpis?.averageBasket ?? 0} size="lg" />} icon={Receipt} />
        <StatCard label={t('shop.dashboard.itemsSold')} value={kpis?.itemsSold ?? 0} icon={Package2} />
        <StatCard label={t('shop.dashboard.returns')} value={kpisLoading ? '—' : <MoneyDisplay amount={kpis?.refundTotal ?? 0} size="lg" tone="danger" />} icon={Undo2} tone={kpis && kpis.refundTotal > 0 ? 'danger' : 'default'} to="/app/shop/sales" />
        <StatCard label={t('shop.dashboard.lowStock')} value={summary?.lowStockCount ?? 0} icon={AlertTriangle} tone={summary && summary.lowStockCount > 0 ? 'warning' : 'default'} to="/app/shop/inventory" />
        <StatCard label={t('shop.dashboard.outOfStock')} value={summary?.outOfStockCount ?? 0} icon={XCircle} tone={summary && summary.outOfStockCount > 0 ? 'danger' : 'default'} to="/app/shop/inventory" />
      </div>

      {/* Profitability -- deliberately honest, not fabricated. No
          cost-at-sale snapshot exists yet (shop_sale_items has no cost
          column, confirmed via direct schema read of
          20260826210846_shop_sales_schema.sql -- unchanged through
          C1-C5). shop.reports.view_profit, mentioned in the plan's own
          §3 permission list, was checked and does NOT actually exist in
          any C1-C5 migration (a plan-vs-reality gap found during this
          phase, not seeded here since C6's scope is dashboard-only, not
          permissions) -- so this section is gated the same as the rest
          of the dashboard (shop.view/report.view), not a separate key. */}
      <Card className="mb-6 border-dashed">
        <CardContent className="flex items-start gap-3 p-4">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-status-warning" aria-hidden="true" />
          <div>
            <p className="font-medium">{t('shop.dashboard.profitability.title')}</p>
            <p className="text-sm text-text-secondary">{t('shop.dashboard.profitability.description')}</p>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-lg font-semibold">{t('shop.dashboard.topProducts')}</h2>
          <DataTable columns={topProductColumns} rows={topProducts} rowKey={(p) => p.productId} isLoading={topProductsLoading} emptyTitle={t('shop.dashboard.emptySales')} />
        </div>

        <div>
          <h2 className="mb-2 text-lg font-semibold">{t('shop.dashboard.salesByCategory')}</h2>
          {categorySalesLoading ? (
            <Card><CardContent className="p-4"><div className="h-24 animate-pulse rounded bg-muted" /></CardContent></Card>
          ) : categorySales.length === 0 ? (
            <Card><CardContent className="p-4 text-sm text-text-secondary">{t('shop.dashboard.emptySales')}</CardContent></Card>
          ) : (
            <Card>
              <CardContent className="space-y-3 p-4">
                {categorySales.map((c) => (
                  <div key={c.categoryId ?? 'uncategorized'}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span>{c.categoryName ?? t('shop.dashboard.uncategorized')}</span>
                      <MoneyDisplay amount={c.revenue} size="sm" />
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-accent-foreground" style={{ width: `${(c.revenue / maxCategoryRevenue) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div>
          <h2 className="mb-2 text-lg font-semibold">{t('shop.dashboard.paymentMethodMix')}</h2>
          {paymentMixLoading ? (
            <Card><CardContent className="p-4"><div className="h-24 animate-pulse rounded bg-muted" /></CardContent></Card>
          ) : paymentMix.length === 0 ? (
            <Card><CardContent className="p-4 text-sm text-text-secondary">{t('shop.dashboard.emptySales')}</CardContent></Card>
          ) : (
            <Card>
              <CardContent className="space-y-3 p-4">
                {paymentMix.map((m) => (
                  <div key={m.method}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span>{PAYMENT_METHOD_LABELS[m.method] ?? m.method} · {m.transactionCount}</span>
                      <MoneyDisplay amount={m.totalAmount} size="sm" />
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-status-success" style={{ width: `${(m.totalAmount / totalPaymentAmount) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t('shop.dashboard.lowStockList')}</h2>
            <Button asChild variant="ghost" size="sm"><Link to="/app/shop/inventory">{t('shop.dashboard.viewAll')}</Link></Button>
          </div>
          <DataTable columns={lowStockColumns} rows={lowStock} rowKey={(r) => `${r.locationId}-${r.productId}-${r.variantId ?? ''}`} isLoading={lowStockLoading} emptyTitle={t('shop.dashboard.emptyLowStock')} />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t('shop.dashboard.recentSales')}</h2>
            <Button asChild variant="ghost" size="sm"><Link to="/app/shop/sales">{t('shop.dashboard.viewAll')}</Link></Button>
          </div>
          <DataTable columns={recentSalesColumns} rows={recentSales} rowKey={(s) => s.saleId} isLoading={recentSalesLoading} emptyTitle={t('shop.dashboard.emptySales')} />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{t('shop.dashboard.recentReturns')}</h2>
            <Button asChild variant="ghost" size="sm"><Link to="/app/shop/sales">{t('shop.dashboard.viewAll')}</Link></Button>
          </div>
          <DataTable columns={recentReturnsColumns} rows={recentReturns} rowKey={(r) => r.returnId} isLoading={recentReturnsLoading} emptyTitle={t('shop.dashboard.emptyReturns')} />
        </div>

        <div className="lg:col-span-2">
          <h2 className="mb-2 text-lg font-semibold">{t('shop.dashboard.salesByCashier')}</h2>
          <DataTable columns={cashierColumns} rows={salesByCashier} rowKey={(c) => c.soldByName} isLoading={cashierLoading} emptyTitle={t('shop.dashboard.emptySales')} />
        </div>
      </div>
    </div>
  )
}
