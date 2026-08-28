import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ProductThumb } from '@/features/shop/shop-media'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Trash2, Plus, Minus, ScanBarcode, ShoppingCart, Sparkles } from 'lucide-react'
import { translateSupabaseError } from '@/lib/errors'

// COMMERCIAL MODULE (2026-08-26) -- the POS/reception sale screen
// (directive Section 28: Customer -> Product Search -> Variant ->
// Quantity -> Cart -> Review -> Invoice -> Payment). Client-side cart
// totals are a PREVIEW ONLY (directive Section 29) -- create_shop_sale()
// re-derives every price server-side from the live product row and
// ignores whatever unit_price this screen displays; this UI never
// sends a price to the server at all, only product_id/variant_id/
// quantity, so there is structurally nothing here to tamper with.
//
// COMMERCE PRO C2 (2026-08-28) -- POS rebuild. See
// COMMERCE_PRO_UPGRADE_PLAN.md Section 5 (Phase C2) and
// COMMERCE_C2_POS_REBUILD_REPORT.md for the full account. Scope: the
// chrome around product-picking only -- category strip, image-forward
// product cards, a dedicated barcode-scan input, and a responsive
// layout (cart reachable via a Sheet on mobile instead of being
// squeezed beside the grid). Cart STATE and its mutating functions
// (addToCart/updateQuantity/removeLine, the CartLine shape, and the
// create_shop_sale call itself) are UNCHANGED from the pre-C2 version
// -- byte-identical logic, only the surrounding UI moved. Payment
// panel, discounts, and hold/resume are explicitly Phase C3's scope
// and were not touched here beyond what was needed to keep the page
// compiling with the new layout.
interface ProductOption {
  productId: string
  nameAr: string
  nameEn: string | null
  categoryId: string | null
  hasVariants: boolean
  basePrice: number
  status: string
  imageUrl: string | null
  barcode: string | null
  reorderLevel: number | null
}

interface VariantOption {
  variantId: string
  size: string | null
  color: string | null
  sku: string | null
  barcode: string | null
  priceOverride: number | null
  status: string
}

interface CategoryOption {
  categoryId: string
  nameAr: string
  nameEn: string | null
  imageUrl: string | null
  displayOrder: number
}

interface CustomerOption {
  id: string
  fullName: string | null
  mobileDisplay: string | null
}

interface LocationOption {
  locationId: string
  name: string
}

interface CartLine {
  productId: string
  productName: string
  variantId: string | null
  variantLabel: string | null
  quantity: number
  displayPrice: number
}

async function fetchProducts(clubId: string, search: string): Promise<ProductOption[]> {
  // Unfiltered by category here -- the category strip filters
  // client-side (see filteredProducts below) so switching chips is
  // instant with no extra round-trip, and so the same fetched list can
  // power the "count per category" chip labels without an N+1 query.
  const { data, error } = await supabase.rpc('list_shop_products', { p_club_id: clubId, p_search: search || undefined, p_status: 'active' })
  if (error) throw error
  return (data ?? []).map((r) => ({
    productId: r.product_id, nameAr: r.name_ar, nameEn: r.name_en, categoryId: r.category_id, hasVariants: r.has_variants,
    basePrice: Number(r.base_price), status: r.status, imageUrl: r.image_url, barcode: r.barcode, reorderLevel: r.reorder_level,
  }))
}

async function fetchVariants(productId: string): Promise<VariantOption[]> {
  const { data, error } = await supabase.rpc('list_shop_product_variants', { p_product_id: productId })
  if (error) throw error
  return (data ?? [])
    .filter((r) => r.status === 'active')
    .map((r) => ({ variantId: r.variant_id, size: r.size, color: r.color, sku: r.sku, barcode: r.barcode, priceOverride: r.price_override !== null ? Number(r.price_override) : null, status: r.status }))
}

async function fetchCategories(clubId: string): Promise<CategoryOption[]> {
  const { data, error } = await supabase.rpc('list_shop_categories', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({ categoryId: r.category_id, nameAr: r.name_ar, nameEn: r.name_en, imageUrl: r.image_url, displayOrder: r.display_order }))
}

