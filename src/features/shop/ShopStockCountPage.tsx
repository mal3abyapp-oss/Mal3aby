import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatDateIsolated, type SupportedLocale } from '@/lib/i18n/config'
import { FormattedDate } from '@/components/ui/formatted-date'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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
import { Search } from 'lucide-react'

// COMMERCIAL MODULE / STOCK COUNT (2026-08-27) -- physical inventory
// count sessions: Select Location -> Start -> record counted quantities
// against the system snapshot -> Complete (posts stock_count_adjustment
// movements through the canonical inventory engine, never a direct
// balance overwrite). Statuses: draft/in_progress/completed/cancelled.
//
// COMMERCE PRO C8 UX POLISH (2026-08-28, plan Section 5 Phase C8, item
// "Stock Count UX polish", plan Section 24): explicit instruction NOT to
// rebuild the canonical backend -- this pass touches ONLY this file.
// start_shop_stock_count/record_shop_stock_count_line/
// complete_shop_stock_count/cancel_shop_stock_count and
// list_shop_stock_counts/get_shop_stock_count_detail are all left
// completely untouched (confirmed correct/already validated per this
// engagement's earlier Shop Production Acceptance session). Added:
// search + category filter within an open count session (category is
// cross-referenced client-side from list_shop_products's own
// category_id/category_name_ar, since get_shop_stock_count_detail's row
// shape has no category column and does not need one added just for
// this), a completion summary (lines counted/matched/shortage/surplus/
// net quantity difference/value difference), and clearer status/
// progress indicators. Value difference reuses the exact same
// "last purchase_receipt cost, club-wide" method C7 established for
// Stock Valuation/Gross Profit (get_shop_stock_valuation) -- for
// consistency, and because the plan explicitly requires this: a line
// with no known cost renders "Cost unavailable", never fabricated as 0.

interface StockCountRow {
  id: string
  locationId: string
  locationName: string
  status: string
  startedAt: string | null
  completedAt: string | null
  itemCount: number
  varianceItemCount: number
  notes: string | null
}

interface LocationOption { locationId: string; name: string }
interface ProductOption {
  productId: string; nameAr: string; hasVariants: boolean
  categoryId: string | null; categoryName: string | null
}
interface VariantOption { variantId: string; size: string | null; color: string | null }
interface CategoryOption { categoryId: string; nameAr: string }

interface DetailLine {
  itemId: string
  productId: string
  productName: string
  variantId: string | null
  variantLabel: string | null
  systemQuantity: number
  countedQuantity: number | null
  variance: number | null
}

interface DetailData {
  id: string
  locationName: string
  status: string
  startedAt: string | null
  completedAt: string | null
  startedByName: string | null
  completedByName: string | null
  lines: DetailLine[]
}

async function fetchStockCounts(clubId: string): Promise<StockCountRow[]> {
  const { data, error } = await supabase.rpc('list_shop_stock_counts', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id, locationId: r.location_id, locationName: r.location_name, status: r.status,
    startedAt: r.started_at, completedAt: r.completed_at,
    itemCount: Number(r.item_count), varianceItemCount: Number(r.variance_item_count), notes: r.notes,
  }))
}

async function fetchDetail(stockCountId: string): Promise<DetailData> {
  const { data, error } = await supabase.rpc('get_shop_stock_count_detail', { p_stock_count_id: stockCountId })
  if (error) throw error
  const rows = data ?? []
  const first = rows[0]

  // Resolve started_by/completed_by (raw auth.users ids) to display names for
  // the print header (Section 8: "Started by / Completed by" is mandatory on
  // the printed document) -- same profiles lookup pattern BillingPage.tsx
  // already uses for payment.received_by.
  const actorIds = [first?.started_by, first?.completed_by].filter((id): id is string => !!id)
  const namesById = new Map<string, string>()
  if (actorIds.length > 0) {
    const { data: profiles } = await supabase.from('profiles').select('user_id, full_name').in('user_id', actorIds)
    for (const p of profiles ?? []) if (p.full_name) namesById.set(p.user_id, p.full_name)
  }

  return {
    id: stockCountId,
    locationName: first?.location_name ?? '',
    status: first?.status ?? 'draft',
    startedAt: first?.started_at ?? null,
    completedAt: first?.completed_at ?? null,
    startedByName: first?.started_by ? (namesById.get(first.started_by) ?? null) : null,
    completedByName: first?.completed_by ? (namesById.get(first.completed_by) ?? null) : null,
    lines: rows
      .filter((r) => r.item_id)
      .map((r) => ({
        itemId: r.item_id, productId: r.product_id, productName: r.product_name,
        variantId: r.variant_id, variantLabel: r.variant_label,
        systemQuantity: Number(r.system_quantity),
        countedQuantity: r.counted_quantity === null ? null : Number(r.counted_quantity),
        variance: r.variance === null ? null : Number(r.variance),
      })),
  }
}

