import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatDate } from '@/lib/i18n/config'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/billing'
import { Printer } from 'lucide-react'

// COMMERCE PRO C4 (2026-08-28) -- real invoice/thermal-receipt/payment-
// receipt documents for a Shop sale. See COMMERCE_PRO_UPGRADE_PLAN.md
// Section 2/3/4 and COMMERCE_C4_INVOICES_RECEIPTS_REPORT.md.
//
// Reuses BillingPage.tsx's exact print mechanism -- .print-target[data-print-size]
// + .visible-for-print + window.print(), the real @page/@page receipt
// CSS Paged Media rules already wired in src/index.css -- NOT a second
// print system. A single ShopInvoiceDialog renders both the A4 invoice
// and the 80mm thermal receipt from the SAME fetched data (get_shop_sale_invoice_data
// + get_shop_sale_detail), switching only the data-print-size attribute
// and a compact/full layout branch -- exactly like BillingPage's own
// A4/80mm toggle for the invoice/refund/payment receipts.
//
// "Do NOT display meaningless empty fields" (explicit, repeated plan
// instruction): every club-branding field (trading name, address,
// phone, tax number, commercial registration, footer note, return
// policy, logo) is rendered ONLY when configured -- confirmed via
// get_shop_print_settings returning null for anything never set by
// update_shop_print_settings. Discount row is shown ONLY when
// discount_amount > 0. Outstanding is shown ONLY when > 0.

interface SalePaymentRow {
  paymentId: string
  amount: number
  method: string
  reference: string | null
  receivedAt: string
  receivedByName: string | null
}

interface SaleInvoiceData {
  saleId: string
  clubId: string
  invoiceId: string
  invoiceNumber: string
  branchName: string
  locationName: string
  customerName: string | null
  customerMobile: string | null
  soldByName: string | null
  createdAt: string
  subtotal: number
  discountAmount: number
  discountReason: string | null
  total: number
  invoiceStatus: string
  payments: SalePaymentRow[]
  // PRINTING PRODUCTION ACCEPTANCE (2026-08-30): saleStatus/refunded/
  // outstanding now come straight from get_shop_sale_invoice_data(),
  // which itself calls get_invoice_payment_summary() internally --
  // the single authoritative source of truth (already fixed twice
  // this session) -- never recomputed client-side. See directive
  // Section 16 and the migration header for the exact bug this closes.
  saleStatus: 'completed' | 'partially_returned' | 'returned' | 'cancelled' | string
  refunded: number
  outstanding: number
}

interface SaleItemRow {
  itemId: string
  productNameAr: string
  variantLabel: string | null
  sku: string | null
  quantity: number
  unitPrice: number
  lineTotal: number
  returnedQuantity: number
}

interface PrintBranding {
  logoUrl: string | null
  taxNumber: string | null
  commercialRegistration: string | null
  tradingNameAr: string | null
  tradingNameEn: string | null
  address: string | null
  phone: string | null
  footerNote: string | null
  returnPolicy: string | null
}

async function fetchSaleInvoiceData(saleId: string): Promise<SaleInvoiceData> {
  const { data, error } = await supabase.rpc('get_shop_sale_invoice_data', { p_sale_id: saleId }).maybeSingle()
  if (error) throw error
  if (!data) throw new Error('sale not found')
  const payments = (Array.isArray(data.payments) ? data.payments : []) as unknown as Array<{
    payment_id: string; amount: number | string; method: string; reference: string | null; received_at: string; received_by_name: string | null
  }>
  return {
    saleId: data.sale_id,
    clubId: data.club_id,
    invoiceId: data.invoice_id,
    invoiceNumber: data.invoice_number,
    branchName: data.branch_name,
    locationName: data.location_name,
    customerName: data.customer_name,
    customerMobile: data.customer_mobile,
    soldByName: data.sold_by_name,
    createdAt: data.created_at,
    subtotal: Number(data.subtotal),
    discountAmount: Number(data.discount_amount),
    discountReason: data.discount_reason,
    total: Number(data.total),
    invoiceStatus: data.invoice_status,
    payments: payments.map((p) => ({
      paymentId: p.payment_id,
      amount: Number(p.amount),
      method: p.method,
      reference: p.reference,
      receivedAt: p.received_at,
      receivedByName: p.received_by_name,
    })),
    saleStatus: data.sale_status,
    refunded: Number(data.refunded),
    outstanding: Number(data.outstanding),
  }
}

