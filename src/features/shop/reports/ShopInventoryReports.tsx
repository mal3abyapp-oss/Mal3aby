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
import { REPORT_PAGE_SIZE, useOffsetPager, PagerControls, ReportHeaderActions, FullPrintNote } from '@/features/shop/reports/shopReportShared'

const ALL_VALUE = '__all__'
const MOVEMENT_TYPES = [
  'opening_balance', 'purchase_receipt', 'sale', 'sale_return', 'transfer_out', 'transfer_in',
  'adjustment_in', 'adjustment_out', 'damage', 'loss', 'stock_count_adjustment',
]

interface LocationOption { id: string; label: string }
async function fetchLocations(clubId: string): Promise<LocationOption[]> {
  const { data, error } = await supabase.rpc('list_shop_inventory_locations', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({ id: r.location_id, label: r.name }))
}

// ---------------------------------------------------------------------
// INVENTORY ON HAND (item 9) -- real stock levels across locations,
// reusing get_shop_inventory_balances (no low-stock filter applied
// here; that is its own dedicated report below).
// ---------------------------------------------------------------------
interface BalanceRow { locationId: string; locationName: string; productId: string; productNameAr: string; variantId: string | null; variantLabel: string | null; onHand: number; reorderLevel: number | null }
interface BalanceApiRow { location_id: string; location_name: string; product_id: string; product_name_ar: string; variant_id: string | null; variant_label: string | null; on_hand: number | string; reorder_level: number | null }

function mapBalances(rows: BalanceApiRow[]): BalanceRow[] {
  return rows.map((r) => ({ locationId: r.location_id, locationName: r.location_name, productId: r.product_id, productNameAr: r.product_name_ar, variantId: r.variant_id, variantLabel: r.variant_label, onHand: Number(r.on_hand), reorderLevel: r.reorder_level }))
}

function useBalancesReport(lowStockOnly: boolean, outOfStockOnly: boolean) {
  const { currentClubId } = useAuth()
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['shop-report-balances', currentClubId, lowStockOnly],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_shop_inventory_balances', { p_club_id: currentClubId as string, p_low_stock_only: lowStockOnly })
      if (error) throw error
      const mapped = mapBalances((data ?? []) as BalanceApiRow[])
      return outOfStockOnly ? mapped.filter((r) => r.onHand === 0) : mapped
    },
    enabled: !!currentClubId,
  })
  return { rows, isLoading }
}

function BalancesTable({ rows, isLoading, emptyKey }: { rows: BalanceRow[]; isLoading: boolean; emptyKey: string }) {
  const { t } = useTranslation()
  const columns: DataTableColumn<BalanceRow>[] = [
    { key: 'product', header: t('reports.shop.columns.product'), render: (r) => r.productNameAr + (r.variantLabel ? ` (${r.variantLabel})` : '') },
    { key: 'location', header: t('shop.inventory.columns.location'), render: (r) => r.locationName },
    { key: 'onHand', header: t('shop.dashboard.columns.onHand'), render: (r) => r.onHand },
    { key: 'reorderLevel', header: t('shop.reports.inventoryOnHand.reorderLevel'), render: (r) => r.reorderLevel ?? '—' },
  ]
  return <DataTable columns={columns} rows={rows} rowKey={(r) => `${r.locationId}-${r.productId}-${r.variantId ?? 'none'}`} isLoading={isLoading} emptyTitle={t(emptyKey)} />
}

