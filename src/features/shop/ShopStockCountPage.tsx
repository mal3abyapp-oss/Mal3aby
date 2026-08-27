import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
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

// COMMERCIAL MODULE / STOCK COUNT (2026-08-27) -- physical inventory
// count sessions: Select Location -> Start -> record counted quantities
// against the system snapshot -> Complete (posts stock_count_adjustment
// movements through the canonical inventory engine, never a direct
// balance overwrite). Statuses: draft/in_progress/completed/cancelled.

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
interface ProductOption { productId: string; nameAr: string; hasVariants: boolean }
interface VariantOption { variantId: string; size: string | null; color: string | null }

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
  return {
    id: stockCountId,
    locationName: first?.location_name ?? '',
    status: first?.status ?? 'draft',
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

async function fetchProducts(clubId: string): Promise<ProductOption[]> {
  const { data, error } = await supabase.rpc('list_shop_products', { p_club_id: clubId, p_status: 'active' })
  if (error) throw error
  return (data ?? []).map((r) => ({ productId: r.product_id, nameAr: r.name_ar, hasVariants: r.has_variants }))
}

async function fetchVariants(productId: string): Promise<VariantOption[]> {
  const { data, error } = await supabase.rpc('list_shop_product_variants', { p_product_id: productId })
  if (error) throw error
  return (data ?? []).map((r) => ({ variantId: r.variant_id, size: r.size, color: r.color }))
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const variant = status === 'completed' ? 'default' : status === 'cancelled' ? 'secondary' : status === 'in_progress' ? 'outline' : 'outline'
  return <Badge variant={variant}>{t(`shop.stockCount.status.${status}`, { defaultValue: status })}</Badge>
}

export function ShopStockCountPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [startOpen, setStartOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const { data: counts = [], isLoading } = useQuery({
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
    { key: 'started', header: t('shop.stockCount.columns.started'), render: (c) => (c.startedAt ? new Date(c.startedAt).toLocaleString() : '—') },
    {
      key: 'actions',
      header: '',
      render: (c) => (
        <Button size="sm" variant="outline" onClick={() => setDetailId(c.id)}>
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
        actions={<Button onClick={() => setStartOpen(true)}>{t('shop.stockCount.startNew')}</Button>}
      />

      <DataTable
        columns={columns}
        rows={counts}
        rowKey={(c) => c.id}
        isLoading={isLoading}
        emptyTitle={t('shop.stockCount.emptyTitle')}
      />

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
              <SelectTrigger><SelectValue placeholder={t('shop.inventory.locationPlaceholder')} /></SelectTrigger>
              <SelectContent>{locations.map((l) => <SelectItem key={l.locationId} value={l.locationId}>{l.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.stockCount.notesLabel')}</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!locationId || mutation.isPending} onClick={() => { setError(null); mutation.mutate() }}>
              {mutation.isPending ? t('shop.stockCount.starting') : t('shop.stockCount.startNew')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StockCountDetailDialog({ clubId, stockCountId, onClose, onChanged }: {
  clubId: string; stockCountId: string; onClose: () => void; onChanged: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [addProductId, setAddProductId] = useState('')
  const [addVariantId, setAddVariantId] = useState('')
  const [countedDrafts, setCountedDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const { data: detail, isLoading } = useQuery({
    queryKey: ['shop-stock-count-detail', stockCountId],
    queryFn: () => fetchDetail(stockCountId),
  })
  const { data: products = [] } = useQuery({ queryKey: ['shop-inv-products', clubId], queryFn: () => fetchProducts(clubId) })
  const selectedAddProduct = products.find((p) => p.productId === addProductId)
  const { data: addVariants = [] } = useQuery({
    queryKey: ['shop-inv-variants', addProductId],
    queryFn: () => fetchVariants(addProductId),
    enabled: !!selectedAddProduct?.hasVariants,
  })

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
            {isInProgress && (
              <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
                <div className="flex flex-1 flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">{t('shop.stockCount.addProductLabel')}</label>
                  <Select value={addProductId} onValueChange={(v) => { setAddProductId(v); setAddVariantId('') }}>
                    <SelectTrigger><SelectValue placeholder={t('shop.inventory.productPlaceholder')} /></SelectTrigger>
                    <SelectContent>{products.map((p) => <SelectItem key={p.productId} value={p.productId}>{p.nameAr}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                {selectedAddProduct?.hasVariants && (
                  <div className="flex flex-1 flex-col gap-1.5">
                    <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.variantLabel')}</label>
                    <Select value={addVariantId} onValueChange={setAddVariantId}>
                      <SelectTrigger><SelectValue placeholder={t('shop.inventory.variantPlaceholder')} /></SelectTrigger>
                      <SelectContent>{addVariants.map((v) => <SelectItem key={v.variantId} value={v.variantId}>{[v.size, v.color].filter(Boolean).join(' / ')}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                )}
                <Button
                  size="sm"
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
                  {detail.lines.map((line) => {
                    const draftValue = countedDrafts[line.itemId] ?? (line.countedQuantity !== null ? String(line.countedQuantity) : '')
                    return (
                      <tr key={line.itemId} className="border-b border-border last:border-0">
                        <td className="p-2">{line.productName}{line.variantLabel ? ` (${line.variantLabel})` : ''}</td>
                        <td className="p-2">{line.systemQuantity}</td>
                        <td className="p-2">
                          {isInProgress ? (
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              className="w-24"
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
                            <span className={line.variance !== 0 ? 'font-semibold text-status-warning' : ''}>
                              {line.variance > 0 ? `+${line.variance}` : line.variance}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {detail.lines.length === 0 && (
                    <tr><td colSpan={4} className="p-4 text-center text-text-secondary">{t('shop.stockCount.noLines')}</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
              {isInProgress && (
                <>
                  <Button variant="destructive" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>
                    {t('shop.stockCount.cancelCount')}
                  </Button>
                  <Button disabled={!allCounted || completeMutation.isPending} onClick={() => completeMutation.mutate()}>
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
