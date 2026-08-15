import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { MoneyDisplay } from '@/components/ui/money-display'
import { StatusBadge } from '@/components/ui/status-badge'
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
import { PAYMENT_METHOD_LABELS, type PaymentRow } from '@/lib/domain/billing'

// Invoice list, invoice detail (view + print), payment collection form,
// refund flow. Print CSS via @media print rules scoped to #invoice-print.
interface InvoiceListRow {
  id: string
  invoiceNumber: string
  customerName: string
  status: string
  total: number
}

async function fetchInvoices(clubId: string) {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, invoice_number, status, total, customers(full_name)')
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []).map<InvoiceListRow>((row) => ({
    id: row.id,
    invoiceNumber: row.invoice_number,
    customerName: (row.customers as unknown as { full_name: string } | null)?.full_name ?? '—',
    status: row.status,
    total: Number(row.total),
  }))
}

async function fetchInvoiceDetail(invoiceId: string) {
  const { data, error } = await supabase
    .from('invoices')
    .select('*, customers(full_name, mobile_display), invoice_items(*)')
    .eq('id', invoiceId)
    .single()
  if (error) throw error
  return data
}

async function fetchInvoicePayments(invoiceId: string) {
  const { data, error } = await supabase
    .from('payment_allocations')
    .select('amount, payments(id, amount, method, received_at, reference)')
    .eq('invoice_id', invoiceId)
  if (error) throw error
  return (data ?? [])
    .map((row) => row.payments as unknown as { id: string; amount: number; method: string; received_at: string; reference: string | null } | null)
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map<PaymentRow>((p) => ({ id: p.id, amount: Number(p.amount), method: p.method, receivedAt: p.received_at, reference: p.reference }))
}

const INVOICE_STATUS_LABELS: Record<string, string> = { draft: 'مسودة', issued: 'صادرة', void: 'ملغاة' }