async function fetchLocations(clubId: string): Promise<LocationOption[]> {
  const { data, error } = await supabase.rpc('list_shop_inventory_locations', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({ locationId: r.location_id, name: r.name }))
}

// PERF-05 (production audit remediation, 2026-09-03): list_shop_products
// now defaults to 50 rows (p_limit/p_offset, see that RPC's own
// migration comment). This call site is a product PICKER used to
// cross-reference every active product's category while counting stock
// -- it must not silently miss products past #50, so it passes an
// explicit, generous, still-bounded limit instead of inheriting the new
// display-page-size default. Same reasoning as ShopInventoryPage.tsx's
// PRODUCT_PICKER_LIMIT.
const PRODUCT_PICKER_LIMIT = 1000

async function fetchProducts(clubId: string): Promise<ProductOption[]> {
  const { data, error } = await supabase.rpc('list_shop_products', { p_club_id: clubId, p_status: 'active', p_limit: PRODUCT_PICKER_LIMIT })
  if (error) throw error
  return (data ?? []).map((r) => ({
    productId: r.product_id, nameAr: r.name_ar, hasVariants: r.has_variants,
    categoryId: r.category_id, categoryName: r.category_name_ar,
  }))
}

async function fetchVariants(productId: string): Promise<VariantOption[]> {
  const { data, error } = await supabase.rpc('list_shop_product_variants', { p_product_id: productId })
  if (error) throw error
  return (data ?? []).map((r) => ({ variantId: r.variant_id, size: r.size, color: r.color }))
}

async function fetchCategories(clubId: string): Promise<CategoryOption[]> {
  const { data, error } = await supabase.rpc('list_shop_categories', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({ categoryId: r.category_id, nameAr: r.name_ar }))
}

// Value-difference cost source: SAME "last purchase_receipt cost,
// club-wide" method C7 established for Stock Valuation/Gross Profit
// (get_shop_stock_valuation) -- reused here for consistency, per the
// task's own instruction. Gated on shop.reports.view_profit (the RPC
// itself enforces this, matching the established pattern); a role
// without the grant simply gets isError=true here and the completion
// summary shows "Cost unavailable" for every line, never a fabricated
// figure. Keyed by product_id + variant_id (empty string for a
// variant-less product/line) so a lookup miss is unambiguous.
async function fetchCostLookup(clubId: string): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc('get_shop_stock_valuation', { p_club_id: clubId })
  if (error) throw error
  const byKey = new Map<string, number>()
  for (const r of data ?? []) {
    if (r.unit_cost === null) continue
    const key = `${r.product_id}::${r.variant_id ?? ''}`
    // Multiple locations can report the same product/variant's unit_cost
    // (it's the same "last purchase receipt, club-wide" value repeated
    // per location row in get_shop_stock_valuation's own output) -- keep
    // the first, they're identical by construction.
    if (!byKey.has(key)) byKey.set(key, Number(r.unit_cost))
  }
  return byKey
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const variant = status === 'completed' ? 'default' : status === 'cancelled' ? 'secondary' : status === 'in_progress' ? 'outline' : 'outline'
  return <Badge variant={variant} data-testid="stock-count-status" data-status={status}>{t(`shop.stockCount.status.${status}`, { defaultValue: status })}</Badge>
}