export function ReportShopInventoryOnHandContent() {
  const { t } = useTranslation()
  const { rows, isLoading } = useBalancesReport(false, false)
  return (
    <div data-testid="report-inventory-on-hand" data-row-count={rows.length} data-loading={isLoading}>
      <div className="mb-3 flex justify-end print:hidden"><ReportHeaderActions hasRows={rows.length > 0} /></div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.inventoryOnHand.title')} />
        <BalancesTable rows={rows} isLoading={isLoading} emptyKey="shop.reports.inventoryOnHand.empty" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// LOW STOCK (item 11) -- reuses the exact pattern C6 already built
// (get_shop_inventory_balances(p_low_stock_only=true)); inherits that
// RPC's own documented never-stocked-variant gap (see
// 20260828095500_fix_shop_inventory_summary_out_of_stock_missing_variants.sql's
// own comment) -- deliberately not re-fixed here, same reasoning C6
// already applied (other callers depend on the current row shape).
// ---------------------------------------------------------------------
export function ReportShopLowStockContent() {
  const { t } = useTranslation()
  const { rows, isLoading } = useBalancesReport(true, false)
  return (
    <div>
      <div className="mb-3 flex justify-end print:hidden"><ReportHeaderActions hasRows={rows.length > 0} /></div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.lowStock.title')} />
        <p className="mb-2 text-xs text-text-secondary print:hidden">{t('shop.reports.lowStock.knownGapNote')}</p>
        <BalancesTable rows={rows} isLoading={isLoading} emptyKey="shop.reports.lowStock.empty" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// OUT OF STOCK (item 12) -- same balances RPC, filtered to on_hand=0
// client-side (get_shop_inventory_balances has no dedicated zero-only
// server flag; balances are already a bounded, per-club, per-location
// list -- not the kind of dataset fetchFullReport's pagination
// contract exists for, matching how this same RPC is already consumed
// unpaginated by ShopInventoryPage.tsx itself).
// ---------------------------------------------------------------------
export function ReportShopOutOfStockContent() {
  const { t } = useTranslation()
  const { rows, isLoading } = useBalancesReport(false, true)
  return (
    <div>
      <div className="mb-3 flex justify-end print:hidden"><ReportHeaderActions hasRows={rows.length > 0} /></div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.outOfStock.title')} />
        <BalancesTable rows={rows} isLoading={isLoading} emptyKey="shop.reports.outOfStock.empty" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// STOCK MOVEMENT LEDGER (item 10) -- the full shop_inventory_movements
// history, filterable/paginated. list_shop_inventory_movements
// extended this phase with date range + movement_type filter; already
// had p_limit/p_offset (mandatory here per the plan -- this table can
// grow large).
// ---------------------------------------------------------------------
interface MovementRow { movementId: string; locationName: string; productNameAr: string; variantLabel: string | null; movementType: string; quantity: number; unitCost: number | null; reason: string | null; createdAt: string }
interface MovementApiRow { movement_id: string; location_name: string; product_name_ar: string; variant_label: string | null; movement_type: string; quantity: number | string; unit_cost: number | string | null; reason: string | null; created_at: string }

function mapMovements(rows: MovementApiRow[]): MovementRow[] {
  return rows.map((r) => ({ movementId: r.movement_id, locationName: r.location_name, productNameAr: r.product_name_ar, variantLabel: r.variant_label, movementType: r.movement_type, quantity: Number(r.quantity), unitCost: r.unit_cost === null ? null : Number(r.unit_cost), reason: r.reason, createdAt: r.created_at }))
}

export function ReportShopStockMovementLedgerContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { offset, setOffset, reset } = useOffsetPager()
  const [movementType, setMovementType] = useState(ALL_VALUE)
  const [locationId, setLocationId] = useState(ALL_VALUE)

  const { data: locations = [] } = useQuery({ queryKey: ['shop-report-locations', currentClubId], queryFn: () => fetchLocations(currentClubId as string), enabled: !!currentClubId })

  const args = {
    p_club_id: currentClubId as string, p_start_date: startDate || undefined, p_end_date: endDate || undefined,
    p_movement_type: movementType === ALL_VALUE ? undefined : movementType,
    p_location_id: locationId === ALL_VALUE ? undefined : locationId,
  }
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['shop-report-movements', currentClubId, startDate, endDate, movementType, locationId, offset],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_shop_inventory_movements', { ...args, p_limit: REPORT_PAGE_SIZE, p_offset: offset })
      if (error) throw error
      return mapMovements((data ?? []) as MovementApiRow[])
    },
    enabled: !!currentClubId,
  })

  const [fullRows, setFullRows] = useState<MovementRow[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const fullPrint = useMutation({
    mutationFn: () => fetchFullReport<MovementApiRow>('list_shop_inventory_movements', args),
    onSuccess: (result) => { setFullRows(mapMovements(result.rows)); setTruncated(result.truncated); requestAnimationFrame(() => requestAnimationFrame(() => window.print())) },
  })
  const printed = fullRows ?? rows

  const columns: DataTableColumn<MovementRow>[] = [
    { key: 'date', header: t('shop.sales.columns.date'), render: (r) => <FormattedDate value={r.createdAt} timeZone="Africa/Cairo" options={{ year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }} /> },
    { key: 'product', header: t('reports.shop.columns.product'), render: (r) => r.productNameAr + (r.variantLabel ? ` (${r.variantLabel})` : '') },
    { key: 'location', header: t('shop.inventory.columns.location'), render: (r) => r.locationName },
    { key: 'type', header: t('shop.inventory.columns.movementType'), render: (r) => t(`shop.inventory.movementTypes.${r.movementType}`, { defaultValue: r.movementType }) },
    { key: 'qty', header: t('reports.shop.columns.unitsSold'), render: (r) => r.quantity },
    { key: 'unitCost', header: t('shop.reports.gp.unitCost'), render: (r) => r.unitCost !== null ? <MoneyDisplay amount={r.unitCost} size="sm" /> : '—' },
    { key: 'reason', header: t('shop.sales.reasonLabel'), render: (r) => r.reason ?? '—' },
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
            <label className="text-xs text-text-secondary">{t('shop.inventory.columns.movementType')}</label>
            <Select value={movementType} onValueChange={(v) => { setMovementType(v); reset() }}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE}>{t('shop.sales.filters.allStatuses')}</SelectItem>
                {MOVEMENT_TYPES.map((m) => <SelectItem key={m} value={m}>{t(`shop.inventory.movementTypes.${m}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.inventory.columns.location')}</label>
            <Select value={locationId} onValueChange={(v) => { setLocationId(v); reset() }}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE}>{t('shop.sales.filters.allBranches')}</SelectItem>
                {locations.map((l) => <SelectItem key={l.id} value={l.id}><bdi>{l.label}</bdi></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <ReportHeaderActions hasRows={rows.length > 0} onPrintFull={() => { setFullRows(null); fullPrint.mutate() }} printFullPending={fullPrint.isPending} />
      </div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.stockMovementLedger.title')} />
        <FullPrintNote fullCount={fullRows?.length ?? null} truncated={truncated} screenLimit={REPORT_PAGE_SIZE} />
        <DataTable columns={columns} rows={printed} rowKey={(r) => r.movementId} isLoading={isLoading} emptyTitle={t('shop.reports.stockMovementLedger.empty')} />
        {fullRows === null && <PagerControls offset={offset} pageSize={REPORT_PAGE_SIZE} rowCount={rows.length} onPrev={() => setOffset(Math.max(0, offset - REPORT_PAGE_SIZE))} onNext={() => setOffset(offset + REPORT_PAGE_SIZE)} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// STOCK VALUATION (item 13) -- on-hand x cost, same "last purchase
// receipt cost" source as the cost-at-sale snapshot, for consistency
// (see get_shop_stock_valuation's own migration comment). Gated on
// shop.reports.view_profit server-side -- a permission-denied error
// here is expected and correct for a role without that grant, shown
// as a real error state, not silently hidden.
// ---------------------------------------------------------------------
interface ValuationRow { locationId: string; locationName: string; productId: string; productNameAr: string; variantId: string | null; variantLabel: string | null; onHand: number; unitCost: number | null; lineValue: number | null }
interface ValuationApiRow { location_id: string; location_name: string; product_id: string; product_name_ar: string; variant_id: string | null; variant_label: string | null; on_hand: number | string; unit_cost: number | string | null; line_value: number | string | null }

export function ReportShopStockValuationContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()

  const { data: rows = [], isLoading, isError } = useQuery({
    queryKey: ['shop-report-valuation', currentClubId],
    queryFn: async () => {
      const { data, error: err } = await supabase.rpc('get_shop_stock_valuation', { p_club_id: currentClubId as string })
      if (err) throw err
      return (data ?? []).map((r: ValuationApiRow) => ({
        locationId: r.location_id, locationName: r.location_name, productId: r.product_id, productNameAr: r.product_name_ar,
        variantId: r.variant_id, variantLabel: r.variant_label, onHand: Number(r.on_hand),
        unitCost: r.unit_cost === null ? null : Number(r.unit_cost), lineValue: r.line_value === null ? null : Number(r.line_value),
      })) as ValuationRow[]
    },
    enabled: !!currentClubId,
  })

  const totalValue = rows.reduce((sum, r) => sum + (r.lineValue ?? 0), 0)
  const unknownCount = rows.filter((r) => r.unitCost === null && r.onHand > 0).length

  const columns: DataTableColumn<ValuationRow>[] = [
    { key: 'product', header: t('reports.shop.columns.product'), render: (r) => r.productNameAr + (r.variantLabel ? ` (${r.variantLabel})` : '') },
    { key: 'location', header: t('shop.inventory.columns.location'), render: (r) => r.locationName },
    { key: 'onHand', header: t('shop.dashboard.columns.onHand'), render: (r) => r.onHand },
    { key: 'unitCost', header: t('shop.reports.gp.unitCost'), render: (r) => r.unitCost !== null ? <MoneyDisplay amount={r.unitCost} size="sm" /> : t('shop.reports.gp.costUnavailable') },
    { key: 'lineValue', header: t('shop.reports.stockValuation.lineValue'), render: (r) => r.lineValue !== null ? <MoneyDisplay amount={r.lineValue} size="sm" /> : t('shop.reports.gp.costUnavailable') },
  ]

  if (isError) {
    return <p className="py-8 text-center text-sm text-status-danger" data-testid="report-stock-valuation-permission-denied">{t('shop.reports.permissionDenied')}</p>
  }

  return (
    <div data-testid="report-stock-valuation" data-row-count={rows.length} data-unknown-cost-count={unknownCount}>
      <div className="mb-3 flex items-center justify-between print:hidden">
        <p className="text-sm text-text-secondary">
          {t('shop.reports.stockValuation.totalValue')}: <span data-testid="report-stock-valuation-total"><MoneyDisplay amount={totalValue} size="md" /></span>
          {unknownCount > 0 && <span className="ms-2 text-status-warning" data-testid="report-stock-valuation-unknown-cost-note">{t('shop.reports.stockValuation.unknownCostNote', { count: unknownCount })}</span>}
        </p>
        <ReportHeaderActions hasRows={rows.length > 0} />
      </div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.stockValuation.title')} />
        <DataTable columns={columns} rows={rows} rowKey={(r) => `${r.locationId}-${r.productId}-${r.variantId ?? 'none'}`} isLoading={isLoading} emptyTitle={t('shop.reports.stockValuation.empty')} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// SUPPLIER PURCHASE/RECEIPT ACTIVITY (item 15) -- lighter report, per
// the plan's own explicit allowance ("may be a lighter report if data
// is thin"): shop_suppliers is a minimal lookup table, no accounts-
// payable/procurement engine exists. One row per supplier (plus a
// "no supplier recorded" bucket for receipts with no p_supplier_id).
// ---------------------------------------------------------------------
interface SupplierActivityRow { supplierId: string | null; supplierName: string; receiptCount: number; totalQuantity: number; totalCostValue: number; lastReceiptAt: string | null }

export function ReportShopSupplierActivityContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['shop-report-supplier-activity', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_shop_supplier_purchase_activity', { p_club_id: currentClubId as string, p_start_date: startDate || undefined, p_end_date: endDate || undefined })
      if (error) throw error
      return (data ?? []).map((r) => ({
        supplierId: r.supplier_id, supplierName: r.supplier_name, receiptCount: Number(r.receipt_count),
        totalQuantity: Number(r.total_quantity), totalCostValue: Number(r.total_cost_value), lastReceiptAt: r.last_receipt_at,
      })) as SupplierActivityRow[]
    },
    enabled: !!currentClubId,
  })

  const columns: DataTableColumn<SupplierActivityRow>[] = [
    { key: 'supplier', header: t('shop.reports.supplierActivity.supplierColumn'), render: (r) => r.supplierId ? r.supplierName : t('shop.reports.supplierActivity.noSupplier') },
    { key: 'receipts', header: t('shop.reports.supplierActivity.receiptCount'), render: (r) => r.receiptCount },
    { key: 'qty', header: t('shop.reports.supplierActivity.totalQuantity'), render: (r) => r.totalQuantity },
    { key: 'value', header: t('shop.reports.supplierActivity.totalCostValue'), render: (r) => <MoneyDisplay amount={r.totalCostValue} size="sm" /> },
    { key: 'lastReceipt', header: t('shop.reports.supplierActivity.lastReceipt'), render: (r) => r.lastReceiptAt ? <FormattedDate value={r.lastReceiptAt} timeZone="Africa/Cairo" options={{ year: 'numeric', month: 'short', day: 'numeric' }} /> : '—' },
  ]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 print:hidden">
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
        <ReportHeaderActions hasRows={rows.length > 0} />
      </div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.supplierActivity.title')} />
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.supplierId ?? '__none__'} isLoading={isLoading} emptyTitle={t('shop.reports.supplierActivity.empty')} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// STOCK COUNT VARIANCE (item 16) -- a filterable summary/list ACROSS
// stock counts, reusing the existing shop_stock_counts/
// shop_stock_count_items schema exactly as-is (variance is already a
// GENERATED ALWAYS STORED column -- never recomputed here). NOT a
// rebuild of the dedicated Stock Count UX (ShopStockCountPage.tsx),
// which owns creating/running/completing a count session itself.
// ---------------------------------------------------------------------
interface VarianceRow { stockCountId: string; locationName: string; completedAt: string | null; productNameAr: string; variantLabel: string | null; systemQuantity: number; countedQuantity: number; variance: number; countedByName: string | null }
interface VarianceApiRow { stock_count_id: string; location_name: string; completed_at: string | null; product_name_ar: string; variant_label: string | null; system_quantity: number | string; counted_quantity: number | string; variance: number | string; counted_by_name: string | null }

function mapVariance(rows: VarianceApiRow[]): VarianceRow[] {
  return rows.map((r) => ({
    stockCountId: r.stock_count_id, locationName: r.location_name, completedAt: r.completed_at, productNameAr: r.product_name_ar, variantLabel: r.variant_label,
    systemQuantity: Number(r.system_quantity), countedQuantity: Number(r.counted_quantity), variance: Number(r.variance), countedByName: r.counted_by_name,
  }))
}

export function ReportShopStockCountVarianceContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { offset, setOffset, reset } = useOffsetPager()
  const [nonzeroOnly, setNonzeroOnly] = useState(true)

  const args = { p_club_id: currentClubId as string, p_start_date: startDate || undefined, p_end_date: endDate || undefined, p_nonzero_only: nonzeroOnly }
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['shop-report-stock-count-variance', currentClubId, startDate, endDate, nonzeroOnly, offset],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_shop_stock_count_variance', { ...args, p_limit: REPORT_PAGE_SIZE, p_offset: offset })
      if (error) throw error
      return mapVariance((data ?? []) as VarianceApiRow[])
    },
    enabled: !!currentClubId,
  })

  const [fullRows, setFullRows] = useState<VarianceRow[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const fullPrint = useMutation({
    mutationFn: () => fetchFullReport<VarianceApiRow>('list_shop_stock_count_variance', args),
    onSuccess: (result) => { setFullRows(mapVariance(result.rows)); setTruncated(result.truncated); requestAnimationFrame(() => requestAnimationFrame(() => window.print())) },
  })
  const printed = fullRows ?? rows

  const columns: DataTableColumn<VarianceRow>[] = [
    { key: 'date', header: t('shop.reports.stockCountVariance.completedAt'), render: (r) => r.completedAt ? <FormattedDate value={r.completedAt} timeZone="Africa/Cairo" options={{ year: 'numeric', month: 'short', day: 'numeric' }} /> : '—' },
    { key: 'location', header: t('shop.inventory.columns.location'), render: (r) => r.locationName },
    { key: 'product', header: t('reports.shop.columns.product'), render: (r) => r.productNameAr + (r.variantLabel ? ` (${r.variantLabel})` : '') },
    { key: 'system', header: t('shop.reports.stockCountVariance.systemQty'), render: (r) => r.systemQuantity },
    { key: 'counted', header: t('shop.reports.stockCountVariance.countedQty'), render: (r) => r.countedQuantity },
    { key: 'variance', header: t('shop.reports.stockCountVariance.variance'), render: (r) => <span className={r.variance !== 0 ? (r.variance > 0 ? 'text-status-success' : 'text-status-danger') : ''}>{r.variance > 0 ? `+${r.variance}` : r.variance}</span> },
    { key: 'countedBy', header: t('shop.reports.returns.processedBy'), render: (r) => r.countedByName ?? '—' },
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
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" checked={nonzeroOnly} onChange={(e) => { setNonzeroOnly(e.target.checked); reset() }} />
            {t('shop.reports.stockCountVariance.nonzeroOnly')}
          </label>
        </div>
        <ReportHeaderActions hasRows={rows.length > 0} onPrintFull={() => { setFullRows(null); fullPrint.mutate() }} printFullPending={fullPrint.isPending} />
      </div>
      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.stockCountVariance.title')} />
        <FullPrintNote fullCount={fullRows?.length ?? null} truncated={truncated} screenLimit={REPORT_PAGE_SIZE} />
        <DataTable columns={columns} rows={printed} rowKey={(r) => `${r.stockCountId}-${r.productNameAr}-${r.variantLabel ?? ''}`} isLoading={isLoading} emptyTitle={t('shop.reports.stockCountVariance.empty')} />
        {fullRows === null && <PagerControls offset={offset} pageSize={REPORT_PAGE_SIZE} rowCount={rows.length} onPrev={() => setOffset(Math.max(0, offset - REPORT_PAGE_SIZE))} onNext={() => setOffset(offset + REPORT_PAGE_SIZE)} />}
      </div>
    </div>
  )
}