export function BillingPage() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [printSize, setPrintSize] = useState<'a4' | '80mm'>('a4')
  const [refundPaymentId, setRefundPaymentId] = useState<string | null>(null)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['invoices', currentClubId],
    queryFn: () => fetchInvoices(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: detail } = useQuery({
    queryKey: ['invoice-detail', selectedInvoiceId],
    queryFn: () => fetchInvoiceDetail(selectedInvoiceId!),
    enabled: !!selectedInvoiceId,
  })

  const { data: payments = [] } = useQuery({
    queryKey: ['invoice-payments', selectedInvoiceId],
    queryFn: () => fetchInvoicePayments(selectedInvoiceId!),
    enabled: !!selectedInvoiceId,
  })

  function invalidateDetail() {
    void queryClient.invalidateQueries({ queryKey: ['invoice-detail', selectedInvoiceId] })
    void queryClient.invalidateQueries({ queryKey: ['invoice-payments', selectedInvoiceId] })
    void queryClient.invalidateQueries({ queryKey: ['invoices', currentClubId] })
  }

  const recordPaymentMutation = useMutation({
    mutationFn: async () => {
      if (!selectedInvoiceId) throw new Error('no invoice selected')
      const { error } = await supabase.rpc('record_payment', {
        p_invoice_id: selectedInvoiceId,
        p_amount: Number(paymentAmount),
        p_method: paymentMethod,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setPaymentAmount('')
      setFormError(null)
      invalidateDetail()
    },
    onError: () => setFormError('تعذّر تسجيل الدفعة.'),
  })

  const refundMutation = useMutation({
    mutationFn: async () => {
      if (!refundPaymentId) throw new Error('no payment selected')
      const { error } = await supabase.rpc('create_refund', {
        p_payment_id: refundPaymentId,
        p_amount: Number(refundAmount),
        p_reason: refundReason,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setRefundPaymentId(null)
      setRefundAmount('')
      setRefundReason('')
      invalidateDetail()
    },
    onError: () => setFormError('تعذّر تنفيذ الاسترجاع — قد يتجاوز الرصيد القابل للاسترجاع.'),
  })

  const columns: DataTableColumn<InvoiceListRow>[] = [
    {
      key: 'number',
      header: 'رقم الفاتورة',
      render: (r) => (
        <button className="text-accent-foreground hover:underline" onClick={() => setSelectedInvoiceId(r.id)}>
          {r.invoiceNumber}
        </button>
      ),
    },
    { key: 'customer', header: 'العميل', render: (r) => r.customerName },
    { key: 'total', header: 'الإجمالي', render: (r) => <MoneyDisplay amount={r.total} size="sm" /> },
    {
      key: 'status',
      header: 'الحالة',
      render: (r) => (
        <StatusBadge
          tone={r.status === 'issued' ? 'success' : r.status === 'void' ? 'neutral' : 'warning'}
          label={INVOICE_STATUS_LABELS[r.status] ?? r.status}
        />
      ),
    },
  ]

  return (
    <div>
      <PageHeader title="الفواتير والمدفوعات" description="سجل الفواتير والمدفوعات" />
      <DataTable columns={columns} rows={invoices} rowKey={(r) => r.id} isLoading={isLoading} emptyTitle="لا توجد فواتير" />

      <Dialog open={!!selectedInvoiceId} onOpenChange={(open) => !open && setSelectedInvoiceId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>فاتورة {detail?.invoice_number}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="flex flex-col gap-4">
              <div id="invoice-print" data-print-size={printSize} className="rounded-md border border-border p-4 text-sm print:border-0">
                <div className="mb-3 flex justify-between">
                  <div>
                    <p className="font-bold">فاتورة رقم {detail.invoice_number}</p>
                    <p className="text-text-secondary">
                      {(detail.customers as unknown as { full_name: string })?.full_name}
                    </p>
                  </div>
                  <StatusBadge
                    tone={detail.status === 'issued' ? 'success' : 'neutral'}
                    label={INVOICE_STATUS_LABELS[detail.status] ?? detail.status}
                  />
                </div>
                <table className="w-full text-start">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="p-1 text-start">البند</th>
                      <th className="p-1 text-start">الكمية</th>
                      <th className="p-1 text-start">السعر</th>
                      <th className="p-1 text-start">الإجمالي</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.invoice_items as unknown as Array<{ id: string; description: string; quantity: number; unit_price: number; line_total: number }>)?.map((item) => (
                      <tr key={item.id} className="border-b border-border">
                        <td className="p-1">{item.description}</td>
                        <td className="p-1">{item.quantity}</td>
                        <td className="p-1">{item.unit_price}</td>
                        <td className="p-1">{item.line_total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3 flex justify-end">
                  <MoneyDisplay amount={Number(detail.total)} size="lg" />
                </div>
              </div>

              <div className="flex items-center gap-2 print:hidden">
                <Select value={printSize} onValueChange={(v) => setPrintSize(v as 'a4' | '80mm')}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="a4">A4</SelectItem>
                    <SelectItem value="80mm">إيصال 80mm</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" className="w-fit" onClick={() => window.print()}>
                  طباعة
                </Button>
              </div>

              <div className="print:hidden">
                <p className="mb-2 font-medium">المدفوعات</p>
                {payments.length === 0 ? (
                  <p className="text-sm text-text-secondary">لا توجد مدفوعات بعد.</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {payments.map((p) => (
                      <li key={p.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                        <span>
                          <MoneyDisplay amount={p.amount} size="sm" /> — {PAYMENT_METHOD_LABELS[p.method] ?? p.method}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRefundPaymentId(p.id)}
                        >
                          استرجاع
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {detail.status === 'issued' && (
                <div className="flex flex-col gap-2 border-t border-border pt-3 print:hidden">
                  <p className="font-medium">تسجيل دفعة</p>
                  <div className="flex gap-2">
                    <Input type="number" placeholder="المبلغ" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} />
                    <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                      <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(PAYMENT_METHOD_LABELS).map(([key, label]) => (
                          <SelectItem key={key} value={key}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button disabled={!paymentAmount || recordPaymentMutation.isPending} onClick={() => recordPaymentMutation.mutate()}>
                      تسجيل
                    </Button>
                  </div>
                </div>
              )}

              {formError && (
                <p role="alert" className="text-sm text-status-danger">{formError}</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!refundPaymentId} onOpenChange={(open) => !open && setRefundPaymentId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>استرجاع دفعة</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input type="number" placeholder="مبلغ الاسترجاع" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} />
            <Input placeholder="سبب الاسترجاع" value={refundReason} onChange={(e) => setRefundReason(e.target.value)} />
            <Button disabled={!refundAmount || !refundReason.trim() || refundMutation.isPending} onClick={() => refundMutation.mutate()}>
              تأكيد الاسترجاع
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
