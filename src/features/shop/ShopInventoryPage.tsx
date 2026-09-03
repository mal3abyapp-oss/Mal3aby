import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { FormattedDate } from '@/components/ui/formatted-date'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/ui/stat-card'
import { MoneyDisplay } from '@/components/ui/money-display'
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
import { translateSupabaseError } from '@/lib/errors'
import { ReportPrintButton, ReportPrintHeader } from '@/components/ui/report-print-header'
import { fetchFullReport } from '@/lib/fetchFullReport'
import { ProductThumb } from '@/features/shop/shop-media'
import {
  Printer, Boxes, Wallet, AlertTriangle, XCircle, PackagePlus, ArrowLeftRight,
  SlidersHorizontal, Trash2, Plus,
} from 'lucide-react'

// COMMERCIAL MODULE (2026-08-26) -- Inventory dashboard: balances,
// low-stock filter, receive/transfer/adjust actions, movement history
// (directive Section 59/103).
//
// COMMERCE PRO C8 (2026-08-28, plan Section 5 Phase C8): upgraded to a
// real Inventory Dashboard (KPI row + recent-activity rollups, plan
// Section 20/59), a Product Detail dialog with tabs (plan Section 21),
// and multi-item Receiving/Transfer dialogs (plan Sections 22/23) that
// call new atomic batch RPCs instead of looping the existing
// single-item RPCs client-side -- see receive_shop_stock_batch's own
// migration comment (20260828180000_shop_receive_transfer_batch_rpcs.sql)
// for the full transaction-boundary reasoning. Stock Count UX
// (ShopStockCountPage.tsx) is polished separately in that file only --
// its canonical backend (start/record/complete RPCs) is untouched here,
// per the plan's explicit instruction not to rebuild already-validated
// backend.
interface BalanceRow {
  locationId: string
  locationName: string
  productId: string
  productNameAr: string
  variantId: string | null
  variantLabel: string | null
  onHand: number
  reorderLevel: number | null
}

interface LocationOption { locationId: string; name: string }
interface ProductOption {
  productId: string; nameAr: string; hasVariants: boolean
  imageUrl: string | null; sku: string | null; barcode: string | null
}
interface VariantOption { variantId: string; size: string | null; color: string | null; sku: string | null }
interface SupplierOption { supplierId: string; name: string; isActive: boolean }
interface MovementRow {
  movementId: string
  locationName: string
  productNameAr: string
  variantLabel: string | null
  movementType: string
  quantity: number
  createdAt: string
  reason: string | null
}

interface InventorySummary {
  activeProducts: number
  totalOnHand: number
  lowStockCount: number
  outOfStockCount: number
}

