import { useState } from 'react'
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

// COMMERCIAL MODULE (2026-08-26) -- Products & Categories management
// (directive Section 105/106). Variant creation kept intentionally
// simple (a dedicated inline add-row, not a matrix generator --
// directive Section 106's own "do not introduce a fragile matrix
// generation unless tested" instruction).
interface ProductRow {
  productId: string
  nameAr: string
  nameEn: string | null
  categoryId: string | null
  categoryNameAr: string | null
  basePrice: number
  hasVariants: boolean
  sku: string | null
  status: string
}

interface CategoryOption {
  categoryId: string
  nameAr: string
}

interface VariantRow {
  variantId: string
  size: string | null
  color: string | null
  sku: string | null
  priceOverride: number | null
  status: string
}

async function fetchProducts(clubId: string, search: string): Promise<ProductRow[]> {
  const { data, error } = await supabase.rpc('list_shop_products', { p_club_id: clubId, p_search: search || undefined, p_status: undefined })
  if (error) throw error
  return (data ?? []).map((r) => ({
    productId: r.product_id, nameAr: r.name_ar, nameEn: r.name_en, categoryId: r.category_id, categoryNameAr: r.category_name_ar,
    basePrice: Number(r.base_price), hasVariants: r.has_variants, sku: r.sku, status: r.status,
  }))
}

async function fetchCategories(clubId: string): Promise<CategoryOption[]> {
  const { data, error } = await supabase.rpc('list_shop_categories', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({ categoryId: r.category_id, nameAr: r.name_ar }))
}

async function fetchVariants(productId: string): Promise<VariantRow[]> {
  const { data, error } = await supabase.rpc('list_shop_product_variants', { p_product_id: productId })
  if (error) throw error
  return (data ?? []).map((r) => ({ variantId: r.variant_id, size: r.size, color: r.color, sku: r.sku, priceOverride: r.price_override !== null ? Number(r.price_override) : null, status: r.status }))
}

export function ShopProductsPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<ProductRow | null>(null)
  const [variantsFor, setVariantsFor] = useState<ProductRow | null>(null)

  const { data: products = [], isLoading } = useQuery({
    queryKey: ['shop-products', currentClubId, search],
    queryFn: () => fetchProducts(currentClubId as string, search),
    enabled: !!currentClubId,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['shop-products', currentClubId] })
  }

  const columns: DataTableColumn<ProductRow>[] = [
    {
      key: 'name',
      header: t('shop.products.columns.name'),
      render: (p) => (
        <button className="text-accent-foreground hover:underline" onClick={() => setEditingProduct(p)}>
          {p.nameAr}
        </button>
      ),
    },
    { key: 'category', header: t('shop.products.columns.category'), render: (p) => p.categoryNameAr ?? '—' },
    { key: 'price', header: t('shop.products.columns.price'), render: (p) => <MoneyDisplay amount={p.basePrice} size="sm" /> },
    { key: 'sku', header: t('shop.products.columns.sku'), render: (p) => p.sku ?? '—' },
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
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button>{t('shop.products.addProduct')}</Button>
            </DialogTrigger>
            <AddProductDialog clubId={currentClubId as string} onCreated={() => { setAddOpen(false); invalidate() }} />
          </Dialog>
        }
      />

      <Input placeholder={t('shop.products.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} className="mb-4 max-w-xs" />

      <DataTable columns={columns} rows={products} rowKey={(p) => p.productId} isLoading={isLoading} emptyTitle={t('shop.products.emptyTitle')} emptyDescription={t('shop.products.emptyDescription')} />

      {editingProduct && (
        <EditProductDialog product={editingProduct} onClose={() => setEditingProduct(null)} onSaved={() => { setEditingProduct(null); invalidate() }} />
      )}
      {variantsFor && (
        <VariantsDialog product={variantsFor} onClose={() => setVariantsFor(null)} />
      )}
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
  const [error, setError] = useState<string | null>(null)

  const { data: categories = [] } = useQuery({ queryKey: ['shop-categories', clubId], queryFn: () => fetchCategories(clubId) })

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
          <label className="text-sm font-medium text-text-secondary">{t('shop.products.nameArLabel')}</label>
          <Input required value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('shop.products.nameEnLabel')}</label>
          <Input dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('shop.products.categoryLabel')}</label>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger><SelectValue placeholder={t('shop.products.categoryPlaceholder')} /></SelectTrigger>
            <SelectContent>
              {categories.map((c) => <SelectItem key={c.categoryId} value={c.categoryId}>{c.nameAr}</SelectItem>)}
            </SelectContent>
          </Select>
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
  const [error, setError] = useState<string | null>(null)

  const { data: categories = [] } = useQuery({ queryKey: ['shop-categories', currentClubId], queryFn: () => fetchCategories(currentClubId as string), enabled: !!currentClubId })

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
        p_image_url: undefined,
        p_reorder_level: undefined,
        p_status: status,
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
            <label className="text-sm font-medium text-text-secondary">{t('shop.products.nameArLabel')}</label>
            <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.products.nameEnLabel')}</label>
            <Input dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.products.categoryLabel')}</label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger><SelectValue placeholder={t('shop.products.categoryPlaceholder')} /></SelectTrigger>
              <SelectContent>
                {categories.map((c) => <SelectItem key={c.categoryId} value={c.categoryId}>{c.nameAr}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.products.priceLabel')}</label>
            <Input type="number" min="0" step="0.01" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} />
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

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('shop.products.variantsFor', { name: product.nameAr })}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {variants.map((v) => (
              <div key={v.variantId} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <span>{[v.size, v.color].filter(Boolean).join(' / ') || t('shop.pos.defaultVariant')}</span>
                {v.priceOverride !== null && <MoneyDisplay amount={v.priceOverride} size="sm" />}
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
