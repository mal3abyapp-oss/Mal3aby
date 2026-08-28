import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
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
  DialogTrigger,
} from '@/components/ui/dialog'
import { translateSupabaseError } from '@/lib/errors'
import { ProductThumb } from '@/features/shop/shop-media'
import {
  LayoutGrid,
  List as ListIcon,
  Upload,
  X,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'

// COMMERCIAL MODULE (2026-08-26) -- Products & Categories management
// (directive Section 105/106). Variant creation kept intentionally
// simple (a dedicated inline add-row, not a matrix generator --
// directive Section 106's own "do not introduce a fragile matrix
// generation unless tested" instruction).
//
// COMMERCE PRO C1 (2026-08-28) -- Product Media + Category UX rebuild.
// See COMMERCE_PRO_UPGRADE_PLAN.md Section 5 (Phase C1). Adds:
// image upload/replace/remove for products (primary + gallery) and
// categories (single image/icon), a grid/list toggle for the product
// view, aggregate stock (best-effort -- see fetchStockByProduct's own
// comment on why it fails open to "unknown" rather than blocking the
// page), and draggable-free up/down display-order controls for
// categories. Cost/margin are deliberately NOT shown here: this
// schema only has unit_cost at the inventory-movement level (set on
// receive), never a stable per-product cost column or a cost-at-sale
// snapshot (that lands in a later phase per the plan) -- showing a
// margin here would mean fabricating a number from a moving average
// this page has no honest way to compute, so it is omitted rather than
// guessed.
//
// COMMERCE PRO C2 (2026-08-28) -- ProductThumb/ImagePlaceholder moved
// to shop-media.tsx (shared with ShopPOSPage.tsx's product cards and
// category strip, which need the exact same real-fallback/no-layout-
// jump pattern). No behavior change here -- same components, imported
// instead of defined locally.
const PRODUCT_IMAGES_BUCKET = 'shop-product-images'
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

interface ProductRow {
  productId: string
  nameAr: string
  nameEn: string | null
  categoryId: string | null
  categoryNameAr: string | null
  basePrice: number
  hasVariants: boolean
  sku: string | null
  barcode: string | null
  status: string
  imageUrl: string | null
  imageUrls: string[]
  reorderLevel: number | null
}

interface CategoryOption {
  categoryId: string
  nameAr: string
  imageUrl: string | null
  displayOrder: number
}

interface CategoryRow {
  categoryId: string
  nameAr: string
  nameEn: string | null
  status: string
  imageUrl: string | null
  displayOrder: number
}

interface VariantRow {
  variantId: string
  size: string | null
  color: string | null
  sku: string | null
  priceOverride: number | null
  status: string
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

async function fetchProducts(clubId: string, search: string, categoryId?: string): Promise<ProductRow[]> {
  const { data, error } = await supabase.rpc('list_shop_products', {
    p_club_id: clubId,
    p_search: search || undefined,
    p_category_id: categoryId || undefined,
    p_status: undefined,
  })
  if (error) throw error
  return (data ?? []).map((r) => ({
    productId: r.product_id, nameAr: r.name_ar, nameEn: r.name_en, categoryId: r.category_id, categoryNameAr: r.category_name_ar,
    basePrice: Number(r.base_price), hasVariants: r.has_variants, sku: r.sku, barcode: r.barcode, status: r.status,
    imageUrl: r.image_url, imageUrls: toStringArray(r.image_urls), reorderLevel: r.reorder_level,
  }))
}

async function fetchCategories(clubId: string): Promise<CategoryOption[]> {
  const { data, error } = await supabase.rpc('list_shop_categories', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({ categoryId: r.category_id, nameAr: r.name_ar, imageUrl: r.image_url, displayOrder: r.display_order }))
}

// SHOP MODULE UX HARDENING (2026-08-28): real production acceptance
// pass found create_shop_category already existed at the RPC layer
// with zero UI call sites -- a merchant could never create their
// first category ("مشروبات") through the product anywhere. Fixed via
// this shared inline creator (used by both Add/Edit product dialogs'
// category picker) and a dedicated Manage Categories dialog (rename +
// archive/reactivate, using the new update_shop_category RPC added in
// the same fix).
async function fetchCategoriesAll(clubId: string): Promise<CategoryRow[]> {
  const { data, error } = await supabase.rpc('list_shop_categories_all', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({
    categoryId: r.category_id, nameAr: r.name_ar, nameEn: r.name_en, status: r.status,
    imageUrl: r.image_url, displayOrder: r.display_order,
  }))
}

// Best-effort aggregate on-hand stock per product, across every
// location and variant. Requires inventory.view -- a role that has
// shop.view/shop.product.manage but NOT inventory.view (a real,
// intentional combination per the permission seed's own role matrix,
// e.g. a hypothetical custom role) will get a not-authorized error
// here. That failure must never block the product grid itself from
// rendering -- stock is a nice-to-have enrichment on this page, not
// its core purpose -- so callers render "—" for stock instead of
// surfacing this as a page-level error.
async function fetchStockByProduct(clubId: string): Promise<Record<string, number> | null> {
  const { data, error } = await supabase.rpc('get_shop_inventory_balances', { p_club_id: clubId })
  if (error) return null
  const totals: Record<string, number> = {}
  for (const row of data ?? []) {
    totals[row.product_id] = (totals[row.product_id] ?? 0) + Number(row.on_hand)
  }
  return totals
}

const NEW_CATEGORY_VALUE = '__new_category__'

function CategoryPicker({
  clubId,
  value,
  onChange,
}: {
  clubId: string
  value: string
  onChange: (categoryId: string) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [newNameAr, setNewNameAr] = useState('')
  const [newNameEn, setNewNameEn] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: categories = [] } = useQuery({ queryKey: ['shop-categories', clubId], queryFn: () => fetchCategories(clubId), enabled: !!clubId })

  const createMutation = useMutation({
    mutationFn: async () => {
      const { data, error: err } = await supabase.rpc('create_shop_category', {
        p_club_id: clubId,
        p_name_ar: newNameAr,
        p_name_en: newNameEn || undefined,
      })
      if (err) throw err
      return data as string
    },
    onSuccess: (newCategoryId) => {
      void queryClient.invalidateQueries({ queryKey: ['shop-categories', clubId] })
      void queryClient.invalidateQueries({ queryKey: ['shop-categories-all', clubId] })
      onChange(newCategoryId)
      setCreating(false)
      setNewNameAr('')
      setNewNameEn('')
    },
    onError: (err) => setError(translateSupabaseError(err, t('shop.categories.createError'))),
  })

  if (creating) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <Input autoFocus placeholder={t('shop.categories.nameArLabel')} value={newNameAr} onChange={(e) => setNewNameAr(e.target.value)} />
        <Input dir="ltr" placeholder={t('shop.categories.nameEnLabel')} value={newNameEn} onChange={(e) => setNewNameEn(e.target.value)} />
        {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
        <div className="flex gap-2">
          <Button type="button" size="sm" disabled={!newNameAr || createMutation.isPending} onClick={() => { setError(null); createMutation.mutate() }}>
            {createMutation.isPending ? t('shop.categories.creating') : t('shop.categories.createAndUse')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => { setCreating(false); setError(null) }}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Select
      value={value}
      onValueChange={(v) => (v === NEW_CATEGORY_VALUE ? setCreating(true) : onChange(v))}
    >
      <SelectTrigger><SelectValue placeholder={t('shop.products.categoryPlaceholder')} /></SelectTrigger>
      <SelectContent>
        {categories.map((c) => <SelectItem key={c.categoryId} value={c.categoryId}>{c.nameAr}</SelectItem>)}
        <SelectItem value={NEW_CATEGORY_VALUE}>{t('shop.categories.createNew')}</SelectItem>
      </SelectContent>
    </Select>
  )
}

// ============================================================
// Image upload primitives -- shared by product (primary + gallery) and
// category (single image) uploaders. Uploads directly to the public
// shop-product-images bucket (RLS: club-membership + shop.product.manage
// + module-active gated INSERT/UPDATE/DELETE, SELECT public), then
// hands the caller the resulting public URL to persist via the RPC
// layer (this component never writes shop_products/shop_categories
// rows directly -- same "storage upload, then RPC records the URL"
// shape as PaymentProofUpload.tsx).
// ============================================================
function validateImageFile(file: File, t: (key: string) => string): string | null {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return t('shop.media.invalidType')
  if (file.size > MAX_IMAGE_BYTES) return t('shop.media.tooLarge')
  return null
}

async function uploadProductImage(clubId: string, entityId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const path = `${clubId}/${entityId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const { error } = await supabase.storage.from(PRODUCT_IMAGES_BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  })
  if (error) throw error
  const { data } = supabase.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

function PrimaryImageUploader({
  clubId,
  entityId,
  imageUrl,
  onChange,
}: {
  clubId: string
  entityId: string
  imageUrl: string
  onChange: (url: string) => void
}) {
  const { t } = useTranslation()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File) {
    const validationError = validateImageFile(file, t)
    if (validationError) { setError(validationError); return }
    setError(null)
    setUploading(true)
    try {
      const url = await uploadProductImage(clubId, entityId, file)
      onChange(url)
    } catch (err) {
      setError(translateSupabaseError(err, t('shop.media.uploadError')))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <ProductThumb src={imageUrl || null} alt="" className="size-20 shrink-0 rounded-md border border-border" />
        <div className="flex flex-col gap-1.5">
          <label className="w-fit">
            <input
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleFile(file)
                e.target.value = ''
              }}
            />
            <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-muted">
              <Upload className="size-3.5" aria-hidden="true" />
              {uploading ? t('shop.media.uploading') : imageUrl ? t('shop.media.replaceImage') : t('shop.media.uploadImage')}
            </span>
          </label>
          {imageUrl && (
            <Button type="button" variant="ghost" size="sm" className="w-fit text-status-danger" onClick={() => onChange('')}>
              <X className="me-1 size-3.5" aria-hidden="true" />
              {t('shop.media.removeImage')}
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-text-secondary">{t('shop.media.fileHint')}</p>
      {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
    </div>
  )
}

function GalleryImagesUploader({
  clubId,
  entityId,
  imageUrls,
  onChange,
}: {
  clubId: string
  entityId: string
  imageUrls: string[]
  onChange: (urls: string[]) => void
}) {
  const { t } = useTranslation()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File) {
    const validationError = validateImageFile(file, t)
    if (validationError) { setError(validationError); return }
    setError(null)
    setUploading(true)
    try {
      const url = await uploadProductImage(clubId, entityId, file)
      onChange([...imageUrls, url])
    } catch (err) {
      setError(translateSupabaseError(err, t('shop.media.uploadError')))
    } finally {
      setUploading(false)
    }
  }

  function removeAt(index: number) {
    onChange(imageUrls.filter((_, i) => i !== index))
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-text-secondary">{t('shop.media.galleryLabel')}</label>
      <div className="flex flex-wrap gap-2">
        {imageUrls.map((url, i) => (
          <div key={url + i} className="group relative size-16 shrink-0 overflow-hidden rounded-md border border-border">
            <ProductThumb src={url} alt="" className="size-16" />
            <button
              type="button"
              aria-label={t('shop.media.removeImage')}
              onClick={() => removeAt(i)}
              className="absolute end-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </div>
        ))}
        <label className="flex size-16 shrink-0 cursor-pointer items-center justify-center rounded-md border border-dashed border-border text-text-secondary hover:bg-surface-muted">
          <input
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleFile(file)
              e.target.value = ''
            }}
          />
          <Upload className="size-4" aria-hidden="true" />
        </label>
      </div>
      <p className="text-xs text-text-secondary">{t('shop.media.fileHint')}</p>
      {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
    </div>
  )
}

function ManageCategoriesDialog({ clubId, onClose }: { clubId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingNameAr, setEditingNameAr] = useState('')

  const { data: categories = [], refetch } = useQuery({ queryKey: ['shop-categories-all', clubId], queryFn: () => fetchCategoriesAll(clubId) })

  function invalidate() {
    void refetch()
    void queryClient.invalidateQueries({ queryKey: ['shop-categories', clubId] })
  }

  const renameMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error: err } = await supabase.rpc('update_shop_category', { p_category_id: id, p_name_ar: editingNameAr })
      if (err) throw err
    },
    onSuccess: () => { setEditingId(null); invalidate() },
    onError: (err) => setError(translateSupabaseError(err, t('shop.categories.saveError'))),
  })

  const toggleStatusMutation = useMutation({
    mutationFn: async (c: CategoryRow) => {
      const { error: err } = await supabase.rpc('update_shop_category', {
        p_category_id: c.categoryId,
        p_status: c.status === 'active' ? 'archived' : 'active',
      })
      if (err) throw err
    },
    onSuccess: invalidate,
    onError: (err) => setError(translateSupabaseError(err, t('shop.categories.saveError'))),
  })

  // Only called with a freshly-uploaded (always non-empty) URL -- there
  // is no "clear category image" control in this dialog, so the RPC's
  // own `p_image_url is not null` update / `nullif(..., '')` clear
  // branches never need to be distinguished here.
  const imageMutation = useMutation({
    mutationFn: async ({ categoryId, imageUrl }: { categoryId: string; imageUrl: string }) => {
      const { error: err } = await supabase.rpc('update_shop_category', { p_category_id: categoryId, p_image_url: imageUrl })
      if (err) throw err
    },
    onSuccess: invalidate,
    onError: (err) => setError(translateSupabaseError(err, t('shop.categories.saveError'))),
  })

  // Up/down display_order swap -- a small, fixed category list (most
  // clubs have well under a dozen categories) does not need a drag
  // library; two buttons per row that swap this row's order with its
  // neighbor's is simpler to build correctly and to keep keyboard-
  // accessible than wiring a DnD sensor for this phase.
  const reorderMutation = useMutation({
    mutationFn: async ({ a, b }: { a: CategoryRow; b: CategoryRow }) => {
      const { error: err1 } = await supabase.rpc('update_shop_category', { p_category_id: a.categoryId, p_display_order: b.displayOrder })
      if (err1) throw err1
      const { error: err2 } = await supabase.rpc('update_shop_category', { p_category_id: b.categoryId, p_display_order: a.displayOrder })
      if (err2) throw err2
    },
    onSuccess: invalidate,
    onError: (err) => setError(translateSupabaseError(err, t('shop.categories.saveError'))),
  })

  const ordered = useMemo(
    () => [...categories].sort((a, b) => a.displayOrder - b.displayOrder || a.nameAr.localeCompare(b.nameAr)),
    [categories],
  )

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t('shop.categories.manageTitle')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-2">
          {ordered.map((c, index) => (
            <div key={c.categoryId} className="flex items-center gap-3 rounded-md border border-border p-2">
              <ProductThumb src={c.imageUrl} alt="" className="size-10 shrink-0 rounded border border-border" />
              <div className="flex flex-1 flex-col gap-1">
                {editingId === c.categoryId ? (
                  <div className="flex items-center gap-2">
                    <Input autoFocus value={editingNameAr} onChange={(e) => setEditingNameAr(e.target.value)} className="h-8" />
                    <Button size="sm" disabled={!editingNameAr || renameMutation.isPending} onClick={() => { setError(null); renameMutation.mutate(c.categoryId) }}>
                      {t('common.save')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>{t('common.cancel')}</Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className={c.status === 'archived' ? 'text-text-secondary line-through' : ''}>{c.nameAr}</span>
                    <StatusBadge tone={c.status === 'active' ? 'success' : 'neutral'} label={c.status === 'active' ? t('shop.products.statusActive') : t('shop.products.statusArchived')} />
                  </div>
                )}
                <label className="w-fit">
                  <input
                    type="file"
                    accept={ACCEPTED_IMAGE_TYPES.join(',')}
                    className="hidden"
                    disabled={imageMutation.isPending}
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (!file) return
                      const validationError = validateImageFile(file, t)
                      if (validationError) { setError(validationError); return }
                      setError(null)
                      try {
                        const url = await uploadProductImage(clubId, `categories/${c.categoryId}`, file)
                        imageMutation.mutate({ categoryId: c.categoryId, imageUrl: url })
                      } catch (err) {
                        setError(translateSupabaseError(err, t('shop.media.uploadError')))
                      }
                    }}
                  />
                  <span className="text-xs text-accent-foreground hover:underline">{c.imageUrl ? t('shop.media.replaceImage') : t('shop.media.uploadImage')}</span>
                </label>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="size-7" disabled={index === 0 || reorderMutation.isPending}
                  onClick={() => { const prev = ordered[index - 1]; if (prev) reorderMutation.mutate({ a: c, b: prev }) }} aria-label={t('shop.categories.moveUp')}>
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-7" disabled={index === ordered.length - 1 || reorderMutation.isPending}
                  onClick={() => { const next = ordered[index + 1]; if (next) reorderMutation.mutate({ a: c, b: next }) }} aria-label={t('shop.categories.moveDown')}>
                  <ArrowDown className="size-3.5" />
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setEditingId(c.categoryId); setEditingNameAr(c.nameAr) }}>{t('common.edit')}</Button>
                <Button variant="ghost" size="sm" disabled={toggleStatusMutation.isPending} onClick={() => toggleStatusMutation.mutate(c)}>
                  {c.status === 'active' ? t('shop.products.statusArchived') : t('shop.products.statusActive')}
                </Button>
              </div>
            </div>
          ))}
          {categories.length === 0 && <p className="text-sm text-text-secondary">{t('shop.categories.emptyDescription')}</p>}
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

async function fetchVariants(productId: string): Promise<VariantRow[]> {
  const { data, error } = await supabase.rpc('list_shop_product_variants', { p_product_id: productId })
  if (error) throw error
  return (data ?? []).map((r) => ({ variantId: r.variant_id, size: r.size, color: r.color, sku: r.sku, priceOverride: r.price_override !== null ? Number(r.price_override) : null, status: r.status }))
}

type ViewMode = 'grid' | 'list'
const VIEW_MODE_STORAGE_KEY = 'mala3by.shop.productsViewMode'

export function ShopProductsPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<ProductRow | null>(null)
  const [variantsFor, setVariantsFor] = useState<ProductRow | null>(null)
  const [managingCategories, setManagingCategories] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => (localStorage.getItem(VIEW_MODE_STORAGE_KEY) as ViewMode | null) ?? 'grid',
  )

  function setAndPersistViewMode(mode: ViewMode) {
    setViewMode(mode)
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode)
  }

  const { data: products = [], isLoading } = useQuery({
    queryKey: ['shop-products', currentClubId, search, categoryFilter],
    queryFn: () => fetchProducts(currentClubId as string, search, categoryFilter || undefined),
    enabled: !!currentClubId,
  })

  const { data: filterCategories = [] } = useQuery({
    queryKey: ['shop-categories', currentClubId],
    queryFn: () => fetchCategories(currentClubId as string),
    enabled: !!currentClubId,
  })

  // Best-effort -- see fetchStockByProduct's own comment. null means
  // "could not load" (likely missing inventory.view), not "zero
  // everywhere" -- rendered as "—", never as 0, to avoid a false
  // out-of-stock signal.
  const { data: stockByProduct } = useQuery({
    queryKey: ['shop-products-stock', currentClubId],
    queryFn: () => fetchStockByProduct(currentClubId as string),
    enabled: !!currentClubId,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['shop-products', currentClubId] })
    void queryClient.invalidateQueries({ queryKey: ['shop-products-stock', currentClubId] })
  }

  const columns: DataTableColumn<ProductRow>[] = [
    {
      key: 'image',
      header: '',
      render: (p) => (
        <ProductThumb src={p.imageUrl} alt={p.nameAr} className="aspect-square size-10 rounded-md border border-border" />
      ),
    },
    {
      key: 'name',
      header: t('shop.products.columns.name'),
      render: (p) => (
        <button className="text-accent-foreground hover:underline" onClick={() => setEditingProduct(p)}>
          {p.nameAr}
          {p.nameEn && <span className="ms-1.5 text-text-secondary" dir="ltr">({p.nameEn})</span>}
        </button>
      ),
    },
    { key: 'category', header: t('shop.products.columns.category'), render: (p) => p.categoryNameAr ?? '—' },
    { key: 'sku', header: t('shop.products.columns.sku'), render: (p) => p.sku ?? '—' },
    { key: 'barcode', header: t('shop.products.columns.barcode'), render: (p) => p.barcode ?? '—' },
    { key: 'price', header: t('shop.products.columns.price'), render: (p) => <MoneyDisplay amount={p.basePrice} size="sm" /> },
    {
      key: 'stock',
      header: t('shop.products.columns.stock'),
      render: (p) => {
        if (!stockByProduct) return <span className="text-text-secondary">—</span>
        const qty = stockByProduct[p.productId] ?? 0
        const isLow = p.reorderLevel !== null && qty <= p.reorderLevel
        return (
          <span className={isLow ? 'font-medium text-status-warning' : ''}>
            {qty}
            {isLow && <StatusBadge tone="warning" label={t('shop.products.lowStock')} className="ms-1.5" />}
          </span>
        )
      },
    },
    {
      key: 'variants',
      header: t('shop.products.columns.variants'),
      render: (p) => (p.hasVariants ? <VariantCountBadge productId={p.productId} /> : '—'),
    },
    {
      key: 'status',
      header: t('shop.products.columns.status'),
      render: (p) => <StatusBadge tone={p.status === 'active' ? 'success' : 'neutral'} label={p.status === 'active' ? t('shop.products.statusActive') : t('shop.products.statusArchived')} />,
    },
    {
      key: 'actions',
      header: '',
      render: (p) => p.hasVariants ? (
        <Button variant="ghost" size="sm" onClick={() => setVariantsFor(p)}>{t('shop.products.manageVariants')}</Button>
      ) : null,
    },
  ]

  return (
    <div>
      <PageHeader
        title={t('shop.products.title')}
        description={t('shop.products.description')}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setManagingCategories(true)}>{t('shop.categories.manageTitle')}</Button>
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <Button>{t('shop.products.addProduct')}</Button>
              </DialogTrigger>
              <AddProductDialog clubId={currentClubId as string} onCreated={() => { setAddOpen(false); invalidate() }} />
            </Dialog>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Input placeholder={t('shop.products.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
          <Select value={categoryFilter || '__all__'} onValueChange={(v) => setCategoryFilter(v === '__all__' ? '' : v)}>
            <SelectTrigger className="w-48"><SelectValue placeholder={t('shop.products.categoryFilterAll')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">{t('shop.products.categoryFilterAll')}</SelectItem>
              {filterCategories.map((c) => <SelectItem key={c.categoryId} value={c.categoryId}>{c.nameAr}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          <Button
            variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={viewMode === 'grid'}
            onClick={() => setAndPersistViewMode('grid')}
          >
            <LayoutGrid className="me-1.5 size-4" aria-hidden="true" />
            {t('shop.products.viewGrid')}
          </Button>
          <Button
            variant={viewMode === 'list' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={viewMode === 'list'}
            onClick={() => setAndPersistViewMode('list')}
          >
            <ListIcon className="me-1.5 size-4" aria-hidden="true" />
            {t('shop.products.viewList')}
          </Button>
        </div>
      </div>

      {managingCategories && currentClubId && (
        <ManageCategoriesDialog clubId={currentClubId} onClose={() => setManagingCategories(false)} />
      )}

      {viewMode === 'grid' ? (
        <ProductGrid
          products={products}
          isLoading={isLoading}
          stockByProduct={stockByProduct}
          onSelect={setEditingProduct}
          onManageVariants={setVariantsFor}
        />
      ) : (
        <DataTable columns={columns} rows={products} rowKey={(p) => p.productId} isLoading={isLoading} emptyTitle={t('shop.products.emptyTitle')} emptyDescription={t('shop.products.emptyDescription')} />
      )}

      {editingProduct && (
        <EditProductDialog product={editingProduct} onClose={() => setEditingProduct(null)} onSaved={() => { setEditingProduct(null); invalidate() }} />
      )}
      {variantsFor && (
        <VariantsDialog product={variantsFor} onClose={() => setVariantsFor(null)} />
      )}
    </div>
  )
}

// Small helper so the list view's variant column doesn't need its own
// query wiring in the parent -- each row independently (and lazily,
// via react-query's own dedupe/caching) fetches its variant count only
// when has_variants is true, instead of the parent eagerly fetching
// variants for every product up front.
function VariantCountBadge({ productId }: { productId: string }) {
  const { data: variants } = useQuery({ queryKey: ['shop-variants', productId], queryFn: () => fetchVariants(productId) })
  if (!variants) return <span className="text-text-secondary">…</span>
  return <span>{variants.length}</span>
}

function ProductGrid({
  products,
  isLoading,
  stockByProduct,
  onSelect,
  onManageVariants,
}: {
  products: ProductRow[]
  isLoading: boolean
  stockByProduct: Record<string, number> | null | undefined
  onSelect: (p: ProductRow) => void
  onManageVariants: (p: ProductRow) => void
}) {
  const { t } = useTranslation()

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-border p-2">
            <Skeleton className="aspect-square w-full rounded-md" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    )
  }

  if (products.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
        <p className="font-medium text-text-primary">{t('shop.products.emptyTitle')}</p>
        <p className="text-sm text-text-secondary">{t('shop.products.emptyDescription')}</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {products.map((p) => {
        const qty = stockByProduct?.[p.productId]
        const isLow = qty !== undefined && p.reorderLevel !== null && qty <= p.reorderLevel
        return (
          <button
            key={p.productId}
            onClick={() => onSelect(p)}
            className="flex flex-col overflow-hidden rounded-lg border border-border text-start transition-shadow hover:shadow-md"
          >
            {/* aspect-square reserves the image's box up front -- no
                layout jump once the <img> itself finishes loading. */}
            <ProductThumb src={p.imageUrl} alt={p.nameAr} className="aspect-square w-full" />
            <div className="flex flex-1 flex-col gap-1 p-2">
              <div className="flex items-start justify-between gap-1">
                <span className="line-clamp-2 text-sm font-medium text-text-primary">{p.nameAr}</span>
                <StatusBadge
                  tone={p.status === 'active' ? 'success' : 'neutral'}
                  label={p.status === 'active' ? t('shop.products.statusActive') : t('shop.products.statusArchived')}
                  className="shrink-0"
                />
              </div>
              {p.nameEn && <span className="truncate text-xs text-text-secondary" dir="ltr">{p.nameEn}</span>}
              {p.categoryNameAr && <span className="text-xs text-text-secondary">{p.categoryNameAr}</span>}
              <div className="mt-1 flex items-center justify-between">
                <MoneyDisplay amount={p.basePrice} size="sm" />
                <span className={`text-xs ${isLow ? 'font-medium text-status-warning' : 'text-text-secondary'}`}>
                  {qty === undefined ? '—' : t('shop.products.stockCount', { count: qty })}
                </span>
              </div>
              {(p.sku || p.barcode) && (
                <span className="truncate text-xs text-text-secondary" dir="ltr">{p.sku ?? p.barcode}</span>
              )}
              {p.hasVariants && (
                <span
                  role="button"
                  tabIndex={0}
                  className="mt-1 w-fit text-xs text-accent-foreground hover:underline"
                  onClick={(e) => { e.stopPropagation(); onManageVariants(p) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onManageVariants(p) } }}
                >
                  {t('shop.products.manageVariants')}
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}

function AddProductDialog({ clubId, onCreated }: { clubId: string; onCreated: () => void }) {
  const { t } = useTranslation()
  const [nameAr, setNameAr] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [basePrice, setBasePrice] = useState('')
  const [hasVariants, setHasVariants] = useState(false)
  const [sku, setSku] = useState('')
  const [barcode, setBarcode] = useState('')
  const [reorderLevel, setReorderLevel] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Image upload needs an entity ID for the storage path (club_id/product_id/filename),
  // but the product doesn't exist yet at upload time -- a client-generated
  // uuid is used as a stable "pending product" folder; create_shop_product
  // is called with the resulting URLs once the form is submitted, so the
  // final row's real id and this upload-time id never need to match.
  const [pendingId] = useState(() => crypto.randomUUID())
  const [imageUrl, setImageUrl] = useState('')
  const [imageUrls, setImageUrls] = useState<string[]>([])

  const createMutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('create_shop_product', {
        p_club_id: clubId,
        p_name_ar: nameAr,
        p_name_en: nameEn || undefined,
        p_category_id: categoryId || undefined,
        p_description: undefined,
        p_base_price: Number(basePrice),
        p_has_variants: hasVariants,
        p_sku: sku || undefined,
        p_barcode: barcode || undefined,
        p_image_url: imageUrl || undefined,
        p_reorder_level: reorderLevel ? Number(reorderLevel) : undefined,
        p_image_urls: imageUrls,
      })
      if (err) throw err
    },
    onSuccess: onCreated,
    onError: (err) => setError(translateSupabaseError(err, t('shop.products.createError'))),
  })

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>{t('shop.products.addProduct')}</DialogTitle></DialogHeader>
      <form onSubmit={(e) => { e.preventDefault(); setError(null); createMutation.mutate() }} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('shop.products.primaryImageLabel')}</label>
          <PrimaryImageUploader clubId={clubId} entityId={pendingId} imageUrl={imageUrl} onChange={setImageUrl} />
        </div>
        <GalleryImagesUploader clubId={clubId} entityId={pendingId} imageUrls={imageUrls} onChange={setImageUrls} />
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('shop.products.nameArLabel')}</label>
          <Input required value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('shop.products.nameEnLabel')}</label>
          <Input dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('shop.products.categoryLabel')}</label>
          <CategoryPicker clubId={clubId} value={categoryId} onChange={setCategoryId} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('shop.products.priceLabel')}</label>
          <Input required type="number" min="0" step="0.01" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hasVariants} onChange={(e) => setHasVariants(e.target.checked)} />
          {t('shop.products.hasVariantsLabel')}
        </label>
        {!hasVariants && (
          <>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('shop.products.skuLabel')}</label>
              <Input dir="ltr" value={sku} onChange={(e) => setSku(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('shop.products.barcodeLabel')}</label>
              <Input dir="ltr" value={barcode} onChange={(e) => setBarcode(e.target.value)} />
            </div>
          </>
        )}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('shop.products.reorderLevelLabel')}</label>
          <Input type="number" min="0" step="1" value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} />
          <p className="text-xs text-text-secondary">{t('shop.products.reorderLevelHint')}</p>
        </div>
        {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
        <Button type="submit" disabled={!nameAr || !basePrice || createMutation.isPending}>
          {createMutation.isPending ? t('shop.products.creating') : t('shop.products.addProduct')}
        </Button>
      </form>
    </DialogContent>
  )
}

function EditProductDialog({ product, onClose, onSaved }: { product: ProductRow; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const [nameAr, setNameAr] = useState(product.nameAr)
  const [nameEn, setNameEn] = useState(product.nameEn ?? '')
  const [categoryId, setCategoryId] = useState(product.categoryId ?? '')
  const [basePrice, setBasePrice] = useState(String(product.basePrice))
  const [status, setStatus] = useState(product.status)
  const [imageUrl, setImageUrl] = useState(product.imageUrl ?? '')
  const [imageUrls, setImageUrls] = useState<string[]>(product.imageUrls)
  const [reorderLevel, setReorderLevel] = useState(product.reorderLevel !== null ? String(product.reorderLevel) : '')
  const [error, setError] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('update_shop_product', {
        p_product_id: product.productId,
        p_name_ar: nameAr,
        p_name_en: nameEn || undefined,
        p_category_id: categoryId || undefined,
        p_description: undefined,
        p_base_price: Number(basePrice),
        p_sku: product.sku ?? undefined,
        p_barcode: undefined,
        p_image_url: imageUrl || undefined,
        p_reorder_level: reorderLevel ? Number(reorderLevel) : undefined,
        p_status: status,
        p_image_urls: imageUrls,
      })
      if (err) throw err
    },
    onSuccess: onSaved,
    onError: (err) => setError(translateSupabaseError(err, t('shop.products.saveError'))),
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{product.nameAr}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.products.primaryImageLabel')}</label>
            <PrimaryImageUploader clubId={currentClubId as string} entityId={product.productId} imageUrl={imageUrl} onChange={setImageUrl} />
          </div>
          <GalleryImagesUploader clubId={currentClubId as string} entityId={product.productId} imageUrls={imageUrls} onChange={setImageUrls} />
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.products.nameArLabel')}</label>
            <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.products.nameEnLabel')}</label>
            <Input dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.products.categoryLabel')}</label>
            <CategoryPicker clubId={currentClubId as string} value={categoryId} onChange={setCategoryId} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.products.priceLabel')}</label>
            <Input type="number" min="0" step="0.01" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.products.reorderLevelLabel')}</label>
            <Input type="number" min="0" step="1" value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} />
            <p className="text-xs text-text-secondary">{t('shop.products.reorderLevelHint')}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.products.columns.status')}</label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">{t('shop.products.statusActive')}</SelectItem>
                <SelectItem value="archived">{t('shop.products.statusArchived')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={saveMutation.isPending} onClick={() => { setError(null); saveMutation.mutate() }}>
              {saveMutation.isPending ? t('shop.products.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function VariantsDialog({ product, onClose }: { product: ProductRow; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [size, setSize] = useState('')
  const [color, setColor] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: variants = [], refetch } = useQuery({ queryKey: ['shop-variants', product.productId], queryFn: () => fetchVariants(product.productId) })

  const addMutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('create_shop_product_variant', {
        p_product_id: product.productId,
        p_size: size || undefined,
        p_color: color || undefined,
      })
      if (err) throw err
    },
    onSuccess: () => {
      setSize(''); setColor(''); setError(null)
      void refetch()
      void queryClient.invalidateQueries({ queryKey: ['shop-pos-variants', product.productId] })
    },
    onError: (err) => setError(translateSupabaseError(err, t('shop.products.variantCreateError'))),
  })

  // COMMERCIAL MODULE ARCHITECTURE (2026-08-26) -- directive Section 8:
  // variant lifecycle. Archiving (not deleting) an inactive variant
  // keeps its historical sale/inventory rows intact -- create_shop_sale()
  // already independently filters status='active' on variants server-
  // side, so this is real enforcement, not just a UI hide.
  const toggleArchiveMutation = useMutation({
    mutationFn: async (v: VariantRow) => {
      const { error: err } = await supabase.rpc('update_shop_product_variant', {
        p_variant_id: v.variantId,
        p_size: v.size ?? undefined,
        p_color: v.color ?? undefined,
        p_sku: v.sku ?? undefined,
        p_barcode: undefined,
        p_price_override: v.priceOverride ?? undefined,
        p_status: v.status === 'active' ? 'archived' : 'active',
      })
      if (err) throw err
    },
    onSuccess: () => {
      void refetch()
      void queryClient.invalidateQueries({ queryKey: ['shop-pos-variants', product.productId] })
    },
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('shop.products.variantsFor', { name: product.nameAr })}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {variants.map((v) => (
              <div key={v.variantId} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <div className="flex items-center gap-2">
                  <span>{[v.size, v.color].filter(Boolean).join(' / ') || t('shop.pos.defaultVariant')}</span>
                  <StatusBadge tone={v.status === 'active' ? 'success' : 'neutral'} label={v.status === 'active' ? t('shop.products.statusActive') : t('shop.products.statusArchived')} />
                </div>
                <div className="flex items-center gap-2">
                  {v.priceOverride !== null && <MoneyDisplay amount={v.priceOverride} size="sm" />}
                  <Button variant="ghost" size="sm" disabled={toggleArchiveMutation.isPending} onClick={() => toggleArchiveMutation.mutate(v)}>
                    {v.status === 'active' ? t('shop.products.archiveVariant') : t('shop.products.reactivateVariant')}
                  </Button>
                </div>
              </div>
            ))}
            {variants.length === 0 && <p className="text-sm text-text-secondary">{t('shop.products.noVariantsYet')}</p>}
          </div>
          <div className="flex gap-2">
            <Input placeholder={t('shop.products.sizeLabel')} value={size} onChange={(e) => setSize(e.target.value)} />
            <Input placeholder={t('shop.products.colorLabel')} value={color} onChange={(e) => setColor(e.target.value)} />
            <Button disabled={(!size && !color) || addMutation.isPending} onClick={() => addMutation.mutate()}>
              {t('shop.products.addVariant')}
            </Button>
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
