import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatDate, type SupportedLocale } from '@/lib/i18n/config'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { ShopInvoiceDialog } from '@/features/shop/ShopInvoiceDocument'

// COMMERCIAL MODULE (2026-08-26) -- Sales history + Returns flow
// (directive Section 43/44/64).
interface SaleRow {
  saleId: string
  invoiceNumber: string
  customerName: string | null
  status: string
  total: number
  createdAt: string
}

interface SaleItemRow {
  itemId: string
  productNameAr: string
  variantLabel: string | null
  quantity: number
  unitPrice: number
  lineTotal: number
  returnedQuantity: number
}

interface SaleApiRow {
  sale_id: string; invoice_number: string; customer_name: string | null; status: string;
  total: number | string; created_at: string
}

function mapSaleRows(rows: SaleApiRow[]): SaleRow[] {
  return rows.map((r) => ({
    saleId: r.sale_id, invoiceNumber: r.invoice_number, customerName: r.customer_name, status: r.status,
    total: Number(r.total), createdAt: r.created_at,
  }))
}

async function fetchSales(clubId: string): Promise<SaleRow[]> {
  const { data, error } = await supabase.rpc('list_shop_sales', { p_club_id: clubId, p_limit: 50 })
  if (error) throw error
  return mapSaleRows((data ?? []) as SaleApiRow[])
}

async function fetchSaleDetail(saleId: string): Promise<SaleItemRow[]> {
  const { data, error } = await supabase.rpc('get_shop_sale_detail', { p_sale_id: saleId })
  if (error) throw error
  return (data ?? []).map((r) => ({
    itemId: r.item_id, productNameAr: r.product_name_ar, variantLabel: r.variant_label, quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price), lineTotal: Number(r.line_total), returnedQuantity: Number(r.returned_quantity),
  }))
}

const STATUS_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'danger'> = {
  completed: 'success', partially_returned: 'warning', returned: 'neutral', cancelled: 'danger', draft: 'neutral',
}

