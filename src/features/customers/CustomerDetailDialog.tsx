import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
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
import { fetchInvoicePaymentSummaries } from '@/lib/domain/billing'
import { MessageCircle } from 'lucide-react'

// IA restructuring (Phase 8): same "independent but connected"
// contextual summary as BookingDetailSheet -- notification_queue rows
// tie directly to a customer via recipient_customer_id, so no event
// join is needed here (simpler than the booking case). Summary only,
// no controls -- full management stays in the WhatsApp module.
async function fetchCustomerWhatsAppSummary(customerId: string): Promise<{ sentCount: number; failedCount: number }> {
  const { data, error } = await supabase
    .from('notification_queue')
    .select('status')
    .eq('channel', 'whatsapp')
    .eq('recipient_customer_id', customerId)
  if (error) throw error
  let sentCount = 0
  let failedCount = 0
  for (const r of data ?? []) {
    if (r.status === 'sent') sentCount++
    else if (r.status === 'failed' || r.status === 'expired') failedCount++
  }
  return { sentCount, failedCount }
}

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

  // Master Payment Directive task #81: was total - sum(payment_allocations)
  // computed locally, missing refund netting -- this customer's own detail
  // dialog could show a different (too-low) outstanding balance than
  // CustomersPage.tsx's list row for the exact same customer, since that
  // screen already correctly reads outstanding_invoices. Now both read
  // the same single source of truth (see AUTONOMOUS_DECISION_LOG.md
  // D-015): get_invoice_payment_summary().
  const invoiceIds = (invoicesRes.data ?? []).map((i) => i.id)
  const summaries = await fetchInvoicePaymentSummaries(invoiceIds)

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
      outstanding: summaries.get(i.id)?.outstanding ?? Number(i.total),
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

// Master IA/UX audit (Club Side Customer 360 phase): the bookings list
// here was a single flat "آخر الحجوزات" list with no distinction between
// what's coming up vs. what already happened -- a staff member checking
// a customer's history had to visually scan every row's date/status
// instead of seeing "next booking" at a glance. Bucketed client-side
// from the same already-fetched rows (still capped at the same 10 most
// recent, per the fetch's own .limit(10) -- not a new query).
function bucketBookings(bookings: CustomerActivity['bookings']) {
  const now = new Date()
  const upcoming = bookings.filter((b) => new Date(b.startAt) >= now && b.status !== 'cancelled' && b.status !== 'no_show')
  const past = bookings.filter((b) => new Date(b.startAt) < now && b.status !== 'cancelled' && b.status !== 'no_show')
  const cancelledOrNoShow = bookings.filter((b) => b.status === 'cancelled' || b.status === 'no_show')
  return { upcoming, past, cancelledOrNoShow }
}

export function CustomerDetailDialog({ customerId, customerName, onOpenChange }: { customerId: string | null; customerName: string; onOpenChange: (open: boolean) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['customer-activity', customerId],
    queryFn: () => fetchCustomerActivity(customerId!),
    enabled: !!customerId,
  })

  const { data: whatsappSummary } = useQuery({
    queryKey: ['customer-whatsapp-summary', customerId],
    queryFn: () => fetchCustomerWhatsAppSummary(customerId!),
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

            {whatsappSummary && (whatsappSummary.sentCount > 0 || whatsappSummary.failedCount > 0) && (
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-text-secondary">
                  <MessageCircle className="size-3.5" />
                  {whatsappSummary.failedCount > 0
                    ? `فشل إرسال ${whatsappSummary.failedCount} رسالة واتساب لهذا العميل`
                    : `أُرسلت ${whatsappSummary.sentCount} رسالة واتساب لهذا العميل ✓`}
                </span>
                <Link to="/app/whatsapp" className="font-medium text-accent-foreground hover:underline">
                  عرض النشاط
                </Link>
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

            {(() => {
              const { upcoming, past, cancelledOrNoShow } = bucketBookings(data.bookings)
              const groups: { title: string; rows: CustomerActivity['bookings'] }[] = [
                { title: 'القادمة', rows: upcoming },
                { title: 'السابقة', rows: past },
                { title: 'ملغاة / لم يحضر', rows: cancelledOrNoShow },
              ]
              return (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-medium text-text-secondary">الحجوزات</p>
                    {/* Booking rows aren't individually clickable into
                        BookingDetailSheet -- that sheet is opened from
                        state on BookingsPage (a full BookingRow object,
                        not just an id), not a route/query-param, so a
                        per-row deep-link would need new routing
                        infrastructure. Links to the list instead, same
                        as this dialog's field-name precedent. */}
                    <Link to="/app/bookings" className="text-xs font-medium text-accent-foreground hover:underline">
                      عرض كل الحجوزات
                    </Link>
                  </div>
                  {data.bookings.length === 0 ? (
                    <p className="text-sm text-text-secondary">لا يوجد حجوزات بعد.</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {groups.filter((g) => g.rows.length > 0).map((g) => (
                        <div key={g.title}>
                          <p className="mb-1 text-xs text-text-secondary">{g.title}</p>
                          <div className="flex flex-col gap-1.5">
                            {g.rows.map((b) => (
                              <div key={b.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                                <div>
                                  <p>{b.fieldName}</p>
                                  <p className="text-xs text-text-secondary tabular-nums">
                                    <bdi>{new Date(b.startAt).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</bdi>
                                  </p>
                                </div>
                                <StatusBadge tone={BOOKING_STATUS_TONE[b.status] ?? 'neutral'} label={BOOKING_STATUS_LABELS[b.status] ?? b.status} />
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}

            <div>
              <p className="mb-2 text-sm font-medium text-text-secondary">الفواتير</p>
              {data.invoices.length === 0 ? (
                <p className="text-sm text-text-secondary">لا توجد فواتير بعد.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {data.invoices.map((i) => (
                    <Link
                      key={i.id}
                      to={`/app/billing?invoice=${i.id}`}
                      className="flex items-center justify-between rounded-md border border-border p-2 text-sm hover:bg-muted/40"
                    >
                      <span className="text-accent-foreground"><bdi>{i.invoiceNumber}</bdi></span>
                      <div className="flex items-center gap-2">
                        <MoneyDisplay amount={i.total} size="sm" />
                        {i.outstanding > 0 && <StatusBadge tone="danger" label={`متبقي ${i.outstanding.toFixed(0)}`} />}
                      </div>
                    </Link>
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