async function fetchBalances(clubId: string, lowStockOnly: boolean): Promise<BalanceRow[]> {
  const { data, error } = await supabase.rpc('get_shop_inventory_balances', { p_club_id: clubId, p_low_stock_only: lowStockOnly })
  if (error) throw error
  return (data ?? []).map((r) => ({
    locationId: r.location_id, locationName: r.location_name, productId: r.product_id, productNameAr: r.product_name_ar,
    variantId: r.variant_id, variantLabel: r.variant_label, onHand: Number(r.on_hand), reorderLevel: r.reorder_level,
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

// Stock Value tile: reuses C7's get_shop_stock_valuation, gated on
// shop.reports.view_profit (cost data) IN ADDITION TO inventory.view --
// enforced by the RPC itself, not client-side. Matching the exact
// established pattern (ShopProfitReport.tsx): call unconditionally,
// treat isError as "no permission, don't show the figure" rather than
// checking a permission key client-side first. A role without the
// grant simply never sees this tile populate with a money figure.
async function fetchStockValue(clubId: string): Promise<number> {
  const { data, error } = await supabase.rpc('get_shop_stock_valuation', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).reduce((sum, r) => sum + (r.line_value === null ? 0 : Number(r.line_value)), 0)
}

async function fetchLocations(clubId: string): Promise<LocationOption[]> {
  const { data, error } = await supabase.rpc('list_shop_inventory_locations', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({ locationId: r.location_id, name: r.name }))
}

// PERF-05 (production audit remediation, 2026-09-03): list_shop_products
// now takes p_limit/p_offset and defaults to 50 (see that RPC's own
// migration comment, 20260903160000_paginate_list_shop_products.sql).
// This call site is a product-PICKER for the Receive/Transfer/Adjust
// dialogs' <Select> -- every active product must remain selectable here
// (unlike ShopProductsPage.tsx's catalog view, this is not itself a
// paginated display list), so silently inheriting the RPC's new 50-row
// default would trade "unbounded but slow" for "bounded but silently
// missing products past #50" -- the same class of correctness gap this
// finding explicitly calls out for CustomersPage. PRODUCT_PICKER_LIMIT
// is a generous, explicit, still-bounded cap (never truly unbounded)
// rather than the display page size.
const PRODUCT_PICKER_LIMIT = 1000

async function fetchProducts(clubId: string): Promise<ProductOption[]> {
  const { data, error } = await supabase.rpc('list_shop_products', { p_club_id: clubId, p_status: 'active', p_limit: PRODUCT_PICKER_LIMIT })
  if (error) throw error
  return (data ?? []).map((r) => ({
    productId: r.product_id, nameAr: r.name_ar, hasVariants: r.has_variants,
    imageUrl: r.image_url, sku: r.sku, barcode: r.barcode,
  }))
}

async function fetchVariants(productId: string): Promise<VariantOption[]> {
  const { data, error } = await supabase.rpc('list_shop_product_variants', { p_product_id: productId })
  if (error) throw error
  return (data ?? []).map((r) => ({ variantId: r.variant_id, size: r.size, color: r.color, sku: r.sku }))
}

// SHOP MODULE UX HARDENING (2026-08-28): real production acceptance
// pass found public.shop_suppliers had a real, correct schema and RLS
// policies, and receive_shop_stock already accepted a p_supplier_id --
// but ZERO code anywhere (UI or RPC) ever read or wrote the table.
// Suppliers were genuinely unusable end-to-end. Fixed via direct
// table access (matching this table's own RLS design -- policies are
// already scoped on has_permission('inventory.receive'/'inventory.view',
// club_id), the same pattern this project uses for a small number of
// simple, non-financial entities where a dedicated RPC wrapper adds no
// real safety over RLS alone) -- not a new RPC, since none of this
// project's existing RPC conventions (audit logging, cross-tenant
// oracle prevention) apply to a plain contact-list entity with no
// financial or cross-tenant-sensitive fields.
async function fetchSuppliers(clubId: string, includeInactive = false): Promise<SupplierOption[]> {
  let query = supabase.from('shop_suppliers').select('id, name, is_active').eq('club_id', clubId).order('name')
  if (!includeInactive) query = query.eq('is_active', true)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []).map((r) => ({ supplierId: r.id, name: r.name, isActive: r.is_active }))
}

interface MovementApiRow {
  movement_id: string; location_name: string; product_name_ar: string; variant_label: string | null;
  movement_type: string; quantity: number | string; created_at: string; reason: string | null
}

function mapMovementRows(rows: MovementApiRow[]): MovementRow[] {
  return rows.map((r) => ({
    movementId: r.movement_id, locationName: r.location_name, productNameAr: r.product_name_ar, variantLabel: r.variant_label,
    movementType: r.movement_type, quantity: Number(r.quantity), createdAt: r.created_at, reason: r.reason,
  }))
}

async function fetchMovements(clubId: string): Promise<MovementRow[]> {
  const { data, error } = await supabase.rpc('list_shop_inventory_movements', { p_club_id: clubId, p_limit: 50 })
  if (error) throw error
  return mapMovementRows((data ?? []) as MovementApiRow[])
}

// Recent activity rollups (dashboard requirement: "Recent Receipts,
// Recent Transfers, Recent Adjustments, Recent Damage/Loss") -- all
// four derived from list_shop_inventory_movements's own
// p_movement_type filter (already built in C7), not a new RPC. Damage
// and Loss are two distinct movement_type values in the schema
// (confirmed: adjust_shop_stock restricts p_movement_type to exactly
// 'adjustment_in'/'adjustment_out'/'damage'/'loss') so "Recent
// Damage/Loss" fetches both and merges client-side, sorted by date.
async function fetchRecentByType(clubId: string, types: string[], limit: number): Promise<MovementRow[]> {
  const results = await Promise.all(types.map(async (movementType) => {
    const { data, error } = await supabase.rpc('list_shop_inventory_movements', {
      p_club_id: clubId, p_movement_type: movementType, p_limit: limit,
    })
    if (error) throw error
    return mapMovementRows((data ?? []) as MovementApiRow[])
  }))
  return results.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
}

function stockStatus(onHand: number, reorderLevel: number | null): 'out' | 'low' | 'in' {
  if (onHand <= 0) return 'out'
  if (reorderLevel !== null && onHand <= reorderLevel) return 'low'
  return 'in'
}

function StockStatusBadge({ status }: { status: 'out' | 'low' | 'in' }) {
  const { t } = useTranslation()
  if (status === 'out') return <Badge variant="destructive">{t('shop.inventory.status.out')}</Badge>
  if (status === 'low') return <Badge variant="outline" className="border-status-warning text-status-warning">{t('shop.inventory.status.low')}</Badge>
  return <Badge variant="outline" className="border-status-success text-status-success">{t('shop.inventory.status.in')}</Badge>
}

export function ShopInventoryPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [lowStockOnly, setLowStockOnly] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [managingSuppliers, setManagingSuppliers] = useState(false)
  const [detailProductId, setDetailProductId] = useState<string | null>(null)

  const { data: summary } = useQuery({
    queryKey: ['shop-inventory-summary', currentClubId],
    queryFn: () => fetchInventorySummary(currentClubId as string),
    enabled: !!currentClubId,
  })
  const { data: stockValue, isError: stockValueDenied } = useQuery({
    queryKey: ['shop-inventory-stock-value', currentClubId],
    queryFn: () => fetchStockValue(currentClubId as string),
    enabled: !!currentClubId,
    retry: false,
  })
  const { data: balances = [], isLoading } = useQuery({
    queryKey: ['shop-inventory-balances', currentClubId, lowStockOnly],
    queryFn: () => fetchBalances(currentClubId as string, lowStockOnly),
    enabled: !!currentClubId,
  })
  const { data: products = [] } = useQuery({
    queryKey: ['shop-inv-products', currentClubId],
    queryFn: () => fetchProducts(currentClubId as string),
    enabled: !!currentClubId,
  })
  const { data: movements = [] } = useQuery({
    queryKey: ['shop-inventory-movements', currentClubId],
    queryFn: () => fetchMovements(currentClubId as string),
    enabled: !!currentClubId,
  })
  const { data: recentReceipts = [] } = useQuery({
    queryKey: ['shop-inventory-recent-receipts', currentClubId],
    queryFn: () => fetchRecentByType(currentClubId as string, ['purchase_receipt'], 4),
    enabled: !!currentClubId,
  })
  const { data: recentTransfers = [] } = useQuery({
    queryKey: ['shop-inventory-recent-transfers', currentClubId],
    queryFn: () => fetchRecentByType(currentClubId as string, ['transfer_out', 'transfer_in'], 4),
    enabled: !!currentClubId,
  })
  const { data: recentAdjustments = [] } = useQuery({
    queryKey: ['shop-inventory-recent-adjustments', currentClubId],
    queryFn: () => fetchRecentByType(currentClubId as string, ['adjustment_in', 'adjustment_out'], 4),
    enabled: !!currentClubId,
  })
  const { data: recentDamageLoss = [] } = useQuery({
    queryKey: ['shop-inventory-recent-damage-loss', currentClubId],
    queryFn: () => fetchRecentByType(currentClubId as string, ['damage', 'loss'], 4),
    enabled: !!currentClubId,
  })

  const productImageById = new Map(products.map((p) => [p.productId, p.imageUrl]))

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['shop-inventory-balances'] })
    void queryClient.invalidateQueries({ queryKey: ['shop-inventory-movements'] })
    void queryClient.invalidateQueries({ queryKey: ['shop-inventory-summary'] })
    void queryClient.invalidateQueries({ queryKey: ['shop-inventory-stock-value'] })
    void queryClient.invalidateQueries({ queryKey: ['shop-inventory-recent-receipts'] })
    void queryClient.invalidateQueries({ queryKey: ['shop-inventory-recent-transfers'] })
    void queryClient.invalidateQueries({ queryKey: ['shop-inventory-recent-adjustments'] })
    void queryClient.invalidateQueries({ queryKey: ['shop-inventory-recent-damage-loss'] })
  }

  // PRINTING -- FULL FILTERED PRINT correction: the screen query above
  // stays bounded to 50 rows (unchanged, for performance). "Print Full
  // Report" is a separate, explicit, on-demand fetch through
  // fetchFullReport() -- same RPC, same filters (club id -- this page
  // has no other movement filter today), server-side chunked, capped,
  // never silently truncated. Only triggered on click, never on mount.
  const [fullMovements, setFullMovements] = useState<MovementRow[] | null>(null)
  const [fullMovementsTruncated, setFullMovementsTruncated] = useState(false)
  const fullPrintMutation = useMutation({
    mutationFn: () => fetchFullReport<MovementApiRow>('list_shop_inventory_movements', { p_club_id: currentClubId }),
    onSuccess: (result) => {
      setFullMovements(mapMovementRows(result.rows))
      setFullMovementsTruncated(result.truncated)
      // Print only after the full dataset has actually rendered into the DOM.
      requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
    },
  })
  const printedMovements = fullMovements ?? movements

  // After the print dialog closes (print or cancel), revert the on-screen
  // table back to the normal bounded view -- fullMovements was only ever
  // meant to exist for the duration of one print action, never as a
  // lasting change to what the SCREEN shows.
  useEffect(() => {
    if (fullMovements === null) return
    const handler = () => { setFullMovements(null); setFullMovementsTruncated(false) }
    window.addEventListener('afterprint', handler)
    return () => window.removeEventListener('afterprint', handler)
  }, [fullMovements])

  const balanceColumns: DataTableColumn<BalanceRow>[] = [
    {
      key: 'image',
      header: '',
      render: (b) => <ProductThumb src={productImageById.get(b.productId) ?? null} alt={b.productNameAr} className="size-10 rounded-md" />,
    },
    {
      key: 'product',
      header: t('shop.inventory.columns.product'),
      render: (b) => (
        <button type="button" className="text-start text-accent-foreground hover:underline" onClick={() => setDetailProductId(b.productId)}>
          {b.productNameAr}{b.variantLabel ? ` (${b.variantLabel})` : ''}
        </button>
      ),
    },
    { key: 'location', header: t('shop.inventory.columns.location'), render: (b) => b.locationName },
    {
      key: 'onHand',
      header: t('shop.inventory.columns.onHand'),
      render: (b) => (
        <span className={b.reorderLevel !== null && b.onHand <= b.reorderLevel ? 'font-semibold text-status-danger' : ''}>
          {b.onHand}
        </span>
      ),
    },
    { key: 'reorderLevel', header: t('shop.inventory.columns.reorderLevel'), render: (b) => b.reorderLevel ?? '—' },
    { key: 'status', header: t('shop.inventory.columns.status'), render: (b) => <StockStatusBadge status={stockStatus(b.onHand, b.reorderLevel)} /> },
  ]

  const movementColumns: DataTableColumn<MovementRow>[] = [
    { key: 'date', header: t('shop.inventory.columns.date'), render: (m) => <FormattedDate value={m.createdAt} timeZone="Africa/Cairo" options={{ year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }} /> },
    { key: 'product', header: t('shop.inventory.columns.product'), render: (m) => m.productNameAr + (m.variantLabel ? ` (${m.variantLabel})` : '') },
    { key: 'location', header: t('shop.inventory.columns.location'), render: (m) => m.locationName },
    { key: 'type', header: t('shop.inventory.columns.movementType'), render: (m) => t(`shop.inventory.movementTypes.${m.movementType}`, { defaultValue: m.movementType }) },
    { key: 'quantity', header: t('shop.inventory.columns.quantity'), render: (m) => m.quantity },
    { key: 'reason', header: t('shop.inventory.columns.reason'), render: (m) => m.reason ?? '—' },
  ]

  const recentColumns: DataTableColumn<MovementRow>[] = [
    { key: 'product', header: t('shop.inventory.columns.product'), render: (m) => m.productNameAr + (m.variantLabel ? ` (${m.variantLabel})` : '') },
    { key: 'quantity', header: t('shop.inventory.columns.quantity'), render: (m) => m.quantity },
    { key: 'date', header: t('shop.inventory.columns.date'), render: (m) => <FormattedDate value={m.createdAt} timeZone="Africa/Cairo" options={{ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }} /> },
  ]

  return (
    <div>
      <div className="print:hidden">
        <PageHeader
          title={t('shop.inventory.title')}
          description={t('shop.inventory.description')}
          actions={
            <>
              <Button variant="outline" onClick={() => setManagingSuppliers(true)}>{t('shop.suppliers.manageTitle')}</Button>
              <Button variant="outline" onClick={() => setReceiveOpen(true)}><PackagePlus className="me-1 size-4" />{t('shop.inventory.receiveStock')}</Button>
              <Button variant="outline" onClick={() => setTransferOpen(true)}><ArrowLeftRight className="me-1 size-4" />{t('shop.inventory.transferStock')}</Button>
              <Button variant="outline" onClick={() => setAdjustOpen(true)}><SlidersHorizontal className="me-1 size-4" />{t('shop.inventory.adjustStock')}</Button>
            </>
          }
        />

        {/* Dashboard: KPI row (plan Section 5 Phase C8, item 1). Total
            SKUs / Low Stock / Out of Stock reuse get_shop_inventory_summary
            (unchanged, C6-era). Stock Value reuses C7's
            get_shop_stock_valuation, gated on shop.reports.view_profit --
            the RPC itself enforces the gate (fetchStockValue above); when
            denied, this tile shows a quantity-only fallback rather than a
            money figure, matching the plan's own instruction ("show
            quantity-only info to everyone else"). */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label={t('shop.inventory.kpis.totalSkus')} value={summary?.activeProducts ?? 0} icon={Boxes} />
          <StatCard
            label={t('shop.inventory.kpis.stockValue')}
            value={stockValueDenied ? t('shop.inventory.kpis.stockValueHidden') : <MoneyDisplay amount={stockValue ?? 0} size="lg" />}
            icon={Wallet}
          />
          <StatCard
            label={t('shop.inventory.kpis.lowStock')}
            value={summary?.lowStockCount ?? 0}
            icon={AlertTriangle}
            tone={summary && summary.lowStockCount > 0 ? 'warning' : 'default'}
          />
          <StatCard
            label={t('shop.inventory.kpis.outOfStock')}
            value={summary?.outOfStockCount ?? 0}
            icon={XCircle}
            tone={summary && summary.outOfStockCount > 0 ? 'danger' : 'default'}
          />
        </div>

        {/* Recent activity rollups: Recent Receipts / Transfers /
            Adjustments / Damage-Loss, each the last 4 rows of
            list_shop_inventory_movements filtered by movement type. */}
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
          <div>
            <h2 className="mb-2 text-sm font-semibold text-text-secondary">{t('shop.inventory.recent.receipts')}</h2>
            <DataTable columns={recentColumns} rows={recentReceipts} rowKey={(m) => m.movementId} emptyTitle={t('shop.inventory.recent.empty')} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold text-text-secondary">{t('shop.inventory.recent.transfers')}</h2>
            <DataTable columns={recentColumns} rows={recentTransfers} rowKey={(m) => m.movementId} emptyTitle={t('shop.inventory.recent.empty')} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold text-text-secondary">{t('shop.inventory.recent.adjustments')}</h2>
            <DataTable columns={recentColumns} rows={recentAdjustments} rowKey={(m) => m.movementId} emptyTitle={t('shop.inventory.recent.empty')} />
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold text-text-secondary">{t('shop.inventory.recent.damageLoss')}</h2>
            <DataTable columns={recentColumns} rows={recentDamageLoss} rowKey={(m) => m.movementId} emptyTitle={t('shop.inventory.recent.empty')} />
          </div>
        </div>

        <div className="mb-4 flex items-center justify-between">
          <Button variant={lowStockOnly ? 'default' : 'outline'} size="sm" onClick={() => setLowStockOnly((v) => !v)}>
            {t('shop.inventory.lowStockOnly')}
          </Button>
          <div className="flex items-center gap-2">
            <ReportPrintButton />
            <Button
              variant="outline"
              size="sm"
              disabled={fullPrintMutation.isPending}
              onClick={() => { setFullMovements(null); fullPrintMutation.mutate() }}
            >
              <Printer className="me-1 size-4" />
              {fullPrintMutation.isPending ? t('reports.printFullPreparing') : t('reports.printFull')}
            </Button>
          </div>
        </div>
      </div>

      <div className="print-target visible-for-print">
        <ReportPrintHeader
          reportName={t('shop.inventory.title')}
          filterSummary={lowStockOnly ? t('shop.inventory.lowStockOnly') : undefined}
        />
        <DataTable columns={balanceColumns} rows={balances} rowKey={(b) => `${b.locationId}-${b.productId}-${b.variantId}`} isLoading={isLoading} emptyTitle={t('shop.inventory.emptyBalancesTitle')} />

        <h2 className="mb-2 mt-6 text-lg font-semibold">{t('shop.inventory.movementHistory')}</h2>
        {fullMovements !== null && (
          <p className="mb-2 text-xs text-text-secondary">
            {t('reports.printFullRowCount', { count: fullMovements.length })}
          </p>
        )}
        {fullMovementsTruncated && (
          <p className="mb-2 text-xs font-medium text-status-warning">
            {t('reports.printFullTruncated')}
          </p>
        )}
        {/* Section 12: an explicit operational maximum on the SCREEN view only --
            list_shop_inventory_movements is called with p_limit: 50 above.
            Once "Print Full Report" has fetched the complete filtered set,
            this note is replaced by the exact row count shown further up. */}
        {fullMovements === null && (
          <p className="mb-2 text-xs text-text-secondary">{t('shop.inventory.movementHistoryLimitNote', { count: 50 })}</p>
        )}
        <DataTable columns={movementColumns} rows={printedMovements} rowKey={(m) => m.movementId} emptyTitle={t('shop.inventory.emptyMovementsTitle')} />
      </div>

      {receiveOpen && <ReceiveStockDialog clubId={currentClubId as string} onClose={() => setReceiveOpen(false)} onDone={() => { setReceiveOpen(false); invalidate() }} />}
      {transferOpen && <TransferStockDialog clubId={currentClubId as string} onClose={() => setTransferOpen(false)} onDone={() => { setTransferOpen(false); invalidate() }} />}
      {adjustOpen && <AdjustStockDialog clubId={currentClubId as string} onClose={() => setAdjustOpen(false)} onDone={() => { setAdjustOpen(false); invalidate() }} />}
      {managingSuppliers && <ManageSuppliersDialog clubId={currentClubId as string} onClose={() => setManagingSuppliers(false)} />}
      {detailProductId && (
        <ProductDetailDialog
          clubId={currentClubId as string}
          productId={detailProductId}
          onClose={() => setDetailProductId(null)}
        />
      )}
    </div>
  )
}

