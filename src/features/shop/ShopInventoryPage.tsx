import { useEffect, useState } from 'react'
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
import { fetchFullReport } from '@/lib/fetchFullReport'
import { Printer } from 'lucide-react'

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

export function ShopInventoryPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [lowStockOnly, setLowStockOnly] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [managingSuppliers, setManagingSuppliers] = useState(false)

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
              <Button variant="outline" onClick={() => setManagingSuppliers(true)}>{t('shop.suppliers.manageTitle')}</Button>
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

function ReceiveStockDialog({ clubId, onClose, onDone }: { clubId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [locationId, setLocationId] = useState('')
  const [productId, setProductId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: locations = [] } = useQuery({ queryKey: ['shop-inv-locations', clubId], queryFn: () => fetchLocations(clubId) })

  const mutation = useMutation({
    mutationFn: async () => {
      // SHOP MODULE UX HARDENING (2026-08-28): receive_shop_stock
      // already accepted p_supplier_id -- this call was the only piece
      // missing to make "supplier association with receiving stock"
      // (directive Section 4) actually reachable.
      const { error: err } = await supabase.rpc('receive_shop_stock', {
        p_location_id: locationId, p_product_id: productId, p_variant_id: variantId || undefined,
        p_quantity: Number(quantity), p_unit_cost: unitCost ? Number(unitCost) : undefined,
        p_supplier_id: supplierId || undefined, p_notes: notes || undefined,
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
            <label className="text-sm font-medium text-text-secondary">{t('shop.suppliers.pickerLabel')}</label>
            <SupplierPicker clubId={clubId} value={supplierId} onChange={setSupplierId} />
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