async function fetchSaleItems(saleId: string): Promise<SaleItemRow[]> {
  const { data, error } = await supabase.rpc('get_shop_sale_detail', { p_sale_id: saleId })
  if (error) throw error
  return (data ?? []).map((r) => ({
    itemId: r.item_id,
    productNameAr: r.product_name_ar,
    variantLabel: r.variant_label,
    sku: r.sku,
    quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price),
    lineTotal: Number(r.line_total),
    returnedQuantity: Number(r.returned_quantity),
  }))
}

async function fetchPrintBranding(clubId: string): Promise<PrintBranding> {
  const { data, error } = await supabase.rpc('get_shop_print_settings', { p_club_id: clubId }).maybeSingle()
  if (error) throw error
  return {
    logoUrl: data?.logo_url ?? null,
    taxNumber: data?.tax_number ?? null,
    commercialRegistration: data?.commercial_registration ?? null,
    tradingNameAr: data?.trading_name_ar ?? null,
    tradingNameEn: data?.trading_name_en ?? null,
    address: data?.address ?? null,
    phone: data?.phone ?? null,
    footerNote: data?.footer_note ?? null,
    returnPolicy: data?.return_policy ?? null,
  }
}

function DocumentHeader({ branding, locale }: { branding: PrintBranding; locale: string }) {
  const { t } = useTranslation()
  const tradingName = locale === 'en' ? (branding.tradingNameEn || branding.tradingNameAr) : (branding.tradingNameAr || branding.tradingNameEn)
  const hasRegNumbers = branding.taxNumber || branding.commercialRegistration
  return (
    <div className="mb-3 flex items-start gap-3 border-b border-border pb-3">
      {branding.logoUrl && (
        <img src={branding.logoUrl} alt="" className="size-14 shrink-0 rounded-md object-contain" />
      )}
      <div className="flex-1">
        {tradingName && <p className="font-bold">{tradingName}</p>}
        {branding.address && <p className="text-xs text-text-secondary">{branding.address}</p>}
        {branding.phone && <p className="text-xs text-text-secondary" dir="ltr">{branding.phone}</p>}
        {hasRegNumbers && (
          <p className="text-xs text-text-secondary">
            {branding.taxNumber && `${t('shop.invoice.taxNumber')}: ${branding.taxNumber}`}
            {branding.taxNumber && branding.commercialRegistration && ' — '}
            {branding.commercialRegistration && `${t('shop.invoice.commercialRegistration')}: ${branding.commercialRegistration}`}
          </p>
        )}
      </div>
    </div>
  )
}

function PrintSizeControls({
  printSize,
  setPrintSize,
}: {
  printSize: 'a4' | '80mm'
  setPrintSize: (v: 'a4' | '80mm') => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 print:hidden">
      <Select value={printSize} onValueChange={(v) => setPrintSize(v as 'a4' | '80mm')}>
        <SelectTrigger className="w-32" data-testid="shop-invoice-print-size-toggle"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="a4" data-testid="shop-invoice-print-size-a4">A4</SelectItem>
          <SelectItem value="80mm" data-testid="shop-invoice-print-size-80mm">{t('billing.detail.receiptSize80mm')}</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" className="w-fit" onClick={() => window.print()}>
        <Printer className="me-1 size-4" aria-hidden="true" />
        {t('billing.detail.print')}
      </Button>
    </div>
  )
}