async function fetchLocations(clubId: string): Promise<LocationOption[]> {
  const { data, error } = await supabase.rpc('list_shop_inventory_locations', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({ locationId: r.location_id, name: r.name }))
}

async function fetchCustomers(clubId: string, search: string): Promise<CustomerOption[]> {
  if (!search.trim()) return []
  const escaped = search.trim().replace(/[%,]/g, '\\$&')
  const { data, error } = await supabase
    .from('customers')
    .select('id, full_name, mobile_display')
    .eq('club_id', clubId)
    .or(`full_name.ilike.%${escaped}%,mobile_display.ilike.%${escaped}%`)
    .limit(10)
  if (error) throw error
  return (data ?? []).map((c) => ({ id: c.id, fullName: c.full_name, mobileDisplay: c.mobile_display }))
}

// Best-effort aggregate on-hand stock per product, across every
// location and variant -- same fail-open pattern as
// ShopProductsPage.tsx's fetchStockByProduct (Phase C1). Requires
// inventory.view, a permission distinct from shop.view/shop.pos.
// (whatever gates this page itself); a cashier role that can sell but
// not view inventory detail is a real, intentional combination, so a
// failure here must never block the sell screen from rendering --
// stock badges are an enrichment, not the page's core purpose. Callers
// treat `null` as "unknown" (renders no stock badge, product remains
// clickable) rather than fabricating a false "in stock" or "out of
// stock" signal.
async function fetchStockByProduct(clubId: string): Promise<Record<string, number> | null> {
  const { data, error } = await supabase.rpc('get_shop_inventory_balances', { p_club_id: clubId })
  if (error) return null
  const totals: Record<string, number> = {}
  for (const row of data ?? []) {
    totals[row.product_id] = (totals[row.product_id] ?? 0) + Number(row.on_hand)
  }
  return totals
}

interface TopProductRow {
  productId: string
  unitsSold: number
}

// Best Sellers is derived from REAL sale history only
// (get_shop_top_products, already used by ReportShopPage.tsx) -- never
// fabricated. That RPC is gated on report.view, a permission most
// cashier roles will NOT hold (it is deliberately broader/more
// sensitive than shop.view per its own migration comment). A cashier
// without report.view is an expected, legitimate combination, so a
// denial here fails silently to "no Best Sellers chip" rather than a
// page-level error -- same fail-open contract as fetchStockByProduct.
async function fetchTopProductIds(clubId: string): Promise<TopProductRow[] | null> {
  const { data, error } = await supabase.rpc('get_shop_top_products', { p_club_id: clubId, p_limit: 12 })
  if (error) return null
  return (data ?? []).map((r) => ({ productId: r.product_id, unitsSold: Number(r.units_sold) }))
}

const BEST_SELLERS_CHIP = '__best_sellers__'
const ALL_PRODUCTS_CHIP = '__all__'