export function ShopSalesPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { locale } = useDirection()
  const [returningSale, setReturningSale] = useState<SaleRow | null>(null)
  // COMMERCE PRO C4 -- real per-sale invoice document (A4/80mm), opened
  // by clicking the invoice number, matching BillingPage.tsx's own
  // row-click-opens-detail pattern. Closes the gap this phase targets:
  // ShopSalesPage previously only had a filtered-table print (the
  // ReportPrintButton/fetchFullReport machinery above, unchanged), no
  // real per-sale invoice document.
  const [viewingInvoiceSaleId, setViewingInvoiceSaleId] = useState<string | null>(null)

  const { data: sales = [], isLoading } = useQuery({
    queryKey: ['shop-sales', currentClubId],
    queryFn: () => fetchSales(currentClubId as string),
    enabled: !!currentClubId,
  })

  // PRINTING -- FULL FILTERED PRINT correction: screen stays bounded to 50
  // (unchanged). "Print Full Report" pages through the same RPC with the
  // same filters via fetchFullReport() -- capped, chunked, never silent.
  const [fullSales, setFullSales] = useState<SaleRow[] | null>(null)
  const [fullSalesTruncated, setFullSalesTruncated] = useState(false)
  const fullPrintMutation = useMutation({
    mutationFn: () => fetchFullReport<SaleApiRow>('list_shop_sales', { p_club_id: currentClubId }),
    onSuccess: (result) => {
      setFullSales(mapSaleRows(result.rows))
      setFullSalesTruncated(result.truncated)
      requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
    },
  })
  const printedSales = fullSales ?? sales

  useEffect(() => {
    if (fullSales === null) return
    const handler = () => { setFullSales(null); setFullSalesTruncated(false) }
    window.addEventListener('afterprint', handler)
    return () => window.removeEventListener('afterprint', handler)
  }, [fullSales])

  const columns: DataTableColumn<SaleRow>[] = [
    {
      key: 'invoice',
      header: t('shop.sales.columns.invoice'),
      render: (s) => (
        <button
          data-testid={`shop-sale-row-${s.saleId}`}
          className="text-accent-foreground hover:underline"
          onClick={() => setViewingInvoiceSaleId(s.saleId)}
        >
          <bdi>{s.invoiceNumber}</bdi>
        </button>
      ),
    },
    { key: 'customer', header: t('shop.sales.columns.customer'), render: (s) => s.customerName ?? '—' },
    { key: 'total', header: t('shop.sales.columns.total'), render: (s) => <MoneyDisplay amount={s.total} size="sm" /> },
    {
      key: 'status',
      header: t('shop.sales.columns.status'),
      render: (s) => <StatusBadge tone={STATUS_TONE[s.status] ?? 'neutral'} label={t(`shop.sales.status.${s.status}`, { defaultValue: s.status })} />,
    },
    { key: 'date', header: t('shop.sales.columns.date'), render: (s) => formatDate(s.createdAt, locale as SupportedLocale, 'Africa/Cairo', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },
    {
      key: 'actions',
      header: '',
      render: (s) => (
        <div className="flex items-center gap-1 print:hidden">
          <Button variant="ghost" size="sm" onClick={() => setViewingInvoiceSaleId(s.saleId)}>
            <Printer className="me-1 size-4" aria-hidden="true" />
            {t('shop.sales.viewInvoice')}
          </Button>
          {(s.status === 'completed' || s.status === 'partially_returned') && (
            <Button variant="ghost" size="sm" onClick={() => setReturningSale(s)}>{t('shop.sales.processReturn')}</Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div>
      <div className="print:hidden">
        <PageHeader
          title={t('shop.sales.title')}
          description={t('shop.sales.description')}
          actions={sales.length > 0 ? (
            <>
              <ReportPrintButton />
              <Button
                variant="outline"
                size="sm"
                disabled={fullPrintMutation.isPending}
                onClick={() => { setFullSales(null); fullPrintMutation.mutate() }}
              >
                <Printer className="me-1 size-4" />
                {fullPrintMutation.isPending ? t('reports.printFullPreparing') : t('reports.printFull')}
              </Button>
            </>
          ) : undefined}
        />
      </div>
      {/* COMMERCE PRO C4: this list's own print-target must stop being
          "visible for print" while the per-sale ShopInvoiceDialog is
          open on top of it -- otherwise two print-targets would both
          carry .visible-for-print at once (Radix Dialog doesn't unmount
          this page underneath an opened Dialog), matching the same
          pattern BillingPage.tsx already established for its own
          invoice-detail vs. payment/refund-receipt print-targets. */}
      <div className={`print-target ${viewingInvoiceSaleId ? '' : 'visible-for-print'}`}>
        <ReportPrintHeader reportName={t('shop.sales.title')} />
        {fullSales !== null ? (
          <>
            <p className="mb-2 text-xs text-text-secondary">{t('reports.printFullRowCount', { count: fullSales.length })}</p>
            {fullSalesTruncated && (
              <p className="mb-2 text-xs font-medium text-status-warning">{t('reports.printFullTruncated')}</p>
            )}
          </>
        ) : (
          <p className="mb-2 text-xs text-text-secondary print:block hidden">{t('shop.sales.printLimitNote', { count: 50 })}</p>
        )}
        <DataTable columns={columns} rows={printedSales} rowKey={(s) => s.saleId} isLoading={isLoading} emptyTitle={t('shop.sales.emptyTitle')} emptyDescription={t('shop.sales.emptyDescription')} />
      </div>

      {returningSale && (
        <ReturnDialog sale={returningSale} onClose={() => setReturningSale(null)} />
      )}

      {viewingInvoiceSaleId && (
        <ShopInvoiceDialog saleId={viewingInvoiceSaleId} onClose={() => setViewingInvoiceSaleId(null)} />
      )}
    </div>
  )
}

function ReturnDialog({ sale, onClose }: { sale: SaleRow; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({})
  const [restock, setRestock] = useState(true)
  const [refundAmount, setRefundAmount] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: items = [] } = useQuery({ queryKey: ['shop-sale-detail', sale.saleId], queryFn: () => fetchSaleDetail(sale.saleId) })

  const returnMutation = useMutation({
    mutationFn: async () => {
      const lines = Object.entries(returnQuantities)
        .filter(([, qty]) => qty > 0)
        .map(([itemId, qty]) => ({ sale_item_id: itemId, quantity: qty }))
      if (lines.length === 0) throw new Error('NO_LINES')
      const { error: err } = await supabase.rpc('return_shop_sale', {
        p_sale_id: sale.saleId,
        p_lines: lines,
        p_restock: restock,
        p_refund_amount: refundAmount ? Number(refundAmount) : undefined,
        p_reason: reason,
        // Real double-click/network-retry protection (directive
        // Section 16) -- a fresh key per genuine submit attempt.
        p_idempotency_key: crypto.randomUUID(),
      })
      if (err) throw err
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['shop-sales'] })
      void queryClient.invalidateQueries({ queryKey: ['shop-inventory-balances'] })
      onClose()
    },
    onError: (err) => {
      if (err instanceof Error && err.message === 'NO_LINES') {
        setError(t('shop.sales.returnNoLinesError'))
      } else {
        setError(translateSupabaseError(err, t('shop.sales.returnError')))
      }
    },
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('shop.sales.returnDialogTitle', { invoice: sale.invoiceNumber })}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {items.map((item) => {
              const remaining = item.quantity - item.returnedQuantity
              return (
                <div key={item.itemId} className="flex items-center justify-between gap-2 rounded-md border border-border p-2 text-sm">
                  <div>
                    <p>{item.productNameAr}{item.variantLabel ? ` (${item.variantLabel})` : ''}</p>
                    <p className="text-xs text-text-secondary">{t('shop.sales.remainingReturnable', { count: remaining })}</p>
                  </div>
                  <Input
                    type="number"
                    min="0"
                    max={remaining}
                    step="1"
                    className="w-20"
                    disabled={remaining <= 0}
                    value={returnQuantities[item.itemId] ?? ''}
                    onChange={(e) => setReturnQuantities((cur) => ({ ...cur, [item.itemId]: Number(e.target.value) }))}
                  />
                </div>
              )
            })}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
            {t('shop.sales.restockLabel')}
          </label>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.sales.refundAmountLabel')}</label>
            <Input type="number" min="0" step="0.01" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.sales.reasonLabel')}</label>
            <Input required value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!reason || returnMutation.isPending} onClick={() => { setError(null); returnMutation.mutate() }}>
              {returnMutation.isPending ? t('shop.sales.processing') : t('shop.sales.processReturn')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