function SupplierPicker({ clubId, value, onChange }: { clubId: string; value: string; onChange: (supplierId: string) => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: suppliers = [] } = useQuery({ queryKey: ['shop-suppliers', clubId], queryFn: () => fetchSuppliers(clubId), enabled: !!clubId })

  const createMutation = useMutation({
    mutationFn: async () => {
      const { data, error: err } = await supabase
        .from('shop_suppliers')
        .insert({ club_id: clubId, name: newName, phone: newPhone || null })
        .select('id')
        .single()
      if (err) throw err
      return data.id as string
    },
    onSuccess: (newSupplierId) => {
      void queryClient.invalidateQueries({ queryKey: ['shop-suppliers', clubId] })
      onChange(newSupplierId)
      setCreating(false)
      setNewName('')
      setNewPhone('')
    },
    onError: (err) => setError(translateSupabaseError(err, t('shop.suppliers.createError'))),
  })

  if (creating) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <Input autoFocus placeholder={t('shop.suppliers.nameLabel')} value={newName} onChange={(e) => setNewName(e.target.value)} />
        <Input dir="ltr" placeholder={t('shop.suppliers.phoneLabel')} value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
        {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
        <div className="flex gap-2">
          <Button type="button" size="sm" disabled={!newName || createMutation.isPending} onClick={() => { setError(null); createMutation.mutate() }}>
            {createMutation.isPending ? t('shop.suppliers.creating') : t('shop.categories.createAndUse')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => { setCreating(false); setError(null) }}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Select value={value} onValueChange={(v) => (v === NEW_SUPPLIER_VALUE ? setCreating(true) : onChange(v === NONE_SUPPLIER_VALUE ? '' : v))}>
      <SelectTrigger><SelectValue placeholder={t('shop.suppliers.pickerPlaceholder')} /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_SUPPLIER_VALUE}>{t('shop.suppliers.none')}</SelectItem>
        {suppliers.map((s) => <SelectItem key={s.supplierId} value={s.supplierId}>{s.name}</SelectItem>)}
        <SelectItem value={NEW_SUPPLIER_VALUE}>{t('shop.suppliers.createNew')}</SelectItem>
      </SelectContent>
    </Select>
  )
}