export function ShopPOSPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()

  const [productSearch, setProductSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>(ALL_PRODUCTS_CHIP)
  const [pickingProduct, setPickingProduct] = useState<ProductOption | null>(null)
  const [cart, setCart] = useState<CartLine[]>([])
  const [customerSearch, setCustomerSearch] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null)
  const [locationId, setLocationId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [partialPayment, setPartialPayment] = useState(false)
  const [paymentAmountInput, setPaymentAmountInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [lastSetupNotice, setLastSetupNotice] = useState<string | null>(null)
  const [barcodeInput, setBarcodeInput] = useState('')
  const [barcodeNotFound, setBarcodeNotFound] = useState<string | null>(null)
  const [mobileCartOpen, setMobileCartOpen] = useState(false)
  const barcodeInputRef = useRef<HTMLInputElement>(null)

  const { data: products = [], isLoading: productsLoading } = useQuery({
    queryKey: ['shop-pos-products', currentClubId, productSearch],
    queryFn: () => fetchProducts(currentClubId as string, productSearch),
    enabled: !!currentClubId,
  })
  const { data: categories = [] } = useQuery({
    queryKey: ['shop-pos-categories', currentClubId],
    queryFn: () => fetchCategories(currentClubId as string),
    enabled: !!currentClubId,
  })
  const { data: stockByProduct } = useQuery({
    queryKey: ['shop-pos-stock', currentClubId],
    queryFn: () => fetchStockByProduct(currentClubId as string),
    enabled: !!currentClubId,
  })
  const { data: topProducts } = useQuery({
    queryKey: ['shop-pos-top-products', currentClubId],
    queryFn: () => fetchTopProductIds(currentClubId as string),
    enabled: !!currentClubId,
  })
  const { data: variants = [] } = useQuery({
    queryKey: ['shop-pos-variants', pickingProduct?.productId],
    queryFn: () => fetchVariants(pickingProduct!.productId),
    enabled: !!pickingProduct?.hasVariants,
  })
  const { data: locations = [] } = useQuery({
    queryKey: ['shop-pos-locations', currentClubId],
    queryFn: () => fetchLocations(currentClubId as string),
    enabled: !!currentClubId,
  })
  const { data: customerResults = [] } = useQuery({
    queryKey: ['shop-pos-customers', currentClubId, customerSearch],
    queryFn: () => fetchCustomers(currentClubId as string, customerSearch),
    enabled: !!currentClubId && customerSearch.trim().length > 0,
  })

  // Category chip counts -- derived from the already-fetched product
  // list (no N+1 query per chip, no separate aggregate RPC needed).
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of products) {
      if (p.categoryId) counts[p.categoryId] = (counts[p.categoryId] ?? 0) + 1
    }
    return counts
  }, [products])

  const topProductIdSet = useMemo(() => new Set((topProducts ?? []).map((r) => r.productId)), [topProducts])

  const filteredProducts = useMemo(() => {
    if (activeCategory === ALL_PRODUCTS_CHIP) return products
    if (activeCategory === BEST_SELLERS_CHIP) return products.filter((p) => topProductIdSet.has(p.productId))
    return products.filter((p) => p.categoryId === activeCategory)
  }, [products, activeCategory, topProductIdSet])

  function stockFor(productId: string): { qty: number | null; isOut: boolean; isLow: boolean; reorderLevel: number | null } {
    const product = products.find((p) => p.productId === productId)
    if (!stockByProduct || !product) return { qty: null, isOut: false, isLow: false, reorderLevel: product?.reorderLevel ?? null }
    const qty = stockByProduct[productId] ?? 0
    const isOut = qty <= 0
    const isLow = !isOut && product.reorderLevel !== null && qty <= product.reorderLevel
    return { qty, isOut, isLow, reorderLevel: product.reorderLevel }
  }

  function addToCart(product: ProductOption, variant: VariantOption | null) {
    setCart((current) => {
      const existingIdx = current.findIndex((l) => l.productId === product.productId && l.variantId === (variant?.variantId ?? null))
      const existing = existingIdx >= 0 ? current[existingIdx] : undefined
      if (existing) {
        const next = [...current]
        next[existingIdx] = { ...existing, quantity: existing.quantity + 1 }
        return next
      }
      const label = variant ? [variant.size, variant.color].filter(Boolean).join(' / ') : null
      return [
        ...current,
        {
          productId: product.productId,
          productName: product.nameAr,
          variantId: variant?.variantId ?? null,
          variantLabel: label,
          quantity: 1,
          displayPrice: variant?.priceOverride ?? product.basePrice,
        },
      ]
    })
    setPickingProduct(null)
  }

  function updateQuantity(idx: number, delta: number) {
    setCart((current) => {
      const line = current[idx]
      if (!line) return current
      const q = line.quantity + delta
      if (q <= 0) return current.filter((_, i) => i !== idx)
      const next = [...current]
      next[idx] = { ...line, quantity: q }
      return next
    })
  }

  function removeLine(idx: number) {
    setCart((current) => current.filter((_, i) => i !== idx))
  }

  // ------------------------------------------------------------
  // Barcode scan input. A barcode scanner behaves like a very fast
  // keyboard: it "types" the encoded digits followed by Enter. This
  // input stays focused between scans (refocused after every
  // add-to-cart, every not-found message, and on a short interval
  // watching for blur caused by an incidental click elsewhere on the
  // page) so the cashier never has to click into it before the next
  // scan. No debounce is applied to the keystrokes themselves --
  // scanners fire real, distinct keydown events through the browser's
  // normal input pipeline (this is not a firehose of synthetic events
  // React needs to coalesce), and the match only ever runs once, on
  // Enter, against the input's final committed value -- so there is no
  // realistic double-submit risk from scan speed alone. Duplicate
  // Enter/double-scan of the SAME barcode in immediate succession is
  // handled by the existing addToCart increment-if-present logic
  // (harmless: it just increments quantity by 1 again, which is
  // correct scanner behavior -- scan twice, get two units).
  // ------------------------------------------------------------
  function refocusBarcodeInput() {
    // Deferred a tick so it runs after whatever state update/re-render
    // this call was triggered from.
    window.setTimeout(() => barcodeInputRef.current?.focus(), 0)
  }

  function handleBarcodeSubmit() {
    const code = barcodeInput.trim()
    if (!code) return
    setBarcodeNotFound(null)

    const productMatch = products.find((p) => p.barcode === code)
    if (productMatch) {
      if (productMatch.hasVariants) {
        // A product-level barcode match on a variant-bearing product is
        // ambiguous (which variant?) -- open the variant picker instead
        // of guessing.
        setPickingProduct(productMatch)
        setBarcodeInput('')
        refocusBarcodeInput()
        return
      }
      const stock = stockFor(productMatch.productId)
      if (stock.isOut) {
        setBarcodeNotFound(t('shop.pos.barcodeOutOfStock', { name: productMatch.nameAr }))
        setBarcodeInput('')
        refocusBarcodeInput()
        return
      }
      addToCart(productMatch, null)
      setBarcodeInput('')
      refocusBarcodeInput()
      return
    }

    // No product-level match -- search variant barcodes across every
    // loaded product. Variants are fetched lazily per-product elsewhere
    // in this page, so a full-catalog variant barcode scan issues a
    // direct RPC call here instead of relying on cached per-product
    // variant queries that may not exist yet.
    void (async () => {
      for (const product of products) {
        if (!product.hasVariants) continue
        const productVariants = await fetchVariants(product.productId)
        const variantMatch = productVariants.find((v) => v.barcode === code)
        if (variantMatch) {
          const stock = stockFor(product.productId)
          if (stock.isOut) {
            setBarcodeNotFound(t('shop.pos.barcodeOutOfStock', { name: product.nameAr }))
          } else {
            addToCart(product, variantMatch)
          }
          setBarcodeInput('')
          refocusBarcodeInput()
          return
        }
      }
      setBarcodeNotFound(t('shop.pos.barcodeNotFound', { code }))
      setBarcodeInput('')
      refocusBarcodeInput()
    })()
  }

  const subtotal = cart.reduce((sum, l) => sum + l.displayPrice * l.quantity, 0)

  // Partial payment (COMMERCIAL CLOSURE 2026-08-27): create_shop_sale's
  // p_payment_amount defaults to the full subtotal when omitted --
  // identical to prior behavior. Staff who opt into "pay partial" collect
  // the remainder later via the invoice's normal payment flow (the same
  // record_payment() engine every other invoice type already uses).
  const paidAmount = partialPayment ? Number(paymentAmountInput || 0) : subtotal
  const outstandingPreview = Math.max(subtotal - paidAmount, 0)

  const saleMutation = useMutation({
    mutationFn: async () => {
      const items = cart.map((l) => ({ product_id: l.productId, variant_id: l.variantId, quantity: l.quantity }))
      const { data, error: err } = await supabase.rpc('create_shop_sale', {
        p_club_id: currentClubId as string,
        p_location_id: locationId,
        p_customer_id: selectedCustomer!.id,
        p_items: items,
        p_payment_method: paymentMethod,
        p_payment_reference: undefined,
        p_idempotency_key: crypto.randomUUID(),
        p_payment_amount: partialPayment ? paidAmount : undefined,
      })
      if (err) throw err
      return data
    },
    onSuccess: () => {
      setCart([])
      setSelectedCustomer(null)
      setCustomerSearch('')
      setPartialPayment(false)
      setPaymentAmountInput('')
      setError(null)
      setLastSetupNotice(t('shop.pos.saleCompleted'))
      setMobileCartOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['shop-inventory-balances'] })
      void queryClient.invalidateQueries({ queryKey: ['shop-pos-stock'] })
    },
    onError: (err) => setError(translateSupabaseError(err, t('shop.pos.saleError'))),
  })

  function handleCompleteSale() {
    setError(null)
    if (!locationId) { setError(t('shop.pos.locationRequired')); return }
    if (!selectedCustomer) { setError(t('shop.pos.customerRequired')); return }
    if (cart.length === 0) { setError(t('shop.pos.cartEmpty')); return }
    if (partialPayment && (paidAmount <= 0 || paidAmount >= subtotal)) {
      setError(t('shop.pos.partialAmountInvalid'))
      return
    }
    saleMutation.mutate()
  }

  const cartPanel = (
    <CartPanel
      locations={locations}
      locationId={locationId}
      setLocationId={setLocationId}
      selectedCustomer={selectedCustomer}
      setSelectedCustomer={setSelectedCustomer}
      customerSearch={customerSearch}
      setCustomerSearch={setCustomerSearch}
      customerResults={customerResults}
      cart={cart}
      updateQuantity={updateQuantity}
      removeLine={removeLine}
      subtotal={subtotal}
      partialPayment={partialPayment}
      setPartialPayment={setPartialPayment}
      paymentAmountInput={paymentAmountInput}
      setPaymentAmountInput={setPaymentAmountInput}
      outstandingPreview={outstandingPreview}
      paymentMethod={paymentMethod}
      setPaymentMethod={setPaymentMethod}
      error={error}
      lastSetupNotice={lastSetupNotice}
      isPending={saleMutation.isPending}
      onCompleteSale={handleCompleteSale}
    />
  )

  return (
    <div>
      <PageHeader title={t('shop.pos.title')} description={t('shop.pos.description')} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder={t('shop.pos.searchProducts')}
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              className="flex-1"
            />
            <div className="relative flex-1">
              <ScanBarcode className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
              <Input
                ref={barcodeInputRef}
                placeholder={t('shop.pos.barcodePlaceholder')}
                value={barcodeInput}
                onChange={(e) => { setBarcodeInput(e.target.value); setBarcodeNotFound(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleBarcodeSubmit() } }}
                dir="ltr"
                className="ps-9"
                aria-label={t('shop.pos.barcodePlaceholder')}
              />
            </div>
          </div>
          {barcodeNotFound && (
            <p role="alert" className="text-sm text-status-danger">{barcodeNotFound}</p>
          )}

          <CategoryStrip
            categories={categories}
            categoryCounts={categoryCounts}
            totalCount={products.length}
            hasBestSellers={!!topProducts && topProducts.length > 0}
            bestSellersCount={topProductIdSet.size}
            activeCategory={activeCategory}
            onSelect={setActiveCategory}
          />

          <ProductGrid
            products={filteredProducts}
            isLoading={productsLoading}
            stockFor={stockFor}
            onSelect={(p) => (p.hasVariants ? setPickingProduct(p) : addToCart(p, null))}
          />

          {pickingProduct && (
            <div className="rounded-md border border-border p-3">
              <p className="mb-2 text-sm font-medium">{t('shop.pos.chooseVariant', { name: pickingProduct.nameAr })}</p>
              <div className="flex flex-wrap gap-2">
                {variants.map((v) => (
                  <Button
                    key={v.variantId}
                    variant="outline"
                    size="lg"
                    className="h-11"
                    onClick={() => addToCart(pickingProduct, v)}
                  >
                    {[v.size, v.color].filter(Boolean).join(' / ') || t('shop.pos.defaultVariant')}
                  </Button>
                ))}
                {variants.length === 0 && <p className="text-sm text-text-secondary">{t('shop.pos.noVariants')}</p>}
              </div>
              <Button variant="ghost" size="sm" className="mt-2" onClick={() => setPickingProduct(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          )}
        </div>

        {/* Desktop/tablet cart panel -- squeezed alongside the grid at
            lg+ per the preserved 1fr/360px split. Hidden below lg;
            mobile users reach the cart via the floating button + Sheet
            below instead (product-first flow, per the plan's explicit
            "cart should NOT be squeezed alongside the grid on mobile"
            instruction). */}
        <div className="hidden lg:block">{cartPanel}</div>
      </div>

      {/* Mobile cart access: a fixed bottom bar showing the running
          item count/subtotal, opening the full cart in a Sheet. Kept
          intentionally simple -- Phase C3 owns cart/payment UX polish,
          this is just the C2-scoped "how do you even reach the cart on
          a phone" wiring so the page is usable end-to-end on mobile
          without squeezing the grid. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface p-3 shadow-lg lg:hidden">
        <Button className="h-12 w-full text-base" onClick={() => setMobileCartOpen(true)}>
          <ShoppingCart className="me-2 size-5" aria-hidden="true" />
          {cart.length > 0
            ? t('shop.pos.viewCartWithTotal', { count: cart.reduce((s, l) => s + l.quantity, 0) })
            : t('shop.pos.viewCart')}
          {cart.length > 0 && (
            <span className="ms-auto">
              <MoneyDisplay amount={subtotal} size="sm" />
            </span>
          )}
        </Button>
      </div>
      {/* Spacer so the fixed bottom bar never covers the last row of
          product cards. */}
      <div className="h-20 lg:hidden" aria-hidden="true" />

      <Sheet open={mobileCartOpen} onOpenChange={setMobileCartOpen}>
        <SheetContent side="left" className="flex w-full flex-col gap-3 overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t('shop.pos.cartTitle')}</SheetTitle>
          </SheetHeader>
          {cartPanel}
        </SheetContent>
      </Sheet>
    </div>
  )
}

function CategoryStrip({
  categories,
  categoryCounts,
  totalCount,
  hasBestSellers,
  bestSellersCount,
  activeCategory,
  onSelect,
}: {
  categories: CategoryOption[]
  categoryCounts: Record<string, number>
  totalCount: number
  hasBestSellers: boolean
  bestSellersCount: number
  activeCategory: string
  onSelect: (categoryId: string) => void
}) {
  const { t } = useTranslation()
  const ordered = useMemo(() => [...categories].sort((a, b) => a.displayOrder - b.displayOrder || a.nameAr.localeCompare(b.nameAr)), [categories])

  return (
    <div
      // overflow-x-auto + the browser's own bidi-aware scrolling means
      // this scrolls start-to-end correctly in both directions without
      // any manual RTL flip: in an `dir="rtl"` ancestor (this whole app
      // is mounted with dir="rtl" by default) the scrollable content's
      // logical start is already the visual right, so "scrolling toward
      // more chips" naturally goes right-to-left without extra code.
      className="flex gap-2 overflow-x-auto pb-1"
      role="tablist"
      aria-label={t('shop.pos.categoryStripLabel')}
    >
      <CategoryChip
        active={activeCategory === ALL_PRODUCTS_CHIP}
        label={t('shop.pos.allProducts')}
        count={totalCount}
        onClick={() => onSelect(ALL_PRODUCTS_CHIP)}
      />
      {hasBestSellers && (
        <CategoryChip
          active={activeCategory === BEST_SELLERS_CHIP}
          label={t('shop.pos.bestSellers')}
          count={bestSellersCount}
          icon={<Sparkles className="size-3.5" aria-hidden="true" />}
          onClick={() => onSelect(BEST_SELLERS_CHIP)}
        />
      )}
      {ordered.map((c) => (
        <CategoryChip
          key={c.categoryId}
          active={activeCategory === c.categoryId}
          label={c.nameAr}
          count={categoryCounts[c.categoryId] ?? 0}
          imageUrl={c.imageUrl}
          onClick={() => onSelect(c.categoryId)}
        />
      ))}
    </div>
  )
}

function CategoryChip({
  active,
  label,
  count,
  imageUrl,
  icon,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  imageUrl?: string | null
  icon?: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      // h-11 (44px) touch target -- matches this project's own
      // touch-friendly sizing convention for primary interactive
      // controls (e.g. Button's "lg" size is h-10; this is slightly
      // taller since it is a repeated, rapid-tap POS control, not an
      // occasional form action).
      className={`flex h-11 shrink-0 items-center gap-2 rounded-full border px-3 text-sm font-medium transition-colors ${
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-surface text-text-primary hover:bg-surface-muted'
      }`}
    >
      {imageUrl ? (
        <ProductThumb src={imageUrl} alt="" className="size-6 shrink-0 rounded-full" />
      ) : icon ? (
        <span className={active ? 'text-primary-foreground' : 'text-text-secondary'}>{icon}</span>
      ) : null}
      <span className="whitespace-nowrap">{label}</span>
      <span className={`rounded-full px-1.5 text-xs tabular-nums ${active ? 'bg-primary-foreground/20' : 'bg-surface-muted text-text-secondary'}`}>
        {count}
      </span>
    </button>
  )
}

function ProductGrid({
  products,
  isLoading,
  stockFor,
  onSelect,
}: {
  products: ProductOption[]
  isLoading: boolean
  stockFor: (productId: string) => { qty: number | null; isOut: boolean; isLow: boolean; reorderLevel: number | null }
  onSelect: (p: ProductOption) => void
}) {
  const { t } = useTranslation()

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
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
      <p className="py-8 text-center text-sm text-text-secondary">{t('shop.pos.noProducts')}</p>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
      {products.map((p) => {
        const stock = stockFor(p.productId)
        const disabled = stock.isOut
        return (
          <button
            key={p.productId}
            type="button"
            disabled={disabled}
            onClick={() => !disabled && onSelect(p)}
            // min-h-[7rem] plus the image aspect-square ensures a real
            // touch target well above the 44px minimum even on the
            // smallest 2-column mobile layout -- this is the primary,
            // highest-frequency tap target on the whole page.
            className={`flex flex-col overflow-hidden rounded-lg border text-start transition-shadow ${
              disabled
                ? 'cursor-not-allowed border-border opacity-50'
                : 'border-border hover:shadow-md active:scale-[0.98]'
            }`}
            aria-disabled={disabled}
          >
            <div className="relative">
              <ProductThumb src={p.imageUrl} alt={p.nameAr} className="aspect-square w-full" />
              {disabled && (
                <span className="absolute inset-x-1 top-1 rounded-md bg-status-danger/90 px-1.5 py-0.5 text-center text-[11px] font-medium text-white">
                  {t('shop.pos.outOfStock')}
                </span>
              )}
              {!disabled && stock.isLow && (
                <span className="absolute inset-x-1 top-1 rounded-md bg-status-warning/90 px-1.5 py-0.5 text-center text-[11px] font-medium text-white">
                  {t('shop.pos.lowStockBadge')}
                </span>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-1 p-2">
              <span className="line-clamp-2 text-sm font-medium text-text-primary">{p.nameAr}</span>
              <div className="mt-auto flex items-center justify-between">
                <MoneyDisplay amount={p.basePrice} size="sm" />
                {stock.qty !== null && !disabled && (
                  <span className={`text-xs ${stock.isLow ? 'font-medium text-status-warning' : 'text-text-secondary'}`}>
                    {t('shop.pos.stockCount', { count: stock.qty })}
                  </span>
                )}
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}

function CartPanel({
  locations,
  locationId,
  setLocationId,
  selectedCustomer,
  setSelectedCustomer,
  customerSearch,
  setCustomerSearch,
  customerResults,
  cart,
  updateQuantity,
  removeLine,
  subtotal,
  partialPayment,
  setPartialPayment,
  paymentAmountInput,
  setPaymentAmountInput,
  outstandingPreview,
  paymentMethod,
  setPaymentMethod,
  error,
  lastSetupNotice,
  isPending,
  onCompleteSale,
}: {
  locations: LocationOption[]
  locationId: string
  setLocationId: (v: string) => void
  selectedCustomer: CustomerOption | null
  setSelectedCustomer: (c: CustomerOption | null) => void
  customerSearch: string
  setCustomerSearch: (v: string) => void
  customerResults: CustomerOption[]
  cart: CartLine[]
  updateQuantity: (idx: number, delta: number) => void
  removeLine: (idx: number) => void
  subtotal: number
  partialPayment: boolean
  setPartialPayment: (v: boolean) => void
  paymentAmountInput: string
  setPaymentAmountInput: (v: string) => void
  outstandingPreview: number
  paymentMethod: string
  setPaymentMethod: (v: string) => void
  error: string | null
  lastSetupNotice: string | null
  isPending: boolean
  onCompleteSale: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-secondary">{t('shop.pos.locationLabel')}</label>
        <Select value={locationId} onValueChange={setLocationId}>
          <SelectTrigger><SelectValue placeholder={t('shop.pos.locationPlaceholder')} /></SelectTrigger>
          <SelectContent>
            {locations.map((l) => (
              <SelectItem key={l.locationId} value={l.locationId}>{l.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-secondary">{t('shop.pos.customerLabel')}</label>
        {selectedCustomer ? (
          <div className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
            <span>{selectedCustomer.fullName ?? selectedCustomer.mobileDisplay}</span>
            <Button variant="ghost" size="sm" onClick={() => setSelectedCustomer(null)}>{t('common.change')}</Button>
          </div>
        ) : (
          <>
            <Input
              placeholder={t('shop.pos.searchCustomer')}
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
            />
            {customerResults.length > 0 && (
              <div className="flex flex-col gap-1 rounded-md border border-border">
                {customerResults.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { setSelectedCustomer(c); setCustomerSearch('') }}
                    className="p-2 text-start text-sm hover:bg-surface-hover"
                  >
                    {c.fullName ?? c.mobileDisplay}
                    {c.fullName && c.mobileDisplay && <span className="text-text-secondary" dir="ltr"> — {c.mobileDisplay}</span>}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {cart.map((l, idx) => (
          <div key={`${l.productId}-${l.variantId}`} className="flex items-center justify-between gap-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate">{l.productName}{l.variantLabel ? ` (${l.variantLabel})` : ''}</p>
              <MoneyDisplay amount={l.displayPrice * l.quantity} size="sm" />
            </div>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="size-9" onClick={() => updateQuantity(idx, -1)}><Minus className="size-3.5" /></Button>
              <span className="w-6 text-center tabular-nums">{l.quantity}</span>
              <Button variant="outline" size="icon" className="size-9" onClick={() => updateQuantity(idx, 1)}><Plus className="size-3.5" /></Button>
              <Button variant="ghost" size="icon" className="size-9" onClick={() => removeLine(idx)}><Trash2 className="size-3.5" /></Button>
            </div>
          </div>
        ))}
        {cart.length === 0 && <p className="py-4 text-center text-sm text-text-secondary">{t('shop.pos.cartEmpty')}</p>}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-2">
        <span className="text-sm font-medium">{t('shop.pos.subtotal')}</span>
        <MoneyDisplay amount={subtotal} size="md" />
      </div>

      <div className="flex items-center justify-between">
        <label htmlFor="shop-pos-partial-toggle" className="text-sm font-medium text-text-secondary">
          {t('shop.pos.partialPaymentLabel')}
        </label>
        <input
          id="shop-pos-partial-toggle"
          type="checkbox"
          checked={partialPayment}
          onChange={(e) => { setPartialPayment(e.target.checked); setPaymentAmountInput('') }}
          className="size-4"
        />
      </div>
      {partialPayment && (
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('shop.pos.paidNowLabel')}</label>
          <Input
            type="number"
            min="0.01"
            step="0.01"
            max={subtotal || undefined}
            value={paymentAmountInput}
            onChange={(e) => setPaymentAmountInput(e.target.value)}
          />
          <p className="text-xs text-text-secondary">
            {t('shop.pos.outstandingPreview', { amount: outstandingPreview.toFixed(2) })}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-secondary">{t('shop.pos.paymentMethodLabel')}</label>
        <Select value={paymentMethod} onValueChange={setPaymentMethod}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="cash">{t('shop.pos.methodCash')}</SelectItem>
            <SelectItem value="card">{t('shop.pos.methodCard')}</SelectItem>
            <SelectItem value="bank_transfer">{t('shop.pos.methodBankTransfer')}</SelectItem>
            <SelectItem value="wallet">{t('shop.pos.methodWallet')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      {lastSetupNotice && <p className="text-sm text-status-success">{lastSetupNotice}</p>}

      <Button disabled={isPending} className="h-11" onClick={onCompleteSale}>
        {isPending ? t('shop.pos.completing') : t('shop.pos.completeSale')}
      </Button>
    </div>
  )
}