// The A4 invoice / thermal receipt document itself -- one component,
// data-print-size drives layout density (thermal is compact, no
// borders, large totals for a fast scan per the plan's explicit
// instruction; A4 is the full commercial-document layout).
function InvoiceDocumentBody({
  sale,
  items,
  branding,
  printSize,
  locale,
  onPrintPaymentReceipt,
  visibleForPrint = true,
}: {
  sale: SaleInvoiceData
  items: SaleItemRow[]
  branding: PrintBranding
  printSize: 'a4' | '80mm'
  locale: string
  onPrintPaymentReceipt?: (paymentId: string) => void
  // BillingPage.tsx's own established pattern (see its invoice-detail
  // print-target): when a nested receipt dialog (ShopPaymentReceiptDialog)
  // is open on top of this one, THIS document's print-target must stop
  // being the "visible for print" one -- otherwise two print-targets
  // would both carry .visible-for-print at once (Radix Dialog does not
  // unmount an underlying open Dialog just because another one opens
  // above it), which the print CSS's own comment documents as invalid/
  // ambiguous.
  visibleForPrint?: boolean
}) {
  const { t } = useTranslation()
  const paid = sale.payments.reduce((sum, p) => sum + p.amount, 0)
  // PRINTING PRODUCTION ACCEPTANCE (2026-08-30): outstanding/refunded
  // now come straight from sale.outstanding/sale.refunded, sourced by
  // get_shop_sale_invoice_data() from get_invoice_payment_summary()
  // (the authoritative source of truth) -- never recomputed here.
  // The prior `Math.max(0, sale.total - paid)` formula ignored refunds
  // entirely and could show a phantom outstanding balance for
  // merchandise already returned. See this migration's header for the
  // exact reproduction.
  const outstanding = sale.outstanding
  const isReturned = sale.saleStatus === 'returned' || sale.saleStatus === 'partially_returned'
  const isThermal = printSize === '80mm'

  return (
    <div
      data-testid="shop-invoice-print-view"
      data-print-size={printSize}
      className={`print-target rounded-md border border-border p-4 text-sm print:border-0 ${visibleForPrint ? 'visible-for-print' : ''} ${isThermal ? 'text-xs' : ''}`}
    >
      <DocumentHeader branding={branding} locale={locale} />

      {/* PRINTING PRODUCTION ACCEPTANCE (2026-08-30), Section 8: a
          returned/partially-returned sale must not visually look like
          an ordinary positive sale. Unmistakable even skimmed -- a
          bordered banner, not just a status word buried in the header. */}
      {isReturned && (
        <p className="mb-3 rounded-md border border-status-danger bg-status-danger/5 p-2 text-center text-xs font-bold text-status-danger">
          {sale.saleStatus === 'returned' ? t('shop.invoice.statusReturned') : t('shop.invoice.statusPartiallyReturned')}
        </p>
      )}

      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-bold">{t('billing.detail.invoicePrefix')} <bdi>{sale.invoiceNumber}</bdi></p>
          <p className="text-xs text-text-secondary">
            {formatDate(sale.createdAt, locale === 'en' ? 'en' : 'ar', 'Africa/Cairo', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </p>
          {!isThermal && (
            <p className="text-xs text-text-secondary">{sale.branchName} — {sale.locationName}</p>
          )}
        </div>
        <div className="text-end">
          {sale.customerName && <p className="font-medium">{sale.customerName}</p>}
          {!isThermal && sale.customerMobile && <p className="text-xs text-text-secondary" dir="ltr">{sale.customerMobile}</p>}
          {!isThermal && sale.soldByName && <p className="text-xs text-text-secondary">{t('shop.invoice.cashier')}: {sale.soldByName}</p>}
        </div>
      </div>

      <table className="w-full text-start">
        <thead>
          <tr className="border-b border-border">
            <th className="p-1 text-start">{t('billing.detail.itemHeader')}</th>
            {!isThermal && <th className="p-1 text-start">{t('shop.invoice.sku')}</th>}
            <th className="p-1 text-start">{t('billing.detail.quantityHeader')}</th>
            <th className="p-1 text-start">{t('billing.detail.priceHeader')}</th>
            <th className="p-1 text-start">{t('billing.detail.totalHeader')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.itemId} className="border-b border-border">
              <td className="p-1">
                {item.productNameAr}{item.variantLabel ? ` (${item.variantLabel})` : ''}
                {item.returnedQuantity > 0 && (
                  <span className="block text-xs font-medium text-status-danger">
                    {t('shop.invoice.returnedQuantityNote', { count: item.returnedQuantity })}
                  </span>
                )}
              </td>
              {!isThermal && <td className="p-1 tabular-nums" dir="ltr">{item.sku ?? '—'}</td>}
              <td className="p-1 tabular-nums">{item.quantity}</td>
              <td className="p-1 tabular-nums">{item.unitPrice}</td>
              <td className="p-1 tabular-nums">{item.lineTotal}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-secondary">{t('shop.invoice.subtotal')}</span>
          <MoneyDisplay amount={sale.subtotal} size="sm" />
        </div>
        {sale.discountAmount > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">
              {t('shop.invoice.discount')}{sale.discountReason ? ` (${sale.discountReason})` : ''}
            </span>
            <MoneyDisplay amount={sale.discountAmount} size="sm" tone="danger" />
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-secondary">{t('billing.detail.total')}</span>
          <MoneyDisplay amount={sale.total} size="lg" />
        </div>
        {paid > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">{t('billing.detail.paid')}</span>
            <MoneyDisplay amount={paid} size="sm" tone="success" />
          </div>
        )}
        {sale.refunded > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">{t('shop.invoice.refunded')}</span>
            <MoneyDisplay amount={sale.refunded} size="sm" tone="danger" />
          </div>
        )}
        {outstanding > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">{t('billing.detail.outstanding')}</span>
            <MoneyDisplay amount={outstanding} size="sm" tone="danger" />
          </div>
        )}
        {sale.refunded > 0 && outstanding <= 0 && (
          <p className="text-xs text-status-success">{t('shop.invoice.fullySettledAfterReturn')}</p>
        )}
      </div>

      {sale.payments.length > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <p className="mb-1 text-xs font-medium text-text-secondary">{t('billing.detail.paymentsHeading')}</p>
          <ul className="flex flex-col gap-0.5">
            {sale.payments.map((p) => (
              <li key={p.paymentId} className="flex items-center justify-between text-xs">
                <span>{t(`common.paymentMethodLabels.${p.method}`, { defaultValue: PAYMENT_METHOD_LABELS[p.method] ?? p.method })}</span>
                <span className="flex items-center gap-2">
                  <MoneyDisplay amount={p.amount} size="sm" />
                  {onPrintPaymentReceipt && (
                    <button
                      type="button"
                      className="print:hidden text-accent-foreground hover:underline"
                      onClick={() => onPrintPaymentReceipt(p.paymentId)}
                    >
                      {t('billing.detail.printReceipt')}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(branding.returnPolicy || branding.footerNote) && (
        <div className="mt-3 border-t border-border pt-2 text-xs text-text-secondary">
          {branding.returnPolicy && <p>{branding.returnPolicy}</p>}
          {branding.footerNote && <p className="mt-1">{branding.footerNote}</p>}
        </div>
      )}
      {!branding.returnPolicy && !branding.footerNote && (
        <p className="mt-3 border-t border-border pt-2 text-center text-xs text-text-secondary">{t('shop.invoice.thankYou')}</p>
      )}
    </div>
  )
}

// Dialog wrapper: fetches everything, handles loading/error, hosts the
// A4/80mm toggle. Reusable from ShopSalesPage.tsx (row click -> open by
// saleId) and ShopPOSPage.tsx's post-sale panel (open immediately after
// checkout with the just-created sale id) -- same component, same data
// source, no duplicated print surface.
export function ShopInvoiceDialog({
  saleId,
  onClose,
  initialPrintSize = 'a4',
}: {
  saleId: string
  onClose: () => void
  initialPrintSize?: 'a4' | '80mm'
}) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const [printSize, setPrintSize] = useState<'a4' | '80mm'>(initialPrintSize)
  const [printingPaymentId, setPrintingPaymentId] = useState<string | null>(null)

  const { data: sale, isLoading: saleLoading, isError: saleIsError, error: saleError, refetch } = useQuery({
    queryKey: ['shop-sale-invoice-data', saleId],
    queryFn: () => fetchSaleInvoiceData(saleId),
  })
  const { data: items = [], isLoading: itemsLoading } = useQuery({
    queryKey: ['shop-sale-detail', saleId],
    queryFn: () => fetchSaleItems(saleId),
  })
  const { data: branding } = useQuery({
    queryKey: ['shop-print-settings', sale?.clubId],
    queryFn: () => fetchPrintBranding(sale!.clubId),
    enabled: !!sale?.clubId,
  })

  const isLoading = saleLoading || itemsLoading || !branding

  return (
    <>
      <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('shop.invoice.dialogTitle')}</DialogTitle>
          </DialogHeader>
          {saleLoading && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {saleIsError && (
            <ErrorState message={translateSupabaseError(saleError, t('shop.invoice.loadError'))} onRetry={() => void refetch()} />
          )}
          {!isLoading && sale && branding && (
            <div className="flex flex-col gap-3">
              <InvoiceDocumentBody
                sale={sale}
                items={items}
                branding={branding}
                printSize={printSize}
                locale={locale}
                onPrintPaymentReceipt={(paymentId) => setPrintingPaymentId(paymentId)}
                visibleForPrint={!printingPaymentId}
              />
              <PrintSizeControls printSize={printSize} setPrintSize={setPrintSize} />
            </div>
          )}
        </DialogContent>
      </Dialog>
      {printingPaymentId && (
        <ShopPaymentReceiptDialog saleId={saleId} paymentId={printingPaymentId} onClose={() => setPrintingPaymentId(null)} />
      )}
    </>
  )
}

// Payment Receipt -- distinct from the invoice (plan Section 4): one
// per payments row against the invoice, not one per invoice. A
// multi-payment (split-tender) sale therefore has multiple receipts,
// selected here by paymentId. Receipt identity is the payment's own
// row id + received_at (documented decision, see report): this
// codebase's only other "receipt number" concept is
// official_collection_receipts, a distinct government-compliance
// serial-number system (opt-in per field/method, confirmed via direct
// schema read of 20260819200000_government_collection_compliance_schema.sql)
// -- not a generic Shop payment receipt scheme, so it is not reused
// here for something it was never designed for.
export function ShopPaymentReceiptDialog({
  saleId,
  paymentId,
  onClose,
}: {
  saleId: string
  paymentId: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const [printSize, setPrintSize] = useState<'a4' | '80mm'>('80mm')

  const { data: sale, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['shop-sale-invoice-data', saleId],
    queryFn: () => fetchSaleInvoiceData(saleId),
  })
  const { data: branding } = useQuery({
    queryKey: ['shop-print-settings', sale?.clubId],
    queryFn: () => fetchPrintBranding(sale!.clubId),
    enabled: !!sale?.clubId,
  })

  const payment = sale?.payments.find((p) => p.paymentId === paymentId) ?? null
  const paidSoFar = sale?.payments.reduce((sum, p) => sum + p.amount, 0) ?? 0
  const outstanding = sale ? Math.max(0, sale.total - paidSoFar) : 0

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('billing.detail.paymentReceiptTitle')}</DialogTitle>
        </DialogHeader>
        {isLoading && (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {isError && (
          <ErrorState message={translateSupabaseError(error, t('shop.invoice.loadError'))} onRetry={() => void refetch()} />
        )}
        {sale && payment && branding && (
          <div className="flex flex-col gap-3">
            <div
              data-testid="shop-payment-receipt-view"
              data-print-size={printSize}
              className="print-target visible-for-print rounded-md border border-border p-4 text-sm print:border-0"
            >
              <DocumentHeader branding={branding} locale={locale} />
              <p className="mb-2 font-bold">{t('billing.detail.paymentReceiptTitle')}</p>
              <div className="flex flex-col gap-1">
                <p>{t('billing.detail.invoicePrefix')} <bdi>{sale.invoiceNumber}</bdi></p>
                {sale.customerName && <p>{t('billing.refund.receiptCustomer', { name: sale.customerName })}</p>}
                <p>{t('billing.refund.receiptDate', { date: formatDate(payment.receivedAt, locale === 'en' ? 'en' : 'ar', 'Africa/Cairo', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}</p>
                <p>{t('billing.refund.receiptOriginalMethod', { method: t(`common.paymentMethodLabels.${payment.method}`, { defaultValue: PAYMENT_METHOD_LABELS[payment.method] ?? payment.method }) })}</p>
                {payment.receivedByName && <p>{t('billing.detail.collectedBy', { name: payment.receivedByName })}</p>}
              </div>
              <div className="mt-3 flex flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary">{t('billing.detail.paid')}</span>
                  <MoneyDisplay amount={payment.amount} size="lg" tone="success" />
                </div>
                {outstanding > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-secondary">{t('billing.detail.outstanding')}</span>
                    <MoneyDisplay amount={outstanding} size="sm" tone="danger" />
                  </div>
                )}
              </div>
            </div>
            <PrintSizeControls printSize={printSize} setPrintSize={setPrintSize} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