const NEW_SUPPLIER_VALUE = '__new_supplier__'
const NONE_SUPPLIER_VALUE = '__none_supplier__'

function ManageSuppliersDialog({ clubId, onClose }: { clubId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [addingOpen, setAddingOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newNotes, setNewNotes] = useState('')

  function startEdit(s: { id: string; name: string; phone: string | null; email: string | null; notes: string | null }) {
    setEditingId(s.id)
    setAddingOpen(false)
    setNewName(s.name)
    setNewPhone(s.phone ?? '')
    setNewEmail(s.email ?? '')
    setNewNotes(s.notes ?? '')
  }

  function resetForm() {
    setEditingId(null)
    setAddingOpen(false)
    setNewName('')
    setNewPhone('')
    setNewEmail('')
    setNewNotes('')
  }

  interface SupplierFullRow { id: string; name: string; phone: string | null; email: string | null; notes: string | null; is_active: boolean }

  const { data: suppliers = [], refetch } = useQuery({
    queryKey: ['shop-suppliers-all', clubId],
    queryFn: async () => {
      const { data, error: err } = await supabase.from('shop_suppliers').select('id, name, phone, email, notes, is_active').eq('club_id', clubId).order('is_active', { ascending: false }).order('name')
      if (err) throw err
      return (data ?? []) as SupplierFullRow[]
    },
  })

  function invalidate() {
    void refetch()
    void queryClient.invalidateQueries({ queryKey: ['shop-suppliers', clubId] })
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.from('shop_suppliers').insert({ club_id: clubId, name: newName, phone: newPhone || null, email: newEmail || null, notes: newNotes || null })
      if (err) throw err
    },
    onSuccess: () => { resetForm(); invalidate() },
    onError: (err) => setError(translateSupabaseError(err, t('shop.suppliers.createError'))),
  })

  const updateMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error: err } = await supabase.from('shop_suppliers').update({ name: newName, phone: newPhone || null, email: newEmail || null, notes: newNotes || null }).eq('id', id)
      if (err) throw err
    },
    onSuccess: () => { resetForm(); invalidate() },
    onError: (err) => setError(translateSupabaseError(err, t('shop.suppliers.saveError'))),
  })

  const toggleActiveMutation = useMutation({
    mutationFn: async (s: SupplierFullRow) => {
      const { error: err } = await supabase.from('shop_suppliers').update({ is_active: !s.is_active }).eq('id', s.id)
      if (err) throw err
    },
    onSuccess: invalidate,
    onError: (err) => setError(translateSupabaseError(err, t('shop.suppliers.saveError'))),
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('shop.suppliers.manageTitle')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-2">
          {suppliers.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2">
              <div className="flex flex-col">
                <span className={!s.is_active ? 'text-text-secondary line-through' : ''}>{s.name}</span>
                {s.phone && <span dir="ltr" className="text-xs text-text-secondary">{s.phone}</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => startEdit(s)}>{t('common.edit')}</Button>
                <Button variant="ghost" size="sm" disabled={toggleActiveMutation.isPending} onClick={() => toggleActiveMutation.mutate(s)}>
                  {s.is_active ? t('shop.suppliers.deactivate') : t('shop.suppliers.reactivate')}
                </Button>
              </div>
            </div>
          ))}
          {suppliers.length === 0 && !addingOpen && !editingId && <p className="text-sm text-text-secondary">{t('shop.suppliers.emptyDescription')}</p>}

          {(addingOpen || editingId) ? (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <Input autoFocus placeholder={t('shop.suppliers.nameLabel')} value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Input dir="ltr" placeholder={t('shop.suppliers.phoneLabel')} value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
              <Input dir="ltr" type="email" placeholder={t('shop.suppliers.emailLabel')} value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
              <Input placeholder={t('shop.suppliers.notesLabel')} value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={!newName || createMutation.isPending || updateMutation.isPending}
                  onClick={() => { setError(null); if (editingId) { updateMutation.mutate(editingId) } else { createMutation.mutate() } }}
                >
                  {(createMutation.isPending || updateMutation.isPending) ? t('shop.suppliers.creating') : t('common.save')}
                </Button>
                <Button variant="outline" size="sm" onClick={resetForm}>{t('common.cancel')}</Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setAddingOpen(true)}>{t('shop.suppliers.addSupplier')}</Button>
          )}
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ProductVariantPicker({ clubId, productId, variantId, onProductChange, onVariantChange }: {
  clubId: string; productId: string; variantId: string;
  onProductChange: (v: string) => void; onVariantChange: (v: string) => void
}) {
  const { t } = useTranslation()
  const { data: products = [] } = useQuery({ queryKey: ['shop-inv-products', clubId], queryFn: () => fetchProducts(clubId) })
  const selected = products.find((p) => p.productId === productId)
  const { data: variants = [] } = useQuery({ queryKey: ['shop-inv-variants', productId], queryFn: () => fetchVariants(productId), enabled: !!selected?.hasVariants })

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.productLabel')}</label>
        <Select value={productId} onValueChange={onProductChange}>
          <SelectTrigger><SelectValue placeholder={t('shop.inventory.productPlaceholder')} /></SelectTrigger>
          <SelectContent>{products.map((p) => <SelectItem key={p.productId} value={p.productId}>{p.nameAr}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {selected?.hasVariants && (
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.variantLabel')}</label>
          <Select value={variantId} onValueChange={onVariantChange}>
            <SelectTrigger><SelectValue placeholder={t('shop.inventory.variantPlaceholder')} /></SelectTrigger>
            <SelectContent>{variants.map((v) => <SelectItem key={v.variantId} value={v.variantId}>{[v.size, v.color].filter(Boolean).join(' / ')}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      )}
    </>
  )
}

// =====================================================================
// Multi-item Receiving UX (plan Section 22). One supplier delivery,
// many product lines with per-line quantity + unit cost, plus a
// running expected-total-cost display. Posts via receive_shop_stock_batch
// (one atomic transaction for all lines -- see that RPC's own migration
// comment for the full transaction-boundary reasoning: a client-side
// loop over the single-item RPC was deliberately rejected because a
// mid-loop failure would leave some lines committed and others not,
// with no way to tell from the resulting state that the receipt was
// only half-posted).
// =====================================================================
interface ReceiveLine {
  key: string
  productId: string
  variantId: string
  quantity: string
  unitCost: string
}

function emptyReceiveLine(): ReceiveLine {
  return { key: crypto.randomUUID(), productId: '', variantId: '', quantity: '', unitCost: '' }
}

function ReceiveLineRow({ clubId, line, onChange, onRemove, canRemove }: {
  clubId: string; line: ReceiveLine; onChange: (line: ReceiveLine) => void; onRemove: () => void; canRemove: boolean
}) {
  const { t } = useTranslation()
  const { data: products = [] } = useQuery({ queryKey: ['shop-inv-products', clubId], queryFn: () => fetchProducts(clubId) })
  const selected = products.find((p) => p.productId === line.productId)
  const { data: variants = [] } = useQuery({ queryKey: ['shop-inv-variants', line.productId], queryFn: () => fetchVariants(line.productId), enabled: !!selected?.hasVariants })

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
      <ProductThumb src={selected?.imageUrl ?? null} alt={selected?.nameAr ?? ''} className="size-10 shrink-0 rounded-md" />
      <div className="flex min-w-40 flex-1 flex-col gap-1.5">
        <label className="text-xs font-medium text-text-secondary">{t('shop.inventory.productLabel')}</label>
        <Select value={line.productId} onValueChange={(v) => onChange({ ...line, productId: v, variantId: '' })}>
          <SelectTrigger><SelectValue placeholder={t('shop.inventory.productPlaceholder')} /></SelectTrigger>
          <SelectContent>{products.map((p) => <SelectItem key={p.productId} value={p.productId}>{p.nameAr}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {selected?.hasVariants && (
        <div className="flex min-w-32 flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">{t('shop.inventory.variantLabel')}</label>
          <Select value={line.variantId} onValueChange={(v) => onChange({ ...line, variantId: v })}>
            <SelectTrigger><SelectValue placeholder={t('shop.inventory.variantPlaceholder')} /></SelectTrigger>
            <SelectContent>{variants.map((v) => <SelectItem key={v.variantId} value={v.variantId}>{[v.size, v.color].filter(Boolean).join(' / ')}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      )}
      <div className="flex w-24 flex-col gap-1.5">
        <label className="text-xs font-medium text-text-secondary">{t('shop.inventory.quantityLabel')}</label>
        <Input type="number" min="0.01" step="0.01" value={line.quantity} onChange={(e) => onChange({ ...line, quantity: e.target.value })} />
      </div>
      <div className="flex w-28 flex-col gap-1.5">
        <label className="text-xs font-medium text-text-secondary">{t('shop.inventory.unitCostLabel')}</label>
        <Input type="number" min="0" step="0.01" value={line.unitCost} onChange={(e) => onChange({ ...line, unitCost: e.target.value })} />
      </div>
      <Button type="button" variant="ghost" size="icon" disabled={!canRemove} onClick={onRemove} aria-label={t('shop.inventory.removeLine')}>
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}

function ReceiveStockDialog({ clubId, onClose, onDone }: { clubId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [locationId, setLocationId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<ReceiveLine[]>([emptyReceiveLine()])
  const [error, setError] = useState<string | null>(null)
  const [receiptSummary, setReceiptSummary] = useState<{ lineCount: number; totalCost: number } | null>(null)

  const { data: locations = [] } = useQuery({ queryKey: ['shop-inv-locations', clubId], queryFn: () => fetchLocations(clubId) })

  const validLines = lines.filter((l) => l.productId && Number(l.quantity) > 0)
  const expectedTotalCost = validLines.reduce((sum, l) => sum + (Number(l.unitCost) || 0) * (Number(l.quantity) || 0), 0)
  const hasAnyCost = validLines.some((l) => l.unitCost !== '')

  function updateLine(key: string, next: ReceiveLine) {
    setLines((prev) => prev.map((l) => (l.key === key ? next : l)))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('receive_shop_stock_batch', {
        p_location_id: locationId,
        p_items: validLines.map((l) => ({
          product_id: l.productId,
          variant_id: l.variantId || null,
          quantity: Number(l.quantity),
          unit_cost: l.unitCost ? Number(l.unitCost) : null,
        })),
        p_supplier_id: supplierId || undefined,
        p_reference_number: referenceNumber || undefined,
        p_notes: notes || undefined,
      })
      if (err) throw err
    },
    onSuccess: () => setReceiptSummary({ lineCount: validLines.length, totalCost: expectedTotalCost }),
    onError: (err) => setError(translateSupabaseError(err, t('shop.inventory.receiveError'))),
  })

  // Receipt summary screen -- shown after a successful post, before
  // closing, so the operator has a clear confirmation of exactly what
  // was recorded (plan's own instruction: "show a clear receipt summary
  // after completion").
  if (receiptSummary) {
    return (
      <Dialog open onOpenChange={() => onDone()}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('shop.inventory.receiptSummary.title')}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">{t('shop.inventory.receiptSummary.description', { count: receiptSummary.lineCount })}</p>
            {hasAnyCost && (
              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <span className="text-sm font-medium">{t('shop.inventory.receiptSummary.totalCost')}</span>
                <MoneyDisplay amount={receiptSummary.totalCost} size="md" />
              </div>
            )}
            <div className="flex justify-end">
              <Button onClick={onDone}>{t('common.done')}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t('shop.inventory.receiveStock')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.locationLabel')}</label>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger><SelectValue placeholder={t('shop.inventory.locationPlaceholder')} /></SelectTrigger>
                <SelectContent>{locations.map((l) => <SelectItem key={l.locationId} value={l.locationId}>{l.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('shop.suppliers.pickerLabel')}</label>
              <SupplierPicker clubId={clubId} value={supplierId} onChange={setSupplierId} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.referenceNumberLabel')}</label>
              <Input dir="ltr" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.notesLabel')}</label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.itemsLabel')}</label>
            {lines.map((line) => (
              <ReceiveLineRow
                key={line.key}
                clubId={clubId}
                line={line}
                onChange={(next) => updateLine(line.key, next)}
                onRemove={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                canRemove={lines.length > 1}
              />
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, emptyReceiveLine()])}>
              <Plus className="me-1 size-4" />{t('shop.inventory.addLine')}
            </Button>
          </div>

          {hasAnyCost && (
            <div className="flex items-center justify-between rounded-md border border-border bg-surface-muted p-3">
              <span className="text-sm font-medium">{t('shop.inventory.expectedTotalCost')}</span>
              <MoneyDisplay amount={expectedTotalCost} size="md" />
            </div>
          )}

          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!locationId || validLines.length === 0 || mutation.isPending} onClick={() => { setError(null); mutation.mutate() }}>
              {mutation.isPending ? t('shop.inventory.receiving') : t('shop.inventory.receiveStock')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// =====================================================================
// Multi-item Transfer UX (plan Section 23). FROM/TO location header,
// item list (product, available qty at the from-location, transfer
// qty), summary, confirm. Posts via transfer_shop_stock_batch (same
// atomic-transaction reasoning as receiving).
// =====================================================================
interface TransferLine {
  key: string
  productId: string
  variantId: string
  quantity: string
}

function emptyTransferLine(): TransferLine {
  return { key: crypto.randomUUID(), productId: '', variantId: '', quantity: '' }
}

function TransferLineRow({ clubId, sourceLocationId, line, onChange, onRemove, canRemove }: {
  clubId: string; sourceLocationId: string; line: TransferLine; onChange: (line: TransferLine) => void; onRemove: () => void; canRemove: boolean
}) {
  const { t } = useTranslation()
  const { data: products = [] } = useQuery({ queryKey: ['shop-inv-products', clubId], queryFn: () => fetchProducts(clubId) })
  const selected = products.find((p) => p.productId === line.productId)
  const { data: variants = [] } = useQuery({ queryKey: ['shop-inv-variants', line.productId], queryFn: () => fetchVariants(line.productId), enabled: !!selected?.hasVariants })

  // Available quantity at the source location for this exact product/
  // variant -- plan's own instruction ("product, available qty at the
  // from-location, transfer qty"). Reuses get_shop_inventory_balances
  // unmodified (already scoped by p_location_id).
  const { data: sourceBalances = [] } = useQuery({
    queryKey: ['shop-inv-source-balance', clubId, sourceLocationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_shop_inventory_balances', { p_club_id: clubId, p_location_id: sourceLocationId })
      if (error) throw error
      return (data ?? []) as { product_id: string; variant_id: string | null; on_hand: number | string }[]
    },
    enabled: !!sourceLocationId,
  })
  const availableAtSource = sourceBalances.find((b) => b.product_id === line.productId
    && (line.variantId ? b.variant_id === line.variantId : b.variant_id === null))
  const availableQty = availableAtSource ? Number(availableAtSource.on_hand) : null

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
      <ProductThumb src={selected?.imageUrl ?? null} alt={selected?.nameAr ?? ''} className="size-10 shrink-0 rounded-md" />
      <div className="flex min-w-40 flex-1 flex-col gap-1.5">
        <label className="text-xs font-medium text-text-secondary">{t('shop.inventory.productLabel')}</label>
        <Select value={line.productId} onValueChange={(v) => onChange({ ...line, productId: v, variantId: '' })}>
          <SelectTrigger><SelectValue placeholder={t('shop.inventory.productPlaceholder')} /></SelectTrigger>
          <SelectContent>{products.map((p) => <SelectItem key={p.productId} value={p.productId}>{p.nameAr}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {selected?.hasVariants && (
        <div className="flex min-w-32 flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">{t('shop.inventory.variantLabel')}</label>
          <Select value={line.variantId} onValueChange={(v) => onChange({ ...line, variantId: v })}>
            <SelectTrigger><SelectValue placeholder={t('shop.inventory.variantPlaceholder')} /></SelectTrigger>
            <SelectContent>{variants.map((v) => <SelectItem key={v.variantId} value={v.variantId}>{[v.size, v.color].filter(Boolean).join(' / ')}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      )}
      {line.productId && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-secondary">{t('shop.inventory.availableAtSource')}</span>
          <span className={`text-sm font-semibold ${availableQty !== null && availableQty <= 0 ? 'text-status-danger' : ''}`}>
            {availableQty ?? '—'}
          </span>
        </div>
      )}
      <div className="flex w-24 flex-col gap-1.5">
        <label className="text-xs font-medium text-text-secondary">{t('shop.inventory.quantityLabel')}</label>
        <Input type="number" min="0.01" step="0.01" value={line.quantity} onChange={(e) => onChange({ ...line, quantity: e.target.value })} />
      </div>
      <Button type="button" variant="ghost" size="icon" disabled={!canRemove} onClick={onRemove} aria-label={t('shop.inventory.removeLine')}>
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}

function TransferStockDialog({ clubId, onClose, onDone }: { clubId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [sourceId, setSourceId] = useState('')
  const [destId, setDestId] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<TransferLine[]>([emptyTransferLine()])
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<number | null>(null)

  const { data: locations = [] } = useQuery({ queryKey: ['shop-inv-locations', clubId], queryFn: () => fetchLocations(clubId) })

  const validLines = lines.filter((l) => l.productId && Number(l.quantity) > 0)

  function updateLine(key: string, next: TransferLine) {
    setLines((prev) => prev.map((l) => (l.key === key ? next : l)))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('transfer_shop_stock_batch', {
        p_source_location_id: sourceId,
        p_dest_location_id: destId,
        p_items: validLines.map((l) => ({
          product_id: l.productId, variant_id: l.variantId || null, quantity: Number(l.quantity),
        })),
        p_notes: notes || undefined,
      })
      if (err) throw err
    },
    onSuccess: () => setDone(validLines.length),
    onError: (err) => setError(translateSupabaseError(err, t('shop.inventory.transferError'))),
  })

  if (done !== null) {
    return (
      <Dialog open onOpenChange={() => onDone()}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('shop.inventory.transferSummary.title')}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">{t('shop.inventory.transferSummary.description', { count: done })}</p>
            <div className="flex justify-end">
              <Button onClick={onDone}>{t('common.done')}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t('shop.inventory.transferStock')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.sourceLocationLabel')}</label>
              <Select value={sourceId} onValueChange={(v) => { setSourceId(v); setLines([emptyTransferLine()]) }}>
                <SelectTrigger><SelectValue placeholder={t('shop.inventory.locationPlaceholder')} /></SelectTrigger>
                <SelectContent>{locations.map((l) => <SelectItem key={l.locationId} value={l.locationId}>{l.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.destLocationLabel')}</label>
              <Select value={destId} onValueChange={setDestId}>
                <SelectTrigger><SelectValue placeholder={t('shop.inventory.locationPlaceholder')} /></SelectTrigger>
                <SelectContent>{locations.filter((l) => l.locationId !== sourceId).map((l) => <SelectItem key={l.locationId} value={l.locationId}>{l.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.notesLabel')}</label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.itemsLabel')}</label>
            {!sourceId && <p className="text-sm text-text-secondary">{t('shop.inventory.pickSourceFirst')}</p>}
            {sourceId && lines.map((line) => (
              <TransferLineRow
                key={line.key}
                clubId={clubId}
                sourceLocationId={sourceId}
                line={line}
                onChange={(next) => updateLine(line.key, next)}
                onRemove={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                canRemove={lines.length > 1}
              />
            ))}
            {sourceId && (
              <Button type="button" variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, emptyTransferLine()])}>
                <Plus className="me-1 size-4" />{t('shop.inventory.addLine')}
              </Button>
            )}
          </div>

          <div className="rounded-md border border-border bg-surface-muted p-3 text-sm">
            {t('shop.inventory.transferSummaryLine', { count: validLines.length })}
          </div>

          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!sourceId || !destId || validLines.length === 0 || mutation.isPending} onClick={() => { setError(null); mutation.mutate() }}>
              {mutation.isPending ? t('shop.inventory.transferring') : t('shop.inventory.transferStock')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AdjustStockDialog({ clubId, onClose, onDone }: { clubId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [locationId, setLocationId] = useState('')
  const [productId, setProductId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [movementType, setMovementType] = useState('adjustment_in')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: locations = [] } = useQuery({ queryKey: ['shop-inv-locations', clubId], queryFn: () => fetchLocations(clubId) })

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('adjust_shop_stock', {
        p_location_id: locationId, p_product_id: productId, p_variant_id: variantId || undefined,
        p_movement_type: movementType, p_quantity: Number(quantity), p_reason: reason,
      })
      if (err) throw err
    },
    onSuccess: onDone,
    onError: (err) => setError(translateSupabaseError(err, t('shop.inventory.adjustError'))),
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('shop.inventory.adjustStock')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.locationLabel')}</label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger><SelectValue placeholder={t('shop.inventory.locationPlaceholder')} /></SelectTrigger>
              <SelectContent>{locations.map((l) => <SelectItem key={l.locationId} value={l.locationId}>{l.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <ProductVariantPicker clubId={clubId} productId={productId} variantId={variantId} onProductChange={(v) => { setProductId(v); setVariantId('') }} onVariantChange={setVariantId} />
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.adjustmentTypeLabel')}</label>
            <Select value={movementType} onValueChange={setMovementType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="adjustment_in">{t('shop.inventory.movementTypes.adjustment_in')}</SelectItem>
                <SelectItem value="adjustment_out">{t('shop.inventory.movementTypes.adjustment_out')}</SelectItem>
                <SelectItem value="damage">{t('shop.inventory.movementTypes.damage')}</SelectItem>
                <SelectItem value="loss">{t('shop.inventory.movementTypes.loss')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.quantityLabel')}</label>
            <Input type="number" min="0.01" step="0.01" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.reasonLabel')}</label>
            <Input required value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!locationId || !productId || !quantity || !reason || mutation.isPending} onClick={() => { setError(null); mutation.mutate() }}>
              {mutation.isPending ? t('shop.inventory.adjusting') : t('shop.inventory.adjustStock')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// =====================================================================
// Product Detail dialog (plan Section 21): GENERAL / STOCK / MOVEMENTS
// / SALES HISTORY / RETURNS / SUPPLIER tabs. Follows the same
// manual-tab-strip pattern ShopReportsPage.tsx already established
// (this codebase's house pattern for a tabbed hub, not the Radix Tabs
// primitive -- confirmed no existing Shop screen uses TabsList/
// TabsTrigger).
// =====================================================================
type DetailTab = 'general' | 'stock' | 'movements' | 'sales' | 'returns' | 'supplier'

function ProductDetailDialog({ clubId, productId, onClose }: { clubId: string; productId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<DetailTab>('general')

  const { data: product } = useQuery({
    queryKey: ['shop-inv-product-detail', clubId, productId],
    queryFn: async () => {
      // PERF-05 (production audit remediation, 2026-09-03):
      // list_shop_products now defaults to 50 rows (p_limit/p_offset,
      // see that RPC's own migration comment). This dialog fetches the
      // full list and finds one product client-side by id -- with no
      // explicit limit here, a product past #50 would silently fail to
      // be found (the dialog would render as if the product doesn't
      // exist). Same PRODUCT_PICKER_LIMIT treatment as this file's other
      // picker call sites; p_status intentionally left unset (unchanged
      // from before this fix) so the RPC's own 'active' default still
      // applies here.
      const { data, error } = await supabase.rpc('list_shop_products', { p_club_id: clubId, p_limit: PRODUCT_PICKER_LIMIT })
      if (error) throw error
      return (data ?? []).find((p) => p.product_id === productId) ?? null
    },
    enabled: !!clubId,
  })

  const { data: stockRows = [] } = useQuery({
    queryKey: ['shop-inv-product-stock', clubId, productId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_shop_inventory_balances', { p_club_id: clubId })
      if (error) throw error
      return (data ?? []).filter((r) => r.product_id === productId)
    },
    enabled: tab === 'stock' || tab === 'general',
  })

  const { data: movementRows = [] } = useQuery({
    queryKey: ['shop-inv-product-movements', clubId, productId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_shop_inventory_movements', { p_club_id: clubId, p_product_id: productId, p_limit: 50 })
      if (error) throw error
      return data ?? []
    },
    enabled: tab === 'movements' || tab === 'supplier',
  })

  const { data: salesRows = [] } = useQuery({
    queryKey: ['shop-inv-product-sales', clubId, productId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_shop_product_sales_history', { p_club_id: clubId, p_product_id: productId, p_limit: 50 })
      if (error) throw error
      return data ?? []
    },
    enabled: tab === 'sales',
  })

  const { data: returnRows = [] } = useQuery({
    queryKey: ['shop-inv-product-returns', clubId, productId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_shop_product_returns', { p_club_id: clubId, p_product_id: productId, p_limit: 50 })
      if (error) throw error
      return data ?? []
    },
    enabled: tab === 'returns',
  })

  const { data: suppliersById = new Map<string, string>() } = useQuery({
    queryKey: ['shop-suppliers-lookup', clubId],
    queryFn: async () => {
      const { data, error } = await supabase.from('shop_suppliers').select('id, name').eq('club_id', clubId)
      if (error) throw error
      return new Map((data ?? []).map((s) => [s.id as string, s.name as string]))
    },
    enabled: tab === 'supplier',
  })

  const totalOnHand = stockRows.reduce((sum, r) => sum + Number(r.on_hand), 0)

  const supplierNames = Array.from(new Set(
    movementRows
      .filter((m) => m.movement_type === 'purchase_receipt' && m.reference_type === 'shop_supplier' && m.reference_id)
      .map((m) => suppliersById.get(m.reference_id as string) ?? null)
      .filter((n): n is string => !!n),
  ))
  const unattributedReceiptCount = movementRows.filter((m) => m.movement_type === 'purchase_receipt' && !m.reference_id).length

  const tabs: { key: DetailTab; label: string }[] = [
    { key: 'general', label: t('shop.inventory.detail.tabs.general') },
    { key: 'stock', label: t('shop.inventory.detail.tabs.stock') },
    { key: 'movements', label: t('shop.inventory.detail.tabs.movements') },
    { key: 'sales', label: t('shop.inventory.detail.tabs.sales') },
    { key: 'returns', label: t('shop.inventory.detail.tabs.returns') },
    { key: 'supplier', label: t('shop.inventory.detail.tabs.supplier') },
  ]

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <ProductThumb src={product?.image_url ?? null} alt={product?.name_ar ?? ''} className="size-10 rounded-md" />
            <span>{product?.name_ar ?? t('shop.inventory.detail.title')}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap gap-1 border-b border-border pb-2">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              type="button"
              onClick={() => setTab(tb.key)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${tab === tb.key ? 'bg-muted text-foreground' : 'text-text-secondary hover:bg-muted/50'}`}
            >
              {tb.label}
            </button>
          ))}
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {tab === 'general' && product && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-text-secondary">{t('shop.inventory.detail.sku')}</span><p className="font-medium" dir="ltr">{product.sku ?? '—'}</p></div>
              <div><span className="text-text-secondary">{t('shop.inventory.detail.barcode')}</span><p className="font-medium" dir="ltr">{product.barcode ?? '—'}</p></div>
              <div><span className="text-text-secondary">{t('shop.inventory.detail.category')}</span><p className="font-medium">{product.category_name_ar ?? '—'}</p></div>
              <div><span className="text-text-secondary">{t('shop.inventory.detail.basePrice')}</span><MoneyDisplay amount={Number(product.base_price)} size="sm" /></div>
              <div><span className="text-text-secondary">{t('shop.inventory.detail.reorderLevel')}</span><p className="font-medium">{product.reorder_level ?? '—'}</p></div>
              <div><span className="text-text-secondary">{t('shop.inventory.detail.totalOnHand')}</span><p className="font-medium">{totalOnHand}</p></div>
            </div>
          )}

          {tab === 'stock' && (
            <table className="w-full text-start text-sm">
              <thead><tr className="border-b border-border text-text-secondary"><th className="p-2 text-start">{t('shop.inventory.columns.location')}</th><th className="p-2 text-start">{t('shop.inventory.columns.onHand')}</th></tr></thead>
              <tbody>
                {stockRows.map((r) => (
                  <tr key={`${r.location_id}-${r.variant_id ?? ''}`} className="border-b border-border last:border-0">
                    <td className="p-2">{r.location_name}{r.variant_label ? ` (${r.variant_label})` : ''}</td>
                    <td className="p-2 font-medium">{Number(r.on_hand)}</td>
                  </tr>
                ))}
                {stockRows.length === 0 && <tr><td colSpan={2} className="p-4 text-center text-text-secondary">{t('shop.inventory.emptyBalancesTitle')}</td></tr>}
              </tbody>
            </table>
          )}

          {tab === 'movements' && (
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-border text-text-secondary">
                  <th className="p-2 text-start">{t('shop.inventory.columns.date')}</th>
                  <th className="p-2 text-start">{t('shop.inventory.columns.movementType')}</th>
                  <th className="p-2 text-start">{t('shop.inventory.columns.quantity')}</th>
                  <th className="p-2 text-start">{t('shop.inventory.columns.location')}</th>
                  <th className="p-2 text-start">{t('shop.inventory.detail.reference')}</th>
                </tr>
              </thead>
              <tbody>
                {movementRows.map((m) => (
                  <tr key={m.movement_id} className="border-b border-border last:border-0">
                    <td className="p-2"><FormattedDate value={m.created_at} timeZone="Africa/Cairo" options={{ year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }} /></td>
                    <td className="p-2">{t(`shop.inventory.movementTypes.${m.movement_type}`, { defaultValue: m.movement_type })}</td>
                    <td className="p-2">{Number(m.quantity)}</td>
                    <td className="p-2">{m.location_name}</td>
                    <td className="p-2 text-text-secondary">{m.reason ?? '—'}</td>
                  </tr>
                ))}
                {movementRows.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-text-secondary">{t('shop.inventory.emptyMovementsTitle')}</td></tr>}
              </tbody>
            </table>
          )}

          {tab === 'sales' && (
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-border text-text-secondary">
                  <th className="p-2 text-start">{t('shop.inventory.columns.date')}</th>
                  <th className="p-2 text-start">{t('shop.inventory.detail.invoice')}</th>
                  <th className="p-2 text-start">{t('shop.dashboard.columns.customer')}</th>
                  <th className="p-2 text-start">{t('shop.inventory.columns.quantity')}</th>
                  <th className="p-2 text-start">{t('shop.dashboard.columns.revenue')}</th>
                </tr>
              </thead>
              <tbody>
                {salesRows.map((s) => (
                  <tr key={s.sale_id} className="border-b border-border last:border-0">
                    <td className="p-2"><FormattedDate value={s.created_at} timeZone="Africa/Cairo" options={{ year: 'numeric', month: 'short', day: 'numeric' }} /></td>
                    <td className="p-2">{s.invoice_number}</td>
                    <td className="p-2">{s.customer_name ?? t('shop.dashboard.walkIn')}</td>
                    <td className="p-2">{Number(s.quantity)}</td>
                    <td className="p-2"><MoneyDisplay amount={Number(s.line_total)} size="sm" /></td>
                  </tr>
                ))}
                {salesRows.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-text-secondary">{t('shop.dashboard.emptySales')}</td></tr>}
              </tbody>
            </table>
          )}

          {tab === 'returns' && (
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-border text-text-secondary">
                  <th className="p-2 text-start">{t('shop.inventory.columns.date')}</th>
                  <th className="p-2 text-start">{t('shop.inventory.detail.invoice')}</th>
                  <th className="p-2 text-start">{t('shop.inventory.columns.quantity')}</th>
                  <th className="p-2 text-start">{t('shop.dashboard.columns.reason')}</th>
                  <th className="p-2 text-start">{t('shop.dashboard.columns.refund')}</th>
                </tr>
              </thead>
              <tbody>
                {returnRows.map((r) => (
                  <tr key={r.return_id} className="border-b border-border last:border-0">
                    <td className="p-2"><FormattedDate value={r.created_at} timeZone="Africa/Cairo" options={{ year: 'numeric', month: 'short', day: 'numeric' }} /></td>
                    <td className="p-2">{r.invoice_number}</td>
                    <td className="p-2">{Number(r.quantity)}</td>
                    <td className="p-2 text-text-secondary">{r.reason}</td>
                    <td className="p-2">{r.refund_amount === null ? t('shop.dashboard.restockOnly') : <MoneyDisplay amount={Number(r.refund_amount)} size="sm" tone="danger" />}</td>
                  </tr>
                ))}
                {returnRows.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-text-secondary">{t('shop.dashboard.emptyReturns')}</td></tr>}
              </tbody>
            </table>
          )}

          {tab === 'supplier' && (
            <div className="flex flex-col gap-3 text-sm">
              {/* No dedicated "default supplier per product" concept
                  exists in the schema (shop_products has no supplier_id
                  column -- supplier association is per-receipt, per the
                  directive's own confirmed design). Derived here as the
                  distinct set of suppliers who have ever supplied this
                  product, from the movements this dialog already fetches. */}
              {supplierNames.length === 0 && unattributedReceiptCount === 0 && (
                <p className="text-text-secondary">{t('shop.inventory.detail.noSupplierData')}</p>
              )}
              {supplierNames.length > 0 && (
                <div>
                  <p className="mb-1 font-medium">{t('shop.inventory.detail.knownSuppliers')}</p>
                  <ul className="list-inside list-disc">
                    {supplierNames.map((name) => <li key={name}>{name}</li>)}
                  </ul>
                </div>
              )}
              {unattributedReceiptCount > 0 && (
                <p className="text-text-secondary">{t('shop.inventory.detail.unattributedReceipts', { count: unattributedReceiptCount })}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
