import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyDisplay } from '@/components/ui/money-display'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Trash2, Plus, Minus } from 'lucide-react'
import { translateSupabaseError } from '@/lib/errors'

// COMMERCIAL MODULE (2026-08-26) -- the POS/reception sale screen
// (directive Section 28: Customer -> Product Search -> Variant ->
// Quantity -> Cart -> Review -> Invoice -> Payment). Client-side cart
// totals are a PREVIEW ONLY (directive Section 29) -- create_shop_sale()
// re-derives every price server-side from the live product row and
// ignores whatever unit_price this screen displays; this UI never
// sends a price to the server at all, only product_id/variant_id/
// quantity, so there is structurally nothing here to tamper with.
interface ProductOption {
  productId: string
  nameAr: string
  nameEn: string | null
  hasVariants: boolean
  basePrice: number
  status: string
}

interface VariantOption {
  variantId: string
  size: string | null
  color: string | null
  priceOverride: number | null
  status: string
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
  const { data, error } = await supabase.rpc('list_shop_products', { p_club_id: clubId, p_search: search || undefined, p_status: 'active' })
  if (error) throw error
  return (data ?? []).map((r) => ({
    productId: r.product_id, nameAr: r.name_ar, nameEn: r.name_en, hasVariants: r.has_variants, basePrice: Number(r.base_price), status: r.status,
  }))
}

async function fetchVariants(productId: string): Promise<VariantOption[]> {
  const { data, error } = await supabase.rpc('list_shop_product_variants', { p_product_id: productId })
  if (error) throw error
  return (data ?? [])
    .filter((r) => r.status === 'active')
    .map((r) => ({ variantId: r.variant_id, size: r.size, color: r.color, priceOverride: r.price_override !== null ? Number(r.price_override) : null, status: r.status }))
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

export function ShopPOSPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()

  const [productSearch, setProductSearch] = useState('')
  const [pickingProduct, setPickingProduct] = useState<ProductOption | null>(null)
  const [pickedVariantId, setPickedVariantId] = useState<string>('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [customerSearch, setCustomerSearch] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null)
  const [locationId, setLocationId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [error, setError] = useState<string | null>(null)
  const [lastSetupNotice, setLastSetupNotice] = useState<string | null>(null)

  const { data: products = [] } = useQuery({
    queryKey: ['shop-pos-products', currentClubId, productSearch],
    queryFn: () => fetchProducts(currentClubId as string, productSearch),
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
    setPickedVariantId('')
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

  const subtotal = cart.reduce((sum, l) => sum + l.displayPrice * l.quantity, 0)

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
      })
      if (err) throw err
      return data
    },
    onSuccess: () => {
      setCart([])
      setSelectedCustomer(null)
      setCustomerSearch('')
      setError(null)
      setLastSetupNotice(t('shop.pos.saleCompleted'))
      void queryClient.invalidateQueries({ queryKey: ['shop-inventory-balances'] })
    },
    onError: (err) => setError(translateSupabaseError(err, t('shop.pos.saleError'))),
  })

  function handleCompleteSale() {
    setError(null)
    if (!locationId) { setError(t('shop.pos.locationRequired')); return }
    if (!selectedCustomer) { setError(t('shop.pos.customerRequired')); return }
    if (cart.length === 0) { setError(t('shop.pos.cartEmpty')); return }
    saleMutation.mutate()
  }

  return (
    <div>
      <PageHeader title={t('shop.pos.title')} description={t('shop.pos.description')} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-3">
          <Input
            placeholder={t('shop.pos.searchProducts')}
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {products.map((p) => (
              <button
                key={p.productId}
                onClick={() => (p.hasVariants ? setPickingProduct(p) : addToCart(p, null))}
                className="flex flex-col items-start gap-1 rounded-md border border-border p-3 text-start hover:border-accent-foreground"
              >
                <span className="text-sm font-medium">{p.nameAr}</span>
                <MoneyDisplay amount={p.basePrice} size="sm" />
              </button>
            ))}
            {products.length === 0 && (
              <p className="col-span-full py-8 text-center text-sm text-text-secondary">{t('shop.pos.noProducts')}</p>
            )}
          </div>

          {pickingProduct && (
            <div className="rounded-md border border-border p-3">
              <p className="mb-2 text-sm font-medium">{t('shop.pos.chooseVariant', { name: pickingProduct.nameAr })}</p>
              <div className="flex flex-wrap gap-2">
                {variants.map((v) => (
                  <Button
                    key={v.variantId}
                    variant={pickedVariantId === v.variantId ? 'default' : 'outline'}
                    size="sm"
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
                  <Button variant="outline" size="icon" className="size-7" onClick={() => updateQuantity(idx, -1)}><Minus className="size-3" /></Button>
                  <span className="w-6 text-center tabular-nums">{l.quantity}</span>
                  <Button variant="outline" size="icon" className="size-7" onClick={() => updateQuantity(idx, 1)}><Plus className="size-3" /></Button>
                  <Button variant="ghost" size="icon" className="size-7" onClick={() => removeLine(idx)}><Trash2 className="size-3" /></Button>
                </div>
              </div>
            ))}
            {cart.length === 0 && <p className="py-4 text-center text-sm text-text-secondary">{t('shop.pos.cartEmpty')}</p>}
          </div>

          <div className="flex items-center justify-between border-t border-border pt-2">
            <span className="text-sm font-medium">{t('shop.pos.subtotal')}</span>
            <MoneyDisplay amount={subtotal} size="md" />
          </div>

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

          <Button disabled={saleMutation.isPending} onClick={handleCompleteSale}>
            {saleMutation.isPending ? t('shop.pos.completing') : t('shop.pos.completeSale')}
          </Button>
        </div>
      </div>
    </div>
  )
}
