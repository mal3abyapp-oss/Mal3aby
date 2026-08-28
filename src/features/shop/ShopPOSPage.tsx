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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { ProductThumb } from '@/features/shop/shop-media'
import { CustomerSelector, type SelectedCustomer } from '@/components/ui/customer-selector'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Trash2, Plus, Minus, ScanBarcode, ShoppingCart, Sparkles, User, PauseCircle, Percent, Banknote, Printer, CheckCircle2 } from 'lucide-react'
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
// COMMERCE PRO C2 (2026-08-28) -- POS rebuild (category strip,
// image-forward product cards, barcode input, responsive layout). See
// COMMERCE_C2_POS_REBUILD_REPORT.md.
//
// COMMERCE PRO C3 (2026-08-28) -- Cart UX, customer selection, payment
// panel, discounts, hold/resume. See COMMERCE_PRO_UPGRADE_PLAN.md
// Section 5 (Phase C3) and COMMERCE_C3_CART_PAYMENT_REPORT.md for the
// full account. Cart line rendering (thumbnail/qty input/line total/
// remove/clear-with-confirm), stock-limit UX feedback, a real discount
// UI wired to create_shop_sale's new p_discount_amount/p_discount_reason
// params, a real payment-method-controls panel sourced from
// payment_method_configs (cash tender/change, sequential multi-payment
// via record_payment), a single post-sale completion panel, and
// Hold/Resume (non-canonical draft cart, never touches
// invoices/payments/inventory) are all new in this phase. The
// create_shop_sale item-array shape and price-preview-only
// architecture above are UNCHANGED.
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

interface LocationOption {
  locationId: string
  name: string
}

interface PaymentMethodConfig {
  id: string
  underlyingMethod: string
  provider: string | null
  nameAr: string
  nameEn: string
  instructionsAr: string | null
  instructionsEn: string | null
  isActive: boolean
  displayOrder: number
}

interface CartLine {
  productId: string
  productName: string
  variantId: string | null
  variantLabel: string | null
  quantity: number
  displayPrice: number
  imageUrl: string | null
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

// Best-effort aggregate on-hand stock, keyed by product_id and by
// product_id::variant_id, across every location -- same fail-open
// pattern as ShopProductsPage.tsx's fetchStockByProduct (Phase C1).
// Requires inventory.view, a permission distinct from shop.view/
// shop.sale.create; a cashier role that can sell but not view
// inventory detail is a real, intentional combination, so a failure
// here must never block the sell screen from rendering -- stock
// badges/limits are an enrichment, not the page's core purpose or its
// real enforcement boundary (create_shop_sale's own server-side stock
// check, via _apply_shop_inventory_movement_internal, is that boundary
// -- this is UX-layer feedback only, matching the same "defense in
// depth, not the security boundary" framing C2 used for the
// out-of-stock card disable).
interface StockMap {
  byProduct: Record<string, number>
  byVariant: Record<string, number>
}
async function fetchStock(clubId: string): Promise<StockMap | null> {
  const { data, error } = await supabase.rpc('get_shop_inventory_balances', { p_club_id: clubId })
  if (error) return null
  const byProduct: Record<string, number> = {}
  const byVariant: Record<string, number> = {}
  for (const row of data ?? []) {
    byProduct[row.product_id] = (byProduct[row.product_id] ?? 0) + Number(row.on_hand)
    if (row.variant_id) {
      const key = `${row.product_id}:${row.variant_id}`
      byVariant[key] = (byVariant[key] ?? 0) + Number(row.on_hand)
    }
  }
  return { byProduct, byVariant }
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
// page-level error -- same fail-open contract as fetchStock.
async function fetchTopProductIds(clubId: string): Promise<TopProductRow[] | null> {
  const { data, error } = await supabase.rpc('get_shop_top_products', { p_club_id: clubId, p_limit: 12 })
  if (error) return null
  return (data ?? []).map((r) => ({ productId: r.product_id, unitsSold: Number(r.units_sold) }))
}

// Payment methods -- sourced from the club's real configured
// payment_method_configs (Master Payment Directive #82), never a
// hardcoded CASH/CARD/INSTAPAY/WALLET/BANK/ONLINE list. Only
// is_active methods are shown. Read directly against the table (no
// dedicated list RPC exists for this -- confirmed by grep before
// writing this page; BillingPage.tsx's own PaymentMethodsCard.tsx
// reads the table the same way), relying on the table's own
// `payment_method_configs_select_club_staff` RLS policy (any club
// staff member may SELECT, no extra permission needed to see the
// list at checkout -- matches customer_visible screening being a
// portal/customer-facing concern only, not a staff one).
async function fetchPaymentMethods(clubId: string): Promise<PaymentMethodConfig[]> {
  const { data, error } = await supabase
    .from('payment_method_configs')
    .select('id, underlying_method, provider, name_ar, name_en, instructions_ar, instructions_en, is_active, display_order')
    .eq('club_id', clubId)
    .eq('is_active', true)
    .order('display_order')
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id, underlyingMethod: r.underlying_method, provider: r.provider, nameAr: r.name_ar, nameEn: r.name_en,
    instructionsAr: r.instructions_ar, instructionsEn: r.instructions_en, isActive: r.is_active, displayOrder: r.display_order,
  }))
}