export function ShopStockCountPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [startOpen, setStartOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  // Finding H-2 (frozen production audit): this list previously
  // destructured only `data = [], isLoading` -- a failed fetch silently
  // rendered as "no stock counts" via DataTable's own empty state,
  // indistinguishable from a club that genuinely has none. isError/
  // error/refetch are now surfaced.
  const { data: counts = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['shop-stock-counts', currentClubId],
    queryFn: () => fetchStockCounts(currentClubId as string),
    enabled: !!currentClubId,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['shop-stock-counts'] })
    void queryClient.invalidateQueries({ queryKey: ['shop-inventory-balances'] })
    void queryClient.invalidateQueries({ queryKey: ['shop-inventory-movements'] })
  }

  const columns: DataTableColumn<StockCountRow>[] = [
    { key: 'location', header: t('shop.stockCount.columns.location'), render: (c) => c.locationName },
    { key: 'status', header: t('shop.stockCount.columns.status'), render: (c) => <StatusBadge status={c.status} /> },
    { key: 'items', header: t('shop.stockCount.columns.items'), render: (c) => c.itemCount },
    {
      key: 'variances',
      header: t('shop.stockCount.columns.variances'),
      render: (c) => (c.varianceItemCount > 0 ? <span className="font-semibold text-status-warning">{c.varianceItemCount}</span> : c.varianceItemCount),
    },
    { key: 'started', header: t('shop.stockCount.columns.started'), render: (c) => (c.startedAt ? <FormattedDate value={c.startedAt} timeZone="Africa/Cairo" options={{ year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }} /> : '—') },
    {
      key: 'actions',
      header: '',
      render: (c) => (
        <Button size="sm" variant="outline" data-testid={`stock-count-open-${c.id}`} onClick={() => setDetailId(c.id)}>
          {c.status === 'in_progress' ? t('shop.stockCount.continue') : t('shop.stockCount.view')}
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title={t('shop.stockCount.title')}
        description={t('shop.stockCount.description')}
        actions={<Button data-testid="stock-count-start-new" onClick={() => setStartOpen(true)}>{t('shop.stockCount.startNew')}</Button>}
      />

      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('shop.stockCount.loadError'))} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={counts}
          rowKey={(c) => c.id}
          isLoading={isLoading}
          emptyTitle={t('shop.stockCount.emptyTitle')}
        />
      )}

      {startOpen && (
        <StartStockCountDialog
          clubId={currentClubId as string}
          onClose={() => setStartOpen(false)}
          onDone={(newId) => { setStartOpen(false); invalidate(); setDetailId(newId) }}
        />
      )}
      {detailId && (
        <StockCountDetailDialog
          clubId={currentClubId as string}
          stockCountId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={invalidate}
        />
      )}
    </div>
  )
}

