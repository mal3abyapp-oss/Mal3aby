import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatCard } from '@/components/ui/stat-card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { ReportsNav } from '@/features/reports/components/ReportsNav'
import { Package, Boxes, AlertTriangle, XCircle } from 'lucide-react'

// COMMERCIAL MODULE ARCHITECTURE (2026-08-26) -- directive Section 10:
// operational Shop reports. Revenue shown here is re-derived from real
// invoice_items via get_shop_top_products() (never independently
// summed from shop_sale_items) -- see
// COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 9's own "structurally only
// one place money is summed" mechanism. Inventory summary card
// deliberately carries NO revenue figure (directive's own explicit
// warning against misleading revenue cards in an inventory context).
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

async function fetchTopProducts(clubId: string): Promise<TopProductRow[]> {
  const { data, error } = await supabase.rpc('get_shop_top_products', { p_club_id: clubId, p_start_date: undefined, p_end_date: undefined, p_limit: 10 })
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

export function ReportShopPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()

  const { data: topProducts = [], isLoading: loadingProducts } = useQuery({
    queryKey: ['report-shop-top-products', currentClubId],
    queryFn: () => fetchTopProducts(currentClubId as string),
    enabled: !!currentClubId,
  })
  const { data: summary } = useQuery({
    queryKey: ['report-shop-inventory-summary', currentClubId],
    queryFn: () => fetchInventorySummary(currentClubId as string),
    enabled: !!currentClubId,
  })

  const columns: DataTableColumn<TopProductRow>[] = [
    { key: 'product', header: t('reports.shop.columns.product'), render: (p) => p.productNameAr },
    { key: 'unitsSold', header: t('reports.shop.columns.unitsSold'), render: (p) => p.unitsSold },
    { key: 'unitsReturned', header: t('reports.shop.columns.unitsReturned'), render: (p) => p.unitsReturned },
    { key: 'revenue', header: t('reports.shop.columns.revenue'), render: (p) => <MoneyDisplay amount={p.revenue} size="sm" /> },
  ]

  return (
    <div>
      <ReportsNav />
      <PageHeader title={t('reports.shop.title')} description={t('reports.shop.description')} />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t('reports.shop.activeProducts')} value={summary?.activeProducts ?? 0} icon={Package} to="/app/shop/products" />
        <StatCard label={t('reports.shop.totalOnHand')} value={summary?.totalOnHand ?? 0} icon={Boxes} to="/app/shop/inventory" />
        <StatCard label={t('reports.shop.lowStock')} value={summary?.lowStockCount ?? 0} icon={AlertTriangle} tone={summary && summary.lowStockCount > 0 ? 'warning' : 'default'} to="/app/shop/inventory" />
        <StatCard label={t('reports.shop.outOfStock')} value={summary?.outOfStockCount ?? 0} icon={XCircle} tone={summary && summary.outOfStockCount > 0 ? 'danger' : 'default'} to="/app/shop/inventory" />
      </div>

      <h2 className="mb-2 text-lg font-semibold">{t('reports.shop.topProducts')}</h2>
      <DataTable columns={columns} rows={topProducts} rowKey={(p) => p.productId} isLoading={loadingProducts} emptyTitle={t('reports.shop.emptyTitle')} />
    </div>
  )
}