interface HeldSaleRow {
  heldSaleId: string
  customerId: string | null
  customerName: string | null
  heldByName: string | null
  heldAt: string
  note: string | null
  itemCount: number
  totalQuantity: number
}
async function fetchHeldSales(clubId: string): Promise<HeldSaleRow[]> {
  const { data, error } = await supabase.rpc('list_held_shop_sales', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({
    heldSaleId: r.held_sale_id, customerId: r.customer_id, customerName: r.customer_name, heldByName: r.held_by_name,
    heldAt: r.held_at, note: r.note, itemCount: Number(r.item_count), totalQuantity: Number(r.total_quantity),
  }))
}

const BEST_SELLERS_CHIP = '__best_sellers__'
const ALL_PRODUCTS_CHIP = '__all__'

export function ShopPOSPage() {
  const { t } = useTranslation()
  const { currentClubId, currentMembership } = useAuth()
  const queryClient = useQueryClient()
  const canDiscount = (currentMembership?.permissionKeys ?? []).includes('shop.discount.apply')

  const [productSearch, setProductSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>(ALL_PRODUCTS_CHIP)
  const [pickingProduct, setPickingProduct] = useState<ProductOption | null>(null)
  const [cart, setCart] = useState<CartLine[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(null)
  const [isWalkIn, setIsWalkIn] = useState(false)
  const [locationId, setLocationId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [barcodeInput, setBarcodeInput] = useState('')
  const [barcodeNotFound, setBarcodeNotFound] = useState<string | null>(null)
  const [mobileCartOpen, setMobileCartOpen] = useState(false)
  const [clearCartConfirmOpen, setClearCartConfirmOpen] = useState(false)
  const [heldSalesOpen, setHeldSalesOpen] = useState(false)
  const [holdNote, setHoldNote] = useState('')
  const [holdDialogOpen, setHoldDialogOpen] = useState(false)
  const [completedSale, setCompletedSale] = useState<CompletedSale | null>(null)

  // Discount state -- fixed amount OR percentage, never both applied at
  // once (the toggle switches the interpretation of discountInput, the
  // *amount actually sent* is always resolved to a single numeric value
  // before calling create_shop_sale).
  const [discountEnabled, setDiscountEnabled] = useState(false)
  const [discountMode, setDiscountMode] = useState<'amount' | 'percent'>('amount')
  const [discountInput, setDiscountInput] = useState('')
  const [discountReason, setDiscountReason] = useState('')

  // Payment state -- a primary method + amount, and an optional second
  // "split-tender" line collected via record_payment after
  // create_shop_sale succeeds (plan Section 5 decision: sequential RPC
  // calls, not a widened create_shop_sale transaction).
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null)
  const [cashReceivedInput, setCashReceivedInput] = useState('')
  const [splitEnabled, setSplitEnabled] = useState(false)
  const [splitAmountInput, setSplitAmountInput] = useState('')
  const [splitMethodId, setSplitMethodId] = useState<string | null>(null)

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
  const { data: stock } = useQuery({
    queryKey: ['shop-pos-stock', currentClubId],
    queryFn: () => fetchStock(currentClubId as string),
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
  const { data: paymentMethods = [] } = useQuery({
    queryKey: ['shop-pos-payment-methods', currentClubId],
    queryFn: () => fetchPaymentMethods(currentClubId as string),
    enabled: !!currentClubId,
  })
  const { data: heldSales = [], refetch: refetchHeldSales } = useQuery({
    queryKey: ['shop-pos-held-sales', currentClubId],
    queryFn: () => fetchHeldSales(currentClubId as string),
    enabled: !!currentClubId && heldSalesOpen,
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
    if (!stock || !product) return { qty: null, isOut: false, isLow: false, reorderLevel: product?.reorderLevel ?? null }
    const qty = stock.byProduct[productId] ?? 0
    const isOut = qty <= 0
    const isLow = !isOut && product.reorderLevel !== null && qty <= product.reorderLevel
    return { qty, isOut, isLow, reorderLevel: product.reorderLevel }
  }

  // Line-level available stock -- variant-specific when the line has a
  // variant (falls back to the product-level aggregate only when no
  // variant-level row exists, e.g. a variant just added with no
  // separate balance row yet). `null` means "unknown" (permission
  // denied/RPC failed) -- never treated as zero, so cart edits are not
  // wrongly blocked by a missing-data state.
  function availableFor(productId: string, variantId: string | null): number | null {
    if (!stock) return null
    if (variantId) {
      const key = `${productId}:${variantId}`
      if (key in stock.byVariant) return stock.byVariant[key] ?? null
    }
    return productId in stock.byProduct ? (stock.byProduct[productId] ?? null) : null
  }

  function addToCart(product: ProductOption, variant: VariantOption | null) {
    const available = availableFor(product.productId, variant?.variantId ?? null)
    setCart((current) => {
      const existingIdx = current.findIndex((l) => l.productId === product.productId && l.variantId === (variant?.variantId ?? null))
      const existing = existingIdx >= 0 ? current[existingIdx] : undefined
      const nextQty = (existing?.quantity ?? 0) + 1
      if (available !== null && nextQty > available) {
        setError(t('shop.pos.stockLimitReached', { name: product.nameAr, available }))
        return current
      }
      setError(null)
      if (existing) {
        const next = [...current]
        next[existingIdx] = { ...existing, quantity: nextQty }
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
          imageUrl: product.imageUrl,
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
      const available = availableFor(line.productId, line.variantId)
      if (available !== null && q > available) {
        setError(t('shop.pos.stockLimitReached', { name: line.productName, available }))
        return current
      }
      setError(null)
      const next = [...current]
      next[idx] = { ...line, quantity: q }
      return next
    })
  }

  // Direct quantity edit (a number input, not just +/-) -- respects the
  // exact same stock-limit validation as the +/- buttons. A blank or
  // invalid value is left as-is (no destructive coercion to 0/1 while
  // the cashier is mid-edit); only a valid positive number is applied.
  function setQuantityDirect(idx: number, raw: string) {
    const parsed = Number(raw)
    if (!raw.trim() || !Number.isFinite(parsed)) return
    setCart((current) => {
      const line = current[idx]
      if (!line) return current
      if (parsed <= 0) return current.filter((_, i) => i !== idx)
      const available = availableFor(line.productId, line.variantId)
      if (available !== null && parsed > available) {
        setError(t('shop.pos.stockLimitReached', { name: line.productName, available }))
        const next = [...current]
        next[idx] = { ...line, quantity: available }
        return next
      }
      setError(null)
      const next = [...current]
      next[idx] = { ...line, quantity: parsed }
      return next
    })
  }

  function removeLine(idx: number) {
    setCart((current) => current.filter((_, i) => i !== idx))
  }

  function clearCart() {
    setCart([])
    setClearCartConfirmOpen(false)
    setDiscountEnabled(false)
    setDiscountInput('')
    setDiscountReason('')
  }

  // ------------------------------------------------------------
  // Barcode scan input. Unchanged from Phase C2 -- see that phase's
  // report for the full reasoning (refocus-after-every-scan via ref,
  // no debounce needed, exact/variant match, out-of-stock feedback).
  // ------------------------------------------------------------
  function refocusBarcodeInput() {
    window.setTimeout(() => barcodeInputRef.current?.focus(), 0)
  }

  function handleBarcodeSubmit() {
    const code = barcodeInput.trim()
    if (!code) return
    setBarcodeNotFound(null)

    const productMatch = products.find((p) => p.barcode === code)
    if (productMatch) {
      if (productMatch.hasVariants) {
        setPickingProduct(productMatch)
        setBarcodeInput('')
        refocusBarcodeInput()
        return
      }
      const s = stockFor(productMatch.productId)
      if (s.isOut) {
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

    void (async () => {
      for (const product of products) {
        if (!product.hasVariants) continue
        const productVariants = await fetchVariants(product.productId)
        const variantMatch = productVariants.find((v) => v.barcode === code)
        if (variantMatch) {
          const s = stockFor(product.productId)
          if (s.isOut) {
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

  // Discount resolution -- percent is converted to an amount here, once,
  // client-side for display purposes only; create_shop_sale re-validates
  // (amount cannot exceed subtotal) and is the actual source of truth
  // for what gets persisted. Clamped to [0, subtotal] so a stray > 100%
  // entry or a fixed amount bigger than the cart can never show a
  // negative total in the preview.
  const discountAmount = useMemo(() => {
    if (!discountEnabled || !canDiscount) return 0
    const raw = Number(discountInput || 0)
    if (!Number.isFinite(raw) || raw <= 0) return 0
    const amount = discountMode === 'percent' ? subtotal * (raw / 100) : raw
    return Math.min(Math.max(amount, 0), subtotal)
  }, [discountEnabled, canDiscount, discountInput, discountMode, subtotal])

  const total = Math.max(subtotal - discountAmount, 0)

  const primaryAmount = splitEnabled ? Math.max(total - Number(splitAmountInput || 0), 0) : total
  const splitAmount = splitEnabled ? Number(splitAmountInput || 0) : 0
  const cashReceived = Number(cashReceivedInput || 0)
  const selectedMethod = paymentMethods.find((m) => m.id === selectedMethodId) ?? null
  const isPrimaryCash = selectedMethod?.underlyingMethod === 'cash'
  // Change is cashier-facing arithmetic ONLY -- never sent to the
  // server, never included in p_payment_amount, never written as a
  // payment allocation or any canonical row (hard invariant, plan
  // Non-negotiable Invariant #3). Computed purely for on-screen display.
  const changeDue = isPrimaryCash ? Math.max(cashReceived - primaryAmount, 0) : 0

  const saleMutation = useMutation({
    mutationFn: async () => {
      if (!selectedMethod) throw new Error(t('shop.pos.paymentMethodRequired'))
      const items = cart.map((l) => ({ product_id: l.productId, variant_id: l.variantId, quantity: l.quantity }))
      const { data, error: err } = await supabase.rpc('create_shop_sale', {
        p_club_id: currentClubId as string,
        p_location_id: locationId,
        p_customer_id: selectedCustomer!.id,
        p_items: items,
        p_payment_method: selectedMethod.underlyingMethod,
        p_payment_reference: undefined,
        p_idempotency_key: crypto.randomUUID(),
        p_payment_amount: primaryAmount,
        p_discount_amount: discountAmount > 0 ? discountAmount : undefined,
        p_discount_reason: discountAmount > 0 ? (discountReason.trim() || undefined) : undefined,
      })
      if (err) throw err
      const saleId = data as string
      // Sequential split-tender (plan Section 5 decision): the sale and
      // its first payment are already fully committed at this point --
      // stock deducted, invoice issued, first payment recorded. A
      // second payment line, if configured, is now collected via the
      // already-hardened record_payment() RPC against the SAME invoice.
      // If this second call fails, the sale itself is NOT lost or rolled
      // back -- it already succeeded -- so the failure is surfaced
      // distinctly (see onError below / partialPaymentFailure state)
      // rather than presented as "the whole sale failed."
      let invoiceId: string | null = null
      let invoiceNumber: string | null = null
      {
        const { data: saleRow } = await supabase.from('shop_sales').select('invoice_id').eq('id', saleId).maybeSingle()
        invoiceId = saleRow?.invoice_id ?? null
        if (invoiceId) {
          const { data: invRow } = await supabase.from('invoices').select('invoice_number').eq('id', invoiceId).maybeSingle()
          invoiceNumber = invRow?.invoice_number ?? null
        }
      }

      let splitPaymentFailed: string | null = null
      if (splitEnabled && splitAmount > 0 && invoiceId) {
        if (!splitMethodId) {
          splitPaymentFailed = t('shop.pos.splitMethodRequired')
        } else {
          const splitMethod = paymentMethods.find((m) => m.id === splitMethodId)
          if (splitMethod) {
            const { error: splitErr } = await supabase.rpc('record_payment', {
              p_invoice_id: invoiceId,
              p_amount: splitAmount,
              p_method: splitMethod.underlyingMethod,
              p_reference: undefined,
              p_idempotency_key: crypto.randomUUID(),
            })
            if (splitErr) {
              splitPaymentFailed = translateSupabaseError(splitErr, t('shop.pos.splitPaymentError'))
            }
          }
        }
      }

      return { saleId, invoiceId, invoiceNumber, total, splitPaymentFailed }
    },
    onSuccess: (result) => {
      setCart([])
      setSelectedCustomer(null)
      setIsWalkIn(false)
      setError(null)
      setMobileCartOpen(false)
      setDiscountEnabled(false)
      setDiscountInput('')
      setDiscountReason('')
      setSplitEnabled(false)
      setSplitAmountInput('')
      setSplitMethodId(null)
      setCashReceivedInput('')
      setCompletedSale({
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        total: result.total,
        splitPaymentFailed: result.splitPaymentFailed,
      })
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
    if (!selectedMethodId) { setError(t('shop.pos.paymentMethodRequired')); return }
    if (splitEnabled && (splitAmount <= 0 || splitAmount >= total)) {
      setError(t('shop.pos.partialAmountInvalid'))
      return
    }
    if (splitEnabled && !splitMethodId) { setError(t('shop.pos.splitMethodRequired')); return }
    saleMutation.mutate()
  }

  const walkInMutation = useMutation({
    mutationFn: async () => {
      const { data, error: err } = await supabase.rpc('get_or_create_shop_walk_in_customer', { p_club_id: currentClubId as string })
      if (err) throw err
      return data as string
    },
    onSuccess: (id) => {
      setSelectedCustomer({ id, fullName: t('shop.pos.walkInCustomer'), mobileDisplay: null })
      setIsWalkIn(true)
    },
    onError: (err) => setError(translateSupabaseError(err, t('shop.pos.walkInError'))),
  })

  const holdMutation = useMutation({
    mutationFn: async () => {
      const items = cart.map((l) => ({ product_id: l.productId, variant_id: l.variantId, quantity: l.quantity }))
      // The walk-in customer is a real customers row (lazily created by
      // get_or_create_shop_walk_in_customer) -- no reason to drop it on
      // hold; passing it through means resuming correctly re-attaches
      // the same walk-in identity rather than leaving the resumed cart
      // with no customer at all.
      const { error: err } = await supabase.rpc('hold_shop_sale', {
        p_club_id: currentClubId as string,
        p_items: items,
        p_customer_id: selectedCustomer?.id || undefined,
        p_note: holdNote.trim() || undefined,
      })
      if (err) throw err
    },
    onSuccess: () => {
      setCart([])
      setSelectedCustomer(null)
      setIsWalkIn(false)
      setHoldNote('')
      setHoldDialogOpen(false)
      setError(null)
    },
    onError: (err) => setError(translateSupabaseError(err, t('shop.pos.holdError'))),
  })

  const resumeMutation = useMutation({
    mutationFn: async (heldSaleId: string) => {
      const { data, error: err } = await supabase.rpc('resume_shop_sale', { p_held_sale_id: heldSaleId })
      if (err) throw err
      const rows = data ?? []
      // Fetch the REAL customer row rather than showing a generic
      // placeholder label -- same "always fetch, never fabricate the
      // displayed identity" rule CustomerSelector's own create/dup-match
      // paths already follow.
      const customerId = rows[0]?.customer_id ?? null
      let customer: SelectedCustomer | null = null
      if (customerId) {
        const { data: c } = await supabase.from('customers').select('id, full_name, mobile_display').eq('id', customerId).maybeSingle()
        if (c) customer = { id: c.id, fullName: c.full_name, mobileDisplay: c.mobile_display }
      }
      return { rows, customer }
    },
    onSuccess: ({ rows, customer }, heldSaleId) => {
      if (rows.length === 0) return
      const newLines: CartLine[] = rows.map((r) => ({
        productId: r.product_id,
        productName: r.product_name_ar,
        variantId: r.variant_id,
        variantLabel: [r.variant_size, r.variant_color].filter(Boolean).join(' / ') || null,
        quantity: Number(r.quantity),
        displayPrice: Number(r.unit_price),
        // resume_shop_sale doesn't return image_url (it only re-derives
        // pricing/naming data, per the RPC's own "never trust cached
        // price" comment) -- enrich from the already-loaded product
        // list when the product is still present there; falls back to
        // no thumbnail (real placeholder, not a broken image) rather
        // than erroring if the product was archived since being held.
        imageUrl: products.find((p) => p.productId === r.product_id)?.imageUrl ?? null,
      }))
      setCart(newLines)
      if (customer) {
        setSelectedCustomer(customer)
        setIsWalkIn(false)
      }
      // A product/variant can be archived AFTER a sale was held but
      // BEFORE it's resumed. resume_shop_sale still loads it back
      // faithfully (it's a draft snapshot, not a live-availability
      // check) -- but checkout would then fail confusingly at
      // create_shop_sale with a generic "not found or inactive" error.
      // Surface that clearly right away instead, since the cashier just
      // took a successful-looking action.
      const inactiveNames = rows
        .filter((r) => r.product_status !== 'active' || (r.variant_id && r.variant_status !== 'active'))
        .map((r) => r.product_name_ar)
      if (inactiveNames.length > 0) {
        setError(t('shop.pos.resumedWithInactiveItems', { names: inactiveNames.join(', ') }))
      } else {
        setError(null)
      }
      setHeldSalesOpen(false)
      setMobileCartOpen(true)
      void queryClient.invalidateQueries({ queryKey: ['shop-pos-held-sales', currentClubId] })
      void refetchHeldSales()
      void heldSaleId
    },
    onError: (err) => setError(translateSupabaseError(err, t('shop.pos.resumeError'))),
  })

  const discardHeldMutation = useMutation({
    mutationFn: async (heldSaleId: string) => {
      const { error: err } = await supabase.rpc('discard_held_shop_sale', { p_held_sale_id: heldSaleId })
      if (err) throw err
    },
    onSuccess: () => void refetchHeldSales(),
    onError: (err) => setError(translateSupabaseError(err, t('shop.pos.discardHeldError'))),
  })

  if (completedSale) {
    return (
      <div>
        <PageHeader title={t('shop.pos.title')} description={t('shop.pos.description')} />
        <SaleCompletePanel sale={completedSale} onNewSale={() => setCompletedSale(null)} />
      </div>
    )
  }

  const cartPanel = (
    <CartPanel
      clubId={currentClubId as string}
      locations={locations}
      locationId={locationId}
      setLocationId={setLocationId}
      selectedCustomer={selectedCustomer}
      setSelectedCustomer={(c) => { setSelectedCustomer(c); setIsWalkIn(false) }}
      isWalkIn={isWalkIn}
      onWalkIn={() => walkInMutation.mutate()}
      walkInPending={walkInMutation.isPending}
      cart={cart}
      updateQuantity={updateQuantity}
      setQuantityDirect={setQuantityDirect}
      removeLine={removeLine}
      onClearCart={() => setClearCartConfirmOpen(true)}
      subtotal={subtotal}
      canDiscount={canDiscount}
      discountEnabled={discountEnabled}
      setDiscountEnabled={setDiscountEnabled}
      discountMode={discountMode}
      setDiscountMode={setDiscountMode}
      discountInput={discountInput}
      setDiscountInput={setDiscountInput}
      discountReason={discountReason}
      setDiscountReason={setDiscountReason}
      discountAmount={discountAmount}
      total={total}
      paymentMethods={paymentMethods}
      selectedMethodId={selectedMethodId}
      setSelectedMethodId={setSelectedMethodId}
      cashReceivedInput={cashReceivedInput}
      setCashReceivedInput={setCashReceivedInput}
      isPrimaryCash={isPrimaryCash}
      changeDue={changeDue}
      primaryAmount={primaryAmount}
      splitEnabled={splitEnabled}
      setSplitEnabled={setSplitEnabled}
      splitAmountInput={splitAmountInput}
      setSplitAmountInput={setSplitAmountInput}
      splitMethodId={splitMethodId}
      setSplitMethodId={setSplitMethodId}
      error={error}
      isPending={saleMutation.isPending}
      onCompleteSale={handleCompleteSale}
      onOpenHold={() => setHoldDialogOpen(true)}
      onOpenHeldSales={() => setHeldSalesOpen(true)}
      heldSalesCount={heldSales.length}
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
            <Button
              type="button"
              variant="outline"
              className="h-11 shrink-0"
              onClick={() => setHeldSalesOpen(true)}
            >
              <PauseCircle className="me-2 size-4" aria-hidden="true" />
              {t('shop.pos.heldSales')}
              {heldSales.length > 0 && (
                <span className="ms-1.5 rounded-full bg-surface-muted px-1.5 text-xs tabular-nums">{heldSales.length}</span>
              )}
            </Button>
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
            below instead. */}
        <div className="hidden lg:block">{cartPanel}</div>
      </div>

      {/* Mobile cart access: a fixed bottom bar showing the running
          item count/subtotal, opening the full cart in a Sheet. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface p-3 shadow-lg lg:hidden">
        <Button className="h-12 w-full text-base" onClick={() => setMobileCartOpen(true)}>
          <ShoppingCart className="me-2 size-5" aria-hidden="true" />
          {cart.length > 0
            ? t('shop.pos.viewCartWithTotal', { count: cart.reduce((s, l) => s + l.quantity, 0) })
            : t('shop.pos.viewCart')}
          {cart.length > 0 && (
            <span className="ms-auto">
              <MoneyDisplay amount={total} size="sm" />
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

      {/* Clear-cart confirmation -- a real confirm step, not a silent
          instant-clear, per the task's explicit requirement. */}
      <Dialog open={clearCartConfirmOpen} onOpenChange={setClearCartConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('shop.pos.clearCartConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('shop.pos.clearCartConfirmDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearCartConfirmOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={clearCart}>{t('shop.pos.clearCartConfirmAction')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hold-sale note dialog. */}
      <Dialog open={holdDialogOpen} onOpenChange={setHoldDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('shop.pos.holdSaleTitle')}</DialogTitle>
            <DialogDescription>{t('shop.pos.holdSaleDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            placeholder={t('shop.pos.holdNotePlaceholder')}
            value={holdNote}
            onChange={(e) => setHoldNote(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setHoldDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button disabled={holdMutation.isPending} onClick={() => holdMutation.mutate()}>
              {holdMutation.isPending ? t('shop.pos.holding') : t('shop.pos.holdSaleAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Held Sales drawer -- resume loads the draft back into the
          active cart and consumes the held-sale row server-side; it
          does not itself create a shop_sales row. */}
      <Sheet open={heldSalesOpen} onOpenChange={setHeldSalesOpen}>
        <SheetContent side="left" className="flex w-full flex-col gap-3 overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t('shop.pos.heldSales')}</SheetTitle>
          </SheetHeader>
          {heldSales.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-secondary">{t('shop.pos.noHeldSales')}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {heldSales.map((h) => (
                <div key={h.heldSaleId} className="flex flex-col gap-1.5 rounded-md border border-border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {h.customerName ?? t('shop.pos.noCustomerOnHold')}
                    </span>
                    <span className="text-xs text-text-secondary">{new Date(h.heldAt).toLocaleTimeString()}</span>
                  </div>
                  <p className="text-xs text-text-secondary">
                    {t('shop.pos.heldSaleSummary', { items: h.itemCount, quantity: h.totalQuantity })}
                    {h.heldByName ? ` — ${h.heldByName}` : ''}
                  </p>
                  {h.note && <p className="text-xs italic text-text-secondary">{h.note}</p>}
                  <div className="flex gap-2">
                    <Button size="sm" className="flex-1" disabled={resumeMutation.isPending} onClick={() => resumeMutation.mutate(h.heldSaleId)}>
                      {t('shop.pos.resumeSale')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={discardHeldMutation.isPending} onClick={() => discardHeldMutation.mutate(h.heldSaleId)}>
                      {t('shop.pos.discardHold')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
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
        const s = stockFor(p.productId)
        const disabled = s.isOut
        return (
          <button
            key={p.productId}
            type="button"
            disabled={disabled}
            onClick={() => !disabled && onSelect(p)}
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
              {!disabled && s.isLow && (
                <span className="absolute inset-x-1 top-1 rounded-md bg-status-warning/90 px-1.5 py-0.5 text-center text-[11px] font-medium text-white">
                  {t('shop.pos.lowStockBadge')}
                </span>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-1 p-2">
              <span className="line-clamp-2 text-sm font-medium text-text-primary">{p.nameAr}</span>
              <div className="mt-auto flex items-center justify-between">
                <MoneyDisplay amount={p.basePrice} size="sm" />
                {s.qty !== null && !disabled && (
                  <span className={`text-xs ${s.isLow ? 'font-medium text-status-warning' : 'text-text-secondary'}`}>
                    {t('shop.pos.stockCount', { count: s.qty })}
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

interface CompletedSale {
  invoiceId: string | null
  invoiceNumber: string | null
  total: number
  splitPaymentFailed: string | null
}

// Post-sale completion panel -- a single clear panel, not a stack of
// dialogs (explicit plan instruction). "Print receipt"/"print invoice"
// here deliberately link to the REAL existing invoice/payment view
// (BillingPage.tsx via /app/finance/payments?invoice=..., confirmed by
// grep as the actual established navigation pattern every other module
// uses to reach an invoice) rather than a dedicated one-click print
// action -- BillingPage.tsx's own print-target/data-print-size/
// window.print() mechanism (Section 6 of the plan's own current-state
// findings) lives inside that page today, keyed off finding the right
// payment/invoice card on screen, not a query-param that auto-opens a
// receipt view. A DEDICATED thermal-80mm-receipt / one-click Shop
// invoice print is explicitly Phase C4's scope ("Invoice A4 redesign,
// thermal 80mm receipt, payment receipt") -- not invented here. These
// buttons open the real invoice so the cashier can use the existing
// print button there; they are labeled "print" because that is the
// cashier's actual next step, not because this page performs printing
// itself.
function SaleCompletePanel({ sale, onNewSale }: { sale: CompletedSale; onNewSale: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-md border border-border p-6 text-center">
      <CheckCircle2 className="size-12 text-status-success" aria-hidden="true" />
      <div>
        <p className="text-lg font-semibold">{t('shop.pos.saleCompleted')}</p>
        {sale.invoiceNumber && (
          <p className="text-sm text-text-secondary" dir="ltr">{sale.invoiceNumber}</p>
        )}
      </div>
      <MoneyDisplay amount={sale.total} size="lg" />

      {sale.splitPaymentFailed && (
        <div role="alert" className="w-full rounded-md border border-status-danger/40 bg-status-danger/10 p-3 text-start text-sm text-status-danger">
          {t('shop.pos.saleCompletedSplitFailed')} {sale.splitPaymentFailed}
        </div>
      )}

      <div className="flex w-full flex-col gap-2 sm:flex-row">
        {sale.invoiceId && (
          <Button variant="outline" className="flex-1" asChild>
            <a href={`/app/finance/payments?invoice=${sale.invoiceId}`} target="_blank" rel="noreferrer">
              <Printer className="me-2 size-4" aria-hidden="true" />
              {t('shop.pos.printReceipt')}
            </a>
          </Button>
        )}
      </div>
      <Button className="h-11 w-full" onClick={onNewSale}>{t('shop.pos.newSale')}</Button>
    </div>
  )
}

function CartPanel({
  clubId,
  locations,
  locationId,
  setLocationId,
  selectedCustomer,
  setSelectedCustomer,
  isWalkIn,
  onWalkIn,
  walkInPending,
  cart,
  updateQuantity,
  setQuantityDirect,
  removeLine,
  onClearCart,
  subtotal,
  canDiscount,
  discountEnabled,
  setDiscountEnabled,
  discountMode,
  setDiscountMode,
  discountInput,
  setDiscountInput,
  discountReason,
  setDiscountReason,
  discountAmount,
  total,
  paymentMethods,
  selectedMethodId,
  setSelectedMethodId,
  cashReceivedInput,
  setCashReceivedInput,
  isPrimaryCash,
  changeDue,
  primaryAmount,
  splitEnabled,
  setSplitEnabled,
  splitAmountInput,
  setSplitAmountInput,
  splitMethodId,
  setSplitMethodId,
  error,
  isPending,
  onCompleteSale,
  onOpenHold,
  onOpenHeldSales,
  heldSalesCount,
}: {
  clubId: string
  locations: LocationOption[]
  locationId: string
  setLocationId: (v: string) => void
  selectedCustomer: SelectedCustomer | null
  setSelectedCustomer: (c: SelectedCustomer) => void
  isWalkIn: boolean
  onWalkIn: () => void
  walkInPending: boolean
  cart: CartLine[]
  updateQuantity: (idx: number, delta: number) => void
  setQuantityDirect: (idx: number, raw: string) => void
  removeLine: (idx: number) => void
  onClearCart: () => void
  subtotal: number
  canDiscount: boolean
  discountEnabled: boolean
  setDiscountEnabled: (v: boolean) => void
  discountMode: 'amount' | 'percent'
  setDiscountMode: (v: 'amount' | 'percent') => void
  discountInput: string
  setDiscountInput: (v: string) => void
  discountReason: string
  setDiscountReason: (v: string) => void
  discountAmount: number
  total: number
  paymentMethods: PaymentMethodConfig[]
  selectedMethodId: string | null
  setSelectedMethodId: (v: string) => void
  cashReceivedInput: string
  setCashReceivedInput: (v: string) => void
  isPrimaryCash: boolean
  changeDue: number
  primaryAmount: number
  splitEnabled: boolean
  setSplitEnabled: (v: boolean) => void
  splitAmountInput: string
  setSplitAmountInput: (v: string) => void
  splitMethodId: string | null
  setSplitMethodId: (v: string | null) => void
  error: string | null
  isPending: boolean
  onCompleteSale: () => void
  onOpenHold: () => void
  onOpenHeldSales: () => void
  heldSalesCount: number
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
            <span className="flex items-center gap-1.5">
              {isWalkIn && <User className="size-3.5 text-text-secondary" aria-hidden="true" />}
              {selectedCustomer.fullName ?? selectedCustomer.mobileDisplay}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setSelectedCustomer({ id: '', fullName: '', mobileDisplay: null })}>
              {t('common.change')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {/* Explicit "Walk-in Customer" option, distinct from "no
                customer selected yet" -- create_shop_sale still requires
                a real, non-null customer_id server-side, so this
                resolves (lazily creating on first use) the club's own
                system Walk-in Customer row rather than weakening that
                requirement. */}
            <Button type="button" variant="outline" size="sm" disabled={walkInPending} onClick={onWalkIn}>
              <User className="me-2 size-4" aria-hidden="true" />
              {walkInPending ? t('shop.pos.walkInLoading') : t('shop.pos.walkInCustomer')}
            </Button>
            <CustomerSelector clubId={clubId} value={null} onSelect={setSelectedCustomer} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {cart.map((l, idx) => {
          const lineTotal = l.displayPrice * l.quantity
          return (
            <div key={`${l.productId}-${l.variantId}`} className="flex items-center gap-2 text-sm">
              <ProductThumb src={l.imageUrl} alt={l.productName} className="size-11 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1">
                <p className="truncate">{l.productName}{l.variantLabel ? ` (${l.variantLabel})` : ''}</p>
                <div className="flex items-center gap-2 text-xs text-text-secondary">
                  <MoneyDisplay amount={l.displayPrice} size="sm" />
                  <span aria-hidden="true">×</span>
                  <MoneyDisplay amount={lineTotal} size="sm" tone="default" />
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="size-9" onClick={() => updateQuantity(idx, -1)} aria-label={t('shop.pos.decreaseQty')}><Minus className="size-3.5" /></Button>
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={l.quantity}
                  onChange={(e) => setQuantityDirect(idx, e.target.value)}
                  className="h-9 w-14 px-1 text-center tabular-nums"
                  aria-label={t('shop.pos.quantityFor', { name: l.productName })}
                />
                <Button variant="outline" size="icon" className="size-9" onClick={() => updateQuantity(idx, 1)} aria-label={t('shop.pos.increaseQty')}><Plus className="size-3.5" /></Button>
                <Button variant="ghost" size="icon" className="size-9" onClick={() => removeLine(idx)} aria-label={t('shop.pos.removeLine')}><Trash2 className="size-3.5" /></Button>
              </div>
            </div>
          )
        })}
        {cart.length === 0 && <p className="py-4 text-center text-sm text-text-secondary">{t('shop.pos.cartEmpty')}</p>}
      </div>

      {cart.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
          <Button variant="ghost" size="sm" onClick={onOpenHold}>
            <PauseCircle className="me-1.5 size-4" aria-hidden="true" />
            {t('shop.pos.holdSaleAction')}
          </Button>
          <Button variant="ghost" size="sm" className="text-status-danger" onClick={onClearCart}>
            <Trash2 className="me-1.5 size-4" aria-hidden="true" />
            {t('shop.pos.clearCart')}
          </Button>
        </div>
      )}
      {cart.length === 0 && heldSalesCount > 0 && (
        <Button variant="ghost" size="sm" onClick={onOpenHeldSales}>
          <PauseCircle className="me-1.5 size-4" aria-hidden="true" />
          {t('shop.pos.viewHeldSales', { count: heldSalesCount })}
        </Button>
      )}

      {/* Cart summary breakdown: Subtotal / Discount / Total, explicit
          per the task's requirement. */}
      <div className="flex flex-col gap-1 border-t border-border pt-2">
        <div className="flex items-center justify-between text-sm text-text-secondary">
          <span>{t('shop.pos.subtotal')}</span>
          <MoneyDisplay amount={subtotal} size="sm" />
        </div>
        {discountAmount > 0 && (
          <div className="flex items-center justify-between text-sm text-status-success">
            <span>{t('shop.pos.discountLabel')}</span>
            <MoneyDisplay amount={-discountAmount} size="sm" tone="success" />
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t('shop.pos.total')}</span>
          <MoneyDisplay amount={total} size="md" />
        </div>
      </div>

      {/* Discount UI -- permission-gated: hidden entirely for a cashier
          without shop.discount.apply, per the task's explicit
          instruction (not merely disabled -- a role with no discount
          capability should not even see the affordance). */}
      {canDiscount && (
        <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
          <div className="flex items-center justify-between">
            <label htmlFor="shop-pos-discount-toggle" className="flex items-center gap-1.5 text-sm font-medium text-text-secondary">
              <Percent className="size-3.5" aria-hidden="true" />
              {t('shop.pos.discountToggle')}
            </label>
            <input
              id="shop-pos-discount-toggle"
              type="checkbox"
              checked={discountEnabled}
              onChange={(e) => { setDiscountEnabled(e.target.checked); if (!e.target.checked) { setDiscountInput(''); setDiscountReason('') } }}
              className="size-4"
            />
          </div>
          {discountEnabled && (
            <>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant={discountMode === 'amount' ? 'default' : 'outline'} className="flex-1" onClick={() => setDiscountMode('amount')}>
                  {t('shop.pos.discountFixed')}
                </Button>
                <Button type="button" size="sm" variant={discountMode === 'percent' ? 'default' : 'outline'} className="flex-1" onClick={() => setDiscountMode('percent')}>
                  {t('shop.pos.discountPercent')}
                </Button>
              </div>
              <Input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder={discountMode === 'percent' ? t('shop.pos.discountPercentPlaceholder') : t('shop.pos.discountAmountPlaceholder')}
                value={discountInput}
                onChange={(e) => setDiscountInput(e.target.value)}
              />
              <Input
                placeholder={t('shop.pos.discountReasonPlaceholder')}
                value={discountReason}
                onChange={(e) => setDiscountReason(e.target.value)}
              />
            </>
          )}
        </div>
      )}

      {/* Payment method controls -- large, tappable, sourced from the
          club's real configured payment_method_configs (never a
          hardcoded static list). */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-secondary">{t('shop.pos.paymentMethodLabel')}</label>
        {paymentMethods.length === 0 ? (
          <p className="text-xs text-text-secondary">{t('shop.pos.noPaymentMethods')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {paymentMethods.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelectedMethodId(m.id)}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 rounded-md border px-2 text-center transition-colors ${
                  selectedMethodId === m.id
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-surface hover:bg-surface-muted'
                }`}
              >
                {m.underlyingMethod === 'cash' && <Banknote className="size-4" aria-hidden="true" />}
                <span className="line-clamp-1 text-sm font-medium">{m.nameAr}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {isPrimaryCash && (
        <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
          <label className="text-sm font-medium text-text-secondary">{t('shop.pos.amountReceived')}</label>
          <Input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={cashReceivedInput}
            onChange={(e) => setCashReceivedInput(e.target.value)}
          />
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">{t('shop.pos.changeDue')}</span>
            <MoneyDisplay amount={changeDue} size="md" tone={changeDue > 0 ? 'success' : 'default'} />
          </div>
        </div>
      )}

      {/* Split-tender: sequential create_shop_sale (primary amount) +
          record_payment (this remainder), per plan Section 5. */}
      <div className="flex items-center justify-between">
        <label htmlFor="shop-pos-split-toggle" className="text-sm font-medium text-text-secondary">
          {t('shop.pos.splitPaymentLabel')}
        </label>
        <input
          id="shop-pos-split-toggle"
          type="checkbox"
          checked={splitEnabled}
          onChange={(e) => { setSplitEnabled(e.target.checked); setSplitAmountInput(''); setSplitMethodId(null) }}
          className="size-4"
        />
      </div>
      {splitEnabled && (
        <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
          <label className="text-sm font-medium text-text-secondary">{t('shop.pos.splitAmountLabel')}</label>
          <Input
            type="number"
            min="0.01"
            step="0.01"
            max={total || undefined}
            value={splitAmountInput}
            onChange={(e) => setSplitAmountInput(e.target.value)}
          />
          <Select value={splitMethodId ?? ''} onValueChange={setSplitMethodId}>
            <SelectTrigger><SelectValue placeholder={t('shop.pos.splitMethodPlaceholder')} /></SelectTrigger>
            <SelectContent>
              {paymentMethods.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.nameAr}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-text-secondary">
            {t('shop.pos.splitPrimaryPreview', { amount: primaryAmount.toFixed(2) })}
          </p>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}

      <Button disabled={isPending} className="h-11" onClick={onCompleteSale}>
        {isPending ? t('shop.pos.completing') : t('shop.pos.completeSale')}
      </Button>
    </div>
  )
}
