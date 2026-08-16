import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONE } from '@/lib/domain/booking'

// Section K: Customer detail must not be CRUD-only -- identity, recent
// bookings, invoices/outstanding, and linked players/guardian
// relationships. This is a read-only companion dialog opened alongside
// (not replacing) the existing edit dialog.

interface CustomerActivity {
  bookings: { id: string; startAt: string; status: string; fieldName: string; totalPrice: number }[]
  invoices: { id: string; invoiceNumber: string; total: number; outstanding: number; status: string }[]
  linkedPlayers: { id: string; name: string; relationship: string }[]
}

async function fetchCustomerActivity(customerId: string): Promise<CustomerActivity> {
  const [bookingsRes, invoicesRes, guardianLinksRes] = await Promise.all([
    supabase
      .from('bookings')
      .select('id, start_at, status, total_price, fields(name)')
      .eq('customer_id', customerId)
      .order('start_at', { ascending: false })
      .limit(10),
    supabase
      .from('invoices')
      .select('id, invoice_number, total, status')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('guardian_links')
      .select('id, relationship, players(id, full_name)')
      .eq('customer_id', customerId),
  ])

  const invoiceIds = (invoicesRes.data ?? []).map((i) => i.id)
  const paidByInvoice = new Map<string, number>()
  if (invoiceIds.length > 0) {
    const { data: allocations } = await supabase.from('payment_allocations').select('invoice_id, amount').in('invoice_id', invoiceIds)
    for (const a of allocations ?? []) {
      paidByInvoice.set(a.invoice_id, (paidByInvoice.get(a.invoice_id) ?? 0) + Number(a.amount))
    }
  }

  return {
    bookings: (bookingsRes.data ?? []).map((b) => ({
      id: b.id,
      startAt: b.start_at,
      status: b.status,
      fieldName: (b.fields as unknown as { name: string } | null)?.name ?? '—',
      totalPrice: Number(b.total_price),
    })),
    invoices: (invoicesRes.data ?? []).map((i) => ({
      id: i.id,
      invoiceNumber: i.invoice_number,
      total: Number(i.total),
      outstanding: Math.max(Number(i.total) - (paidByInvoice.get(i.id) ?? 0), 0),
      status: i.status,
    })),
    linkedPlayers: (guardianLinksRes.data ?? []).map((g) => ({
      id: g.id,
      name: (g.players as unknown as { id: string; full_name: string } | null)?.full_name ?? '—',
      relationship: g.relationship,
    })),
  }
}

const RELATIONSHIP_LABELS: Record<string, string> = { father: 'الأب', mother: 'الأم', guardian: 'ولي أمر', other: 'أخرى' }

export function CustomerDetailDialog({ customerId, customerName, onOpenChange }: { customerId: string | null; customerName: string; onOpenChange: (open: boolean) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['customer-activity', customerId],
    queryFn: () => fetchCustomerActivity(customerId!),
    enabled: !!customerId,
  })

  const totalOutstanding = data?.invoices.reduce((sum, i) => sum + i.outstanding, 0) ?? 0

  return (
    <Dialog open={!!customerId} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>{customerName}</DialogTitle></DialogHeader>
        {isLoading ? (
          <p className="text-sm text-text-secondary">جارٍ التحميل...</p>
        ) : data ? (
          <div className="flex flex-col gap-4">
            {totalOutstanding > 0 && (
              <div className="rounded-lg border border-status-danger/30 bg-status-danger/5 p-3">
                <span className="text-sm text-text-secondary">إجمالي المستحق: </span>
                <MoneyDisplay amount={totalOutstanding} tone="danger" />
              </div>
            )}

            {data.linkedPlayers.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium text-text-secondary">اللاعبون المرتبطون</p>
                <div className="flex flex-col gap-1.5">
                  {data.linkedPlayers.map((p) => (
                    <div key={p.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                      <span>{p.name}</span>
                      <span className="text-text-secondary">{RELATIONSHIP_LABELS[p.relationship] ?? p.relationship}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="mb-2 text-sm font-medium text-text-secondary">آخر الحجوزات</p>
              {data.bookings.length === 0 ? (
                <p className="text-sm text-text-secondary">لا يوجد حجوزات بعد.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {data.bookings.map((b) => (
                    <div key={b.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                      <div>
                        <p>{b.fieldName}</p>
                        <p className="text-xs text-text-secondary tabular-nums">{new Date(b.startAt).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                      </div>
                      <StatusBadge tone={BOOKING_STATUS_TONE[b.status] ?? 'neutral'} label={BOOKING_STATUS_LABELS[b.status] ?? b.status} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-text-secondary">الفواتير</p>
              {data.invoices.length === 0 ? (
                <p className="text-sm text-text-secondary">لا توجد فواتير بعد.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {data.invoices.map((i) => (
                    <div key={i.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                      <span>{i.invoiceNumber}</span>
                      <div className="flex items-center gap-2">
                        <MoneyDisplay amount={i.total} size="sm" />
                        {i.outstanding > 0 && <StatusBadge tone="danger" label={`متبقي ${i.outstanding.toFixed(0)}`} />}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