function StartStockCountDialog({ clubId, onClose, onDone }: { clubId: string; onClose: () => void; onDone: (id: string) => void }) {
  const { t } = useTranslation()
  const [locationId, setLocationId] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: locations = [] } = useQuery({ queryKey: ['shop-inv-locations', clubId], queryFn: () => fetchLocations(clubId) })

  const mutation = useMutation({
    mutationFn: async () => {
      const idempotencyKey = crypto.randomUUID()
      const { data, error: err } = await supabase.rpc('start_shop_stock_count', {
        p_club_id: clubId, p_location_id: locationId, p_notes: notes || undefined, p_idempotency_key: idempotencyKey,
      })
      if (err) throw err
      return data as string
    },
    onSuccess: (id) => onDone(id),
    onError: (err) => setError(translateSupabaseError(err, t('shop.stockCount.startError'))),
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('shop.stockCount.startNew')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.stockCount.locationLabel')}</label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger data-testid="stock-count-location"><SelectValue placeholder={t('shop.inventory.locationPlaceholder')} /></SelectTrigger>
              <SelectContent>{locations.map((l) => <SelectItem key={l.locationId} value={l.locationId} data-testid={`stock-count-location-${l.locationId}`}>{l.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.stockCount.notesLabel')}</label>
            <Input data-testid="stock-count-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button data-testid="stock-count-start-confirm" disabled={!locationId || mutation.isPending} onClick={() => { setError(null); mutation.mutate() }}>
              {mutation.isPending ? t('shop.stockCount.starting') : t('shop.stockCount.startNew')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const ALL_CATEGORIES = '__all_categories__'

function StockCountDetailDialog({ clubId, stockCountId, onClose, onChanged }: {
  clubId: string; stockCountId: string; onClose: () => void; onChanged: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const queryClient = useQueryClient()
  const [addProductId, setAddProductId] = useState('')
  const [addVariantId, setAddVariantId] = useState('')
  const [countedDrafts, setCountedDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  // UX polish: search + category filter WITHIN this open session's own
  // line list -- client-side only, never a new RPC param, since
  // get_shop_stock_count_detail already returns every line for one
  // session in a single call (a real count session is bounded to one
  // location's product set, not a paginated report-scale dataset).
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORIES)

  const { data: detail, isLoading } = useQuery({
    queryKey: ['shop-stock-count-detail', stockCountId],
    queryFn: () => fetchDetail(stockCountId),
  })
  const { data: products = [] } = useQuery({ queryKey: ['shop-inv-products', clubId], queryFn: () => fetchProducts(clubId) })
  const { data: categories = [] } = useQuery({ queryKey: ['shop-categories', clubId], queryFn: () => fetchCategories(clubId), enabled: !!clubId })
  // Cost lookup only needed once a count is completed (the summary's
  // value-difference figure) -- not fetched for an in-progress session,
  // where it would be wasted work.
  const { data: costByKey, isError: costDenied } = useQuery({
    queryKey: ['shop-stock-count-cost-lookup', clubId],
    queryFn: () => fetchCostLookup(clubId),
    enabled: !!clubId && detail?.status === 'completed',
    retry: false,
  })
  const selectedAddProduct = products.find((p) => p.productId === addProductId)
  const { data: addVariants = [] } = useQuery({
    queryKey: ['shop-inv-variants', addProductId],
    queryFn: () => fetchVariants(addProductId),
    enabled: !!selectedAddProduct?.hasVariants,
  })

  const productById = useMemo(() => new Map(products.map((p) => [p.productId, p])), [products])

  const visibleLines = useMemo(() => {
    if (!detail) return []
    const q = search.trim().toLowerCase()
    return detail.lines.filter((line) => {
      if (categoryFilter !== ALL_CATEGORIES) {
        const cat = productById.get(line.productId)?.categoryId ?? null
        if (cat !== categoryFilter) return false
      }
      if (q) {
        const haystack = `${line.productName} ${line.variantLabel ?? ''}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [detail, search, categoryFilter, productById])

  function refetchDetail() {
    void queryClient.invalidateQueries({ queryKey: ['shop-stock-count-detail', stockCountId] })
    onChanged()
  }

  const recordLineMutation = useMutation({
    mutationFn: async ({ productId, variantId, counted }: { productId: string; variantId: string | null; counted: number }) => {
      const { error: err } = await supabase.rpc('record_shop_stock_count_line', {
        p_stock_count_id: stockCountId, p_product_id: productId, p_variant_id: variantId ?? undefined, p_counted_quantity: counted,
      })
      if (err) throw err
    },
    onSuccess: refetchDetail,
    onError: (err) => setError(translateSupabaseError(err, t('shop.stockCount.recordError'))),
  })

  const completeMutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('complete_shop_stock_count', { p_stock_count_id: stockCountId })
      if (err) throw err
    },
    onSuccess: () => { refetchDetail() },
    onError: (err) => setError(translateSupabaseError(err, t('shop.stockCount.completeError'))),
  })

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('cancel_shop_stock_count', { p_stock_count_id: stockCountId })
      if (err) throw err
    },
    onSuccess: () => { refetchDetail(); onClose() },
    onError: (err) => setError(translateSupabaseError(err, t('shop.stockCount.cancelError'))),
  })

  const isInProgress = detail?.status === 'in_progress'
  const allCounted = !!detail && detail.lines.length > 0 && detail.lines.every((l) => l.countedQuantity !== null)
  const countedLineCount = detail?.lines.filter((l) => l.countedQuantity !== null).length ?? 0
  const totalLineCount = detail?.lines.length ?? 0
  const progressPct = totalLineCount > 0 ? Math.round((countedLineCount / totalLineCount) * 100) : 0

  // Completion summary figures (plan's own instruction: "lines counted,
  // matched, shortages, surpluses, net quantity difference, value
  // difference"). Net quantity difference sums every line's variance
  // (positive = net surplus, negative = net net shortage, never
  // clamped). Value difference multiplies each line's variance by its
  // known unit cost, SKIPPING (not zeroing) any line with no known cost
  // -- costUnavailableLineCount discloses exactly how many lines were
  // excluded, matching Gross Profit's own honesty-notice pattern.
  const summary = useMemo(() => {
    if (!detail || detail.status !== 'completed') return null
    let netQuantityDiff = 0
    let valueDiff = 0
    let costUnavailableLineCount = 0
    for (const line of detail.lines) {
      if (line.variance === null) continue
      netQuantityDiff += line.variance
      if (line.variance === 0) continue
      const key = `${line.productId}::${line.variantId ?? ''}`
      const unitCost = costByKey?.get(key)
      if (unitCost === undefined) { costUnavailableLineCount += 1; continue }
      valueDiff += line.variance * unitCost
    }
    return { netQuantityDiff, valueDiff, costUnavailableLineCount }
  }, [detail, costByKey])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {detail ? `${t('shop.stockCount.title')} — ${detail.locationName}` : t('shop.stockCount.title')}
            {detail && <span className="ms-2"><StatusBadge status={detail.status} /></span>}
          </DialogTitle>
        </DialogHeader>

        {isLoading && <p className="text-sm text-text-secondary">{t('common.loading')}</p>}

        {detail && (
          <div className="flex flex-col gap-4">
            {detail.status === 'completed' && (
              <div className="flex justify-end print:hidden">
                <ReportPrintButton />
              </div>
            )}
            {isInProgress && (
              <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
                <div className="flex flex-1 flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">{t('shop.stockCount.addProductLabel')}</label>
                  <Select value={addProductId} onValueChange={(v) => { setAddProductId(v); setAddVariantId('') }}>
                    <SelectTrigger data-testid="stock-count-add-product"><SelectValue placeholder={t('shop.inventory.productPlaceholder')} /></SelectTrigger>
                    <SelectContent>{products.map((p) => <SelectItem key={p.productId} value={p.productId} data-testid={`stock-count-add-product-${p.productId}`}>{p.nameAr}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                {selectedAddProduct?.hasVariants && (
                  <div className="flex flex-1 flex-col gap-1.5">
                    <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.variantLabel')}</label>
                    <Select value={addVariantId} onValueChange={setAddVariantId}>
                      <SelectTrigger data-testid="stock-count-add-variant"><SelectValue placeholder={t('shop.inventory.variantPlaceholder')} /></SelectTrigger>
                      <SelectContent>{addVariants.map((v) => <SelectItem key={v.variantId} value={v.variantId} data-testid={`stock-count-add-variant-${v.variantId}`}>{[v.size, v.color].filter(Boolean).join(' / ')}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                )}
                <Button
                  size="sm"
                  data-testid="stock-count-add-line"
                  disabled={!addProductId || (selectedAddProduct?.hasVariants && !addVariantId)}
                  onClick={() => {
                    setError(null)
                    recordLineMutation.mutate({ productId: addProductId, variantId: addVariantId || null, counted: 0 })
                    setAddProductId('')
                    setAddVariantId('')
                  }}
                >
                  {t('shop.stockCount.addLine')}
                </Button>
              </div>
            )}

            {/* Progress indicator -- clearer status/progress requirement.
                Shown for in-progress AND completed sessions (a completed
                session is, by definition, 100%; still useful context
                alongside the status badge). */}
            {totalLineCount > 0 && (
              <div className="flex items-center gap-3 print:hidden">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${progressPct === 100 ? 'bg-status-success' : 'bg-accent-foreground'}`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <span className="shrink-0 text-xs font-medium text-text-secondary" data-testid="stock-count-progress">
                  {t('shop.stockCount.progress', { counted: countedLineCount, total: totalLineCount, pct: progressPct })}
                </span>
              </div>
            )}

            {/* Search + category filter within this session's own lines. */}
            {totalLineCount > 0 && (
              <div className="flex flex-wrap gap-2 print:hidden">
                <div className="relative flex-1 min-w-40">
                  <Search className="pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
                  <Input
                    className="ps-8"
                    placeholder={t('shop.stockCount.searchPlaceholder')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    data-testid="stock-count-search"
                  />
                </div>
                <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                  <SelectTrigger className="w-44" data-testid="stock-count-category-filter"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_CATEGORIES}>{t('shop.stockCount.allCategories')}</SelectItem>
                    {categories.map((c) => <SelectItem key={c.categoryId} value={c.categoryId}>{c.nameAr}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className={detail.status === 'completed' ? 'print-target visible-for-print' : ''}>
              {detail.status === 'completed' && (
                <ReportPrintHeader
                  reportName={`${t('shop.stockCount.title')} — ${detail.locationName}`}
                  filterSummary={[
                    detail.startedAt ? `${t('shop.stockCount.printStartedAt')}: ${formatDateIsolated(detail.startedAt, locale as SupportedLocale, 'Africa/Cairo', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : null,
                    detail.completedAt ? `${t('shop.stockCount.printCompletedAt')}: ${formatDateIsolated(detail.completedAt, locale as SupportedLocale, 'Africa/Cairo', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : null,
                    detail.startedByName ? `${t('shop.stockCount.printStartedBy')}: ${detail.startedByName}` : null,
                    detail.completedByName ? `${t('shop.stockCount.printCompletedBy')}: ${detail.completedByName}` : null,
                  ].filter(Boolean).join(' — ')}
                />
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm">
                  <thead>
                    <tr className="border-b border-border text-text-secondary">
                      <th className="p-2 text-start font-medium">{t('shop.stockCount.lineColumns.product')}</th>
                      <th className="p-2 text-start font-medium">{t('shop.stockCount.lineColumns.system')}</th>
                      <th className="p-2 text-start font-medium">{t('shop.stockCount.lineColumns.counted')}</th>
                      <th className="p-2 text-start font-medium">{t('shop.stockCount.lineColumns.variance')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleLines.map((line) => {
                      const draftValue = countedDrafts[line.itemId] ?? (line.countedQuantity !== null ? String(line.countedQuantity) : '')
                      // Clear +/-/0 highlighting (plan's own instruction):
                      // a whole-row tint, not just the variance cell, so
                      // shortage/surplus/matched lines are scannable at a
                      // glance in a long list.
                      const rowTone = line.variance === null
                        ? ''
                        : line.variance < 0
                          ? 'bg-status-danger/5'
                          : line.variance > 0
                            ? 'bg-status-success/5'
                            : ''
                      return (
                        <tr key={line.itemId} className={`border-b border-border last:border-0 ${rowTone}`}>
                          <td className="p-2">{line.productName}{line.variantLabel ? ` (${line.variantLabel})` : ''}</td>
                          <td className="p-2">{line.systemQuantity}</td>
                          <td className="p-2">
                            {isInProgress ? (
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                className="w-24"
                                data-testid={`stock-count-line-counted-${line.itemId}`}
                                value={draftValue}
                                onChange={(e) => setCountedDrafts((d) => ({ ...d, [line.itemId]: e.target.value }))}
                                onBlur={() => {
                                  const raw = countedDrafts[line.itemId]
                                  if (raw === undefined || raw === '') return
                                  const parsed = Number(raw)
                                  if (Number.isNaN(parsed) || parsed === line.countedQuantity) return
                                  recordLineMutation.mutate({ productId: line.productId, variantId: line.variantId, counted: parsed })
                                }}
                              />
                            ) : (
                              line.countedQuantity ?? '—'
                            )}
                          </td>
                          <td className="p-2">
                            {line.variance === null ? (
                              '—'
                            ) : (
                              <span className={
                                line.variance < 0 ? 'font-semibold text-status-danger'
                                  : line.variance > 0 ? 'font-semibold text-status-success'
                                    : 'text-text-secondary'
                              }>
                                {line.variance > 0 ? `+${line.variance}` : line.variance === 0 ? '0' : line.variance}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                    {visibleLines.length === 0 && (
                      <tr><td colSpan={4} className="p-4 text-center text-text-secondary">{detail.lines.length === 0 ? t('shop.stockCount.noLines') : t('shop.stockCount.noMatchingLines')}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {detail.status === 'completed' && summary && (
                <div className="mt-4">
                  <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                    <div className="rounded-md border border-border p-2 text-center">
                      <p className="text-text-secondary">{t('shop.stockCount.summary.counted')}</p>
                      <p className="text-lg font-semibold">{detail.lines.length}</p>
                    </div>
                    <div className="rounded-md border border-border p-2 text-center">
                      <p className="text-text-secondary">{t('shop.stockCount.summary.matched')}</p>
                      <p className="text-lg font-semibold">{detail.lines.filter((l) => l.variance === 0).length}</p>
                    </div>
                    <div className="rounded-md border border-border p-2 text-center">
                      <p className="text-text-secondary">{t('shop.stockCount.summary.shortage')}</p>
                      <p className="text-lg font-semibold text-status-danger">{detail.lines.filter((l) => (l.variance ?? 0) < 0).length}</p>
                    </div>
                    <div className="rounded-md border border-border p-2 text-center">
                      <p className="text-text-secondary">{t('shop.stockCount.summary.surplus')}</p>
                      <p className="text-lg font-semibold text-status-success">{detail.lines.filter((l) => (l.variance ?? 0) > 0).length}</p>
                    </div>
                    <div className="rounded-md border border-border p-2 text-center">
                      <p className="text-text-secondary">{t('shop.stockCount.summary.netQuantity')}</p>
                      <p className={`text-lg font-semibold ${summary.netQuantityDiff < 0 ? 'text-status-danger' : summary.netQuantityDiff > 0 ? 'text-status-success' : ''}`}>
                        {summary.netQuantityDiff > 0 ? `+${summary.netQuantityDiff}` : summary.netQuantityDiff}
                      </p>
                    </div>
                  </div>

                  {/* Value difference -- honesty requirement (plan's own
                      instruction): never fabricated. Three states:
                      permission-denied (RPC itself gates this, same as
                      Stock Valuation/Gross Profit), some lines lacking a
                      known cost (partial figure + explicit count of what
                      was excluded), or a full, real figure. */}
                  <div className="mt-3 rounded-md border border-border p-3 text-sm">
                    {costDenied ? (
                      <p className="text-text-secondary">{t('shop.stockCount.summary.valueHidden')}</p>
                    ) : (
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{t('shop.stockCount.summary.valueDifference')}</span>
                        <MoneyDisplay amount={summary.valueDiff} size="md" tone={summary.valueDiff < 0 ? 'danger' : summary.valueDiff > 0 ? 'success' : 'default'} />
                      </div>
                    )}
                    {!costDenied && summary.costUnavailableLineCount > 0 && (
                      <p className="mt-1 text-xs text-status-warning">
                        {t('shop.stockCount.summary.valueCostUnavailable', { count: summary.costUnavailableLineCount })}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
              {isInProgress && (
                <>
                  <Button variant="destructive" data-testid="stock-count-cancel" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>
                    {t('shop.stockCount.cancelCount')}
                  </Button>
                  <Button data-testid="stock-count-complete" disabled={!allCounted || completeMutation.isPending} onClick={() => completeMutation.mutate()}>
                    {completeMutation.isPending ? t('shop.stockCount.completing') : t('shop.stockCount.completeCount')}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
