import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
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
import { translateSupabaseError } from '@/lib/errors'
import { ReportPrintButton, ReportPrintHeader } from '@/components/ui/report-print-header'

// COMMERCIAL MODULE (2026-08-26) -- Inventory dashboard: balances,
// low-stock filter, receive/transfer/adjust actions, movement history
// (directive Section 59/103).
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
interface ProductOption { productId: string; nameAr: string; hasVariants: boolean }
interface VariantOption { variantId: string; size: string | null; color: string | null }
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

async function fetchBalances(clubId: string, lowStockOnly: boolean): Promise<BalanceRow[]> {
  const { data, error } = await supabase.rpc('get_shop_inventory_balances', { p_club_id: clubId, p_low_stock_only: lowStockOnly })
  if (error) throw error
  return (data ?? []).map((r) => ({
    locationId: r.location_id, locationName: r.location_name, productId: r.product_id, productNameAr: r.product_name_ar,
    variantId: r.variant_id, variantLabel: r.variant_label, onHand: Number(r.on_hand), reorderLevel: r.reorder_level,
  }))
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

async function fetchMovements(clubId: string): Promise<MovementRow[]> {
  const { data, error } = await supabase.rpc('list_shop_inventory_movements', { p_club_id: clubId, p_limit: 50 })
  if (error) throw error
  return (data ?? []).map((r) => ({
    movementId: r.movement_id, locationName: r.location_name, productNameAr: r.product_name_ar, variantLabel: r.variant_label,
    movementType: r.movement_type, quantity: Number(r.quantity), createdAt: r.created_at, reason: r.reason,
  }))
}

export function ShopInventoryPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [lowStockOnly, setLowStockOnly] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)

  const { data: balances = [], isLoading } = useQuery({
    queryKey: ['shop-inventory-balances', currentClubId, lowStockOnly],
    queryFn: () => fetchBalances(currentClubId as string, lowStockOnly),
    enabled: !!currentClubId,
  })
  const { data: movements = [] } = useQuery({
    queryKey: ['shop-inventory-movements', currentClubId],
    queryFn: () => fetchMovements(currentClubId as string),
    enabled: !!currentClubId,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['shop-inventory-balances'] })
    void queryClient.invalidateQueries({ queryKey: ['shop-inventory-movements'] })
  }

  const balanceColumns: DataTableColumn<BalanceRow>[] = [
    { key: 'product', header: t('shop.inventory.columns.product'), render: (b) => b.productNameAr + (b.variantLabel ? ` (${b.variantLabel})` : '') },
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
  ]

  const movementColumns: DataTableColumn<MovementRow>[] = [
    { key: 'date', header: t('shop.inventory.columns.date'), render: (m) => new Date(m.createdAt).toLocaleString() },
    { key: 'product', header: t('shop.inventory.columns.product'), render: (m) => m.productNameAr + (m.variantLabel ? ` (${m.variantLabel})` : '') },
    { key: 'location', header: t('shop.inventory.columns.location'), render: (m) => m.locationName },
    { key: 'type', header: t('shop.inventory.columns.movementType'), render: (m) => t(`shop.inventory.movementTypes.${m.movementType}`, { defaultValue: m.movementType }) },
    { key: 'quantity', header: t('shop.inventory.columns.quantity'), render: (m) => m.quantity },
    { key: 'reason', header: t('shop.inventory.columns.reason'), render: (m) => m.reason ?? '—' },
  ]

  return (
    <div>
      <div className="print:hidden">
        <PageHeader
          title={t('shop.inventory.title')}
          description={t('shop.inventory.description')}
          actions={
            <>
              <Button variant="outline" onClick={() => setReceiveOpen(true)}>{t('shop.inventory.receiveStock')}</Button>
              <Button variant="outline" onClick={() => setTransferOpen(true)}>{t('shop.inventory.transferStock')}</Button>
              <Button variant="outline" onClick={() => setAdjustOpen(true)}>{t('shop.inventory.adjustStock')}</Button>
            </>
          }
        />

        <div className="mb-4 flex items-center justify-between">
          <Button variant={lowStockOnly ? 'default' : 'outline'} size="sm" onClick={() => setLowStockOnly((v) => !v)}>
            {t('shop.inventory.lowStockOnly')}
          </Button>
          <ReportPrintButton />
        </div>
      </div>

      <div className="print-target visible-for-print">
        <ReportPrintHeader
          reportName={t('shop.inventory.title')}
          filterSummary={lowStockOnly ? t('shop.inventory.lowStockOnly') : undefined}
        />
        <DataTable columns={balanceColumns} rows={balances} rowKey={(b) => `${b.locationId}-${b.productId}-${b.variantId}`} isLoading={isLoading} emptyTitle={t('shop.inventory.emptyBalancesTitle')} />

        <h2 className="mb-2 mt-6 text-lg font-semibold">{t('shop.inventory.movementHistory')}</h2>
        {/* Section 12: an explicit operational maximum, not a silent truncation --
            list_shop_inventory_movements is called with p_limit: 50 above. */}
        <p className="mb-2 text-xs text-text-secondary">{t('shop.inventory.movementHistoryLimitNote', { count: 50 })}</p>
        <DataTable columns={movementColumns} rows={movements} rowKey={(m) => m.movementId} emptyTitle={t('shop.inventory.emptyMovementsTitle')} />
      </div>

      {receiveOpen && <ReceiveStockDialog clubId={currentClubId as string} onClose={() => setReceiveOpen(false)} onDone={() => { setReceiveOpen(false); invalidate() }} />}
      {transferOpen && <TransferStockDialog clubId={currentClubId as string} onClose={() => setTransferOpen(false)} onDone={() => { setTransferOpen(false); invalidate() }} />}
      {adjustOpen && <AdjustStockDialog clubId={currentClubId as string} onClose={() => setAdjustOpen(false)} onDone={() => { setAdjustOpen(false); invalidate() }} />}
    </div>
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

function ReceiveStockDialog({ clubId, onClose, onDone }: { clubId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [locationId, setLocationId] = useState('')
  const [productId, setProductId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: locations = [] } = useQuery({ queryKey: ['shop-inv-locations', clubId], queryFn: () => fetchLocations(clubId) })

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('receive_shop_stock', {
        p_location_id: locationId, p_product_id: productId, p_variant_id: variantId || undefined,
        p_quantity: Number(quantity), p_unit_cost: unitCost ? Number(unitCost) : undefined, p_notes: notes || undefined,
      })
      if (err) throw err
    },
    onSuccess: onDone,
    onError: (err) => setError(translateSupabaseError(err, t('shop.inventory.receiveError'))),
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('shop.inventory.receiveStock')}</DialogTitle></DialogHeader>
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
            <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.quantityLabel')}</label>
            <Input type="number" min="0.01" step="0.01" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.unitCostLabel')}</label>
            <Input type="number" min="0" step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.notesLabel')}</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!locationId || !productId || !quantity || mutation.isPending} onClick={() => { setError(null); mutation.mutate() }}>
              {mutation.isPending ? t('shop.inventory.receiving') : t('shop.inventory.receiveStock')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TransferStockDialog({ clubId, onClose, onDone }: { clubId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [sourceId, setSourceId] = useState('')
  const [destId, setDestId] = useState('')
  const [productId, setProductId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: locations = [] } = useQuery({ queryKey: ['shop-inv-locations', clubId], queryFn: () => fetchLocations(clubId) })

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('transfer_shop_stock', {
        p_source_location_id: sourceId, p_dest_location_id: destId, p_product_id: productId,
        p_variant_id: variantId || undefined, p_quantity: Number(quantity),
      })
      if (err) throw err
    },
    onSuccess: onDone,
    onError: (err) => setError(translateSupabaseError(err, t('shop.inventory.transferError'))),
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('shop.inventory.transferStock')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.sourceLocationLabel')}</label>
            <Select value={sourceId} onValueChange={setSourceId}>
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
          <ProductVariantPicker clubId={clubId} productId={productId} variantId={variantId} onProductChange={(v) => { setProductId(v); setVariantId('') }} onVariantChange={setVariantId} />
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.inventory.quantityLabel')}</label>
            <Input type="number" min="0.01" step="0.01" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!sourceId || !destId || !productId || !quantity || mutation.isPending} onClick={() => { setError(null); mutation.mutate() }}>
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
