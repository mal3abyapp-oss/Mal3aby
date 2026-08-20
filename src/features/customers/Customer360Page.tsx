import { useState, useEffect, useRef } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { translateSupabaseError } from '@/lib/errors'
import { normalizePhone } from '@/lib/domain/phone'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { StatCard } from '@/components/ui/stat-card'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { useOfficialReceipt, OfficialCollectionReceiptFields } from '@/components/ui/official-collection-receipt-fields'
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, PAYMENT_STATUS_TONE, formatMoney, type PaymentStatus } from '@/lib/domain/billing'
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONE } from '@/lib/domain/booking'
import { ArrowLeft, Wallet, Calendar, GraduationCap, MessageCircle, AlertTriangle } from 'lucide-react'

// Customer 360 directive: "ONE CUSTOMER, ONE SOURCE OF TRUTH." Replaces
// the scattered per-module customer views (CustomerDetailDialog's
// booking summary, Academy's guardian name-only display, Billing's
// invoice-join customer name) with a single identity page every
// cross-module "open customer" link now points at. Every number on
// this page is a live read from get_customer_360_summary() and its
// siblings -- never a snapshot field on the customer row itself (the
// directive's explicit "UI TOTAL = DB AGGREGATION" requirement).

type TabKey = 'overview' | 'bookings' | 'academy' | 'financial' | 'whatsapp' | 'activity'

interface Summary {
  customer: {
    id: string; full_name: string; mobile_display: string | null; phone_e164: string | null
    email: string | null; created_at: string; duplicate_review_status: string
  }
  bookings_count: number
  upcoming_booking: { id: string; start_at: string; field_name: string } | null
  active_players_count: number
  financial: { total_invoiced: number; total_paid: number; total_refunded: number; outstanding: number; open_invoices_count: number }
  whatsapp_consent: { enabled: boolean; phone_e164: string | null; revoked_at: string | null; consent_at: string | null } | null
  last_payment_at: string | null
}

async function fetchSummary(clubId: string, customerId: string): Promise<Summary> {
  const { data, error } = await supabase.rpc('get_customer_360_summary', { p_club_id: clubId, p_customer_id: customerId })
  if (error) throw error
  return data as unknown as Summary
}

interface BookingRow { id: string; start_at: string; end_at: string; status: string; total_price: number; field_name: string; invoice_id: string | null }
async function fetchBookings(clubId: string, customerId: string) {
  const { data, error } = await supabase.rpc('get_customer_bookings', { p_club_id: clubId, p_customer_id: customerId, p_limit: 20, p_offset: 0 })
  if (error) throw error
  return data as unknown as { rows: BookingRow[]; total_count: number }
}

interface PlayerRow {
  player_id: string; full_name: string; relationship: string; is_primary: boolean
  membership_name: string | null; enrollment_status: string | null; subscription_status: string | null
  start_date: string | null; end_date: string | null; outstanding: number
}
async function fetchAcademyPlayers(clubId: string, customerId: string) {
  const { data, error } = await supabase.rpc('get_customer_academy_players', { p_club_id: clubId, p_customer_id: customerId })
  if (error) throw error
  return (data ?? []) as unknown as PlayerRow[]
}

interface LedgerRow { invoice_id: string; invoice_number: string; issued_at: string | null; status: string; total: number; paid: number; outstanding: number; payment_status: PaymentStatus; source: string }
interface PaymentHistoryRow { id: string; amount: number; method: string; received_at: string; reference: string | null; received_by_name: string | null; official_receipt_serial: string | null; official_receipt_status: string | null }
async function fetchFinancial(clubId: string, customerId: string) {
  const { data, error } = await supabase.rpc('get_customer_financial_account', { p_club_id: clubId, p_customer_id: customerId, p_limit: 20, p_offset: 0 })
  if (error) throw error
  return data as unknown as {
    summary: { total_invoiced: number; total_paid: number; total_refunded: number; outstanding: number }
    ledger: { rows: LedgerRow[]; total_count: number }
    payments: { rows: PaymentHistoryRow[]; total_count: number }
  }
}

interface CommEventRow { id: string; template_key: string; status: string; created_at: string; last_attempt_at: string | null }
async function fetchCommunications(clubId: string, customerId: string) {
  const { data, error } = await supabase.rpc('get_customer_communications', { p_club_id: clubId, p_customer_id: customerId, p_limit: 20, p_offset: 0 })
  if (error) throw error
  return data as unknown as {
    consent: { enabled: boolean; phone_e164: string | null; consent_source: string | null; consent_at: string | null; revoked_at: string | null } | null
    events: { rows: CommEventRow[]; total_count: number }
  }
}

interface ActivityRow { id: string; action: string; before: unknown; after: unknown; created_at: string; actor_name: string | null }
async function fetchActivity(clubId: string, customerId: string) {
  const { data, error } = await supabase.rpc('get_customer_activity', { p_club_id: clubId, p_customer_id: customerId, p_limit: 30, p_offset: 0 })
  if (error) throw error
  return data as unknown as { rows: ActivityRow[]; total_count: number }
}

async function fetchClubCountry(clubId: string) {
  const { data } = await supabase.from('clubs').select('country').eq('id', clubId).maybeSingle()
  return (data?.country as CountryCode | null) ?? null
}

export function Customer360Page() {
  const { customerId } = useParams<{ customerId: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const [editOpen, setEditOpen] = useState(false)
  const [collectOpen, setCollectOpen] = useState(false)
  const [collectInvoice, setCollectInvoice] = useState<LedgerRow | null>(null)

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['customer-360-summary', currentClubId, customerId],
    queryFn: () => fetchSummary(currentClubId!, customerId!),
    enabled: !!currentClubId && !!customerId,
  })

  const { data: bookings } = useQuery({
    queryKey: ['customer-360-bookings', currentClubId, customerId],
    queryFn: () => fetchBookings(currentClubId!, customerId!),
    enabled: !!currentClubId && !!customerId && activeTab === 'bookings',
  })

  const { data: players } = useQuery({
    queryKey: ['customer-360-academy', currentClubId, customerId],
    queryFn: () => fetchAcademyPlayers(currentClubId!, customerId!),
    enabled: !!currentClubId && !!customerId && activeTab === 'academy',
  })

  const { data: financial } = useQuery({
    queryKey: ['customer-360-financial', currentClubId, customerId],
    queryFn: () => fetchFinancial(currentClubId!, customerId!),
    enabled: !!currentClubId && !!customerId && activeTab === 'financial',
  })

  const { data: comms } = useQuery({
    queryKey: ['customer-360-comms', currentClubId, customerId],
    queryFn: () => fetchCommunications(currentClubId!, customerId!),
    enabled: !!currentClubId && !!customerId && activeTab === 'whatsapp',
  })

  const { data: activity } = useQuery({
    queryKey: ['customer-360-activity', currentClubId, customerId],
    queryFn: () => fetchActivity(currentClubId!, customerId!),
    enabled: !!currentClubId && !!customerId && activeTab === 'activity',
  })

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ['customer-360-summary', currentClubId, customerId] })
    void queryClient.invalidateQueries({ queryKey: ['customer-360-financial', currentClubId, customerId] })
    void queryClient.invalidateQueries({ queryKey: ['customer-360-academy', currentClubId, customerId] })
  }

  if (summaryLoading) {
    return <div className="p-6"><p className="text-sm text-text-secondary">{t('common.loading')}</p></div>
  }

  if (!summary) {
    return (
      <div className="p-6">
        <p className="text-sm text-status-danger">{t('customers.detail.notFound', { defaultValue: 'Customer not found' })}</p>
        <Link to="/app/customers" className="text-sm text-accent-foreground hover:underline">{t('common.back', { defaultValue: 'Back' })}</Link>
      </div>
    )
  }

  const c = summary.customer

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => navigate('/app/customers')} className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft className="size-4 rtl:rotate-180" />
          {t('customers.page.title')}
        </button>
      </div>

      {c.duplicate_review_status === 'quarantined_pending_review' && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-status-warning" />
          {t('customers.detail.quarantinedNotice', { defaultValue: 'This customer is flagged as a likely duplicate and is pending review.' })}
        </div>
      )}

      <PageHeader
        title={c.full_name}
        description={c.mobile_display ?? c.phone_e164 ?? ''}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => navigate(`/app/bookings?newBookingCustomer=${c.id}`)}>
              {t('customers.detail.newBooking', { defaultValue: 'New booking' })}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              {t('common.edit')}
            </Button>
          </div>
        }
      />

      {/* Live mobile QA at 375px: grid-cols-2 left the WhatsApp
          StatCard's "Consented"/"No consent" value competing for width
          against the fixed icon slot, so break-words (StatCard's own
          Arabic-label wrap fix) broke the English word itself mid-word
          ("Consen/ted"). Numbers/money never hit this, only the status
          word -- collapsing to one column below sm: gives it enough
          room without touching the shared StatCard component other
          pages already rely on the 2-column behavior for. */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatCard label={t('customers.detail.outstanding', { defaultValue: 'Outstanding' })} value={formatMoney(summary.financial.outstanding, 'EGP', locale)} icon={Wallet} tone={summary.financial.outstanding > 0 ? 'danger' : 'default'} />
        <StatCard label={t('customers.detail.bookingsCount', { defaultValue: 'Bookings' })} value={String(summary.bookings_count)} icon={Calendar} />
        <StatCard label={t('customers.detail.activePlayers', { defaultValue: 'Active players' })} value={String(summary.active_players_count)} icon={GraduationCap} />
        <StatCard
          label={t('customers.detail.whatsapp', { defaultValue: 'WhatsApp' })}
          value={summary.whatsapp_consent?.enabled ? t('customers.detail.consentYes', { defaultValue: 'Consented' }) : t('customers.detail.consentNo', { defaultValue: 'No consent' })}
          icon={MessageCircle}
        />
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="overview">{t('customers.detail.tabs.overview', { defaultValue: 'Overview' })}</TabsTrigger>
          <TabsTrigger value="bookings">{t('customers.detail.tabs.bookings', { defaultValue: 'Bookings' })}</TabsTrigger>
          <TabsTrigger value="academy">{t('customers.detail.tabs.academy', { defaultValue: 'Academy & Players' })}</TabsTrigger>
          <TabsTrigger value="financial">{t('customers.detail.tabs.financial', { defaultValue: 'Financial Account' })}</TabsTrigger>
          <TabsTrigger value="whatsapp">{t('customers.detail.tabs.whatsapp', { defaultValue: 'WhatsApp & Communication' })}</TabsTrigger>
          <TabsTrigger value="activity">{t('customers.detail.tabs.activity', { defaultValue: 'Activity & Audit' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="mt-4 flex flex-col gap-4">
            <div className="rounded-lg border border-border p-4">
              <p className="mb-2 text-sm font-medium text-text-secondary">{t('customers.detail.upcoming', { defaultValue: 'Upcoming' })}</p>
              {summary.upcoming_booking ? (
                <div className="flex items-center justify-between text-sm">
                  <span>{summary.upcoming_booking.field_name}</span>
                  <span className="tabular-nums text-text-secondary"><bdi>{new Date(summary.upcoming_booking.start_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</bdi></span>
                </div>
              ) : (
                <p className="text-sm text-text-secondary">{t('customers.detail.noBookingsYet')}</p>
              )}
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="mb-2 text-sm font-medium text-text-secondary">{t('customers.detail.financialSummary', { defaultValue: 'Financial summary' })}</p>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div><p className="text-text-secondary">{t('customers.detail.totalInvoiced', { defaultValue: 'Invoiced' })}</p><MoneyDisplay amount={summary.financial.total_invoiced} size="sm" /></div>
                <div><p className="text-text-secondary">{t('customers.detail.totalPaid', { defaultValue: 'Paid' })}</p><MoneyDisplay amount={summary.financial.total_paid} size="sm" /></div>
                <div><p className="text-text-secondary">{t('customers.detail.totalRefunded', { defaultValue: 'Refunded' })}</p><MoneyDisplay amount={summary.financial.total_refunded} size="sm" /></div>
                <div><p className="text-text-secondary">{t('customers.detail.outstanding')}</p>{summary.financial.outstanding > 0 ? <MoneyDisplay amount={summary.financial.outstanding} tone="danger" size="sm" /> : <span className="text-status-success">{t('academy.playerStatus.fullyPaid')}</span>}</div>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="bookings">
          <div className="mt-4">
            <DataTable
              columns={[
                { key: 'field', header: t('bookings.field', { defaultValue: 'Field' }), render: (b: BookingRow) => b.field_name },
                { key: 'date', header: t('common.date', { defaultValue: 'Date' }), render: (b: BookingRow) => <span className="tabular-nums"><bdi>{new Date(b.start_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</bdi></span> },
                { key: 'status', header: t('common.status', { defaultValue: 'Status' }), render: (b: BookingRow) => <StatusBadge tone={BOOKING_STATUS_TONE[b.status] ?? 'neutral'} label={t(`bookings.statusLabels.${b.status}`, { defaultValue: BOOKING_STATUS_LABELS[b.status] ?? b.status })} /> },
                { key: 'total', header: t('common.total', { defaultValue: 'Total' }), render: (b: BookingRow) => <MoneyDisplay amount={b.total_price} size="sm" /> },
              ] as DataTableColumn<BookingRow>[]}
              rows={bookings?.rows ?? []}
              rowKey={(b) => b.id}
              emptyTitle={t('customers.detail.noBookingsYet')}
            />
          </div>
        </TabsContent>

        <TabsContent value="academy">
          <div className="mt-4">
            <DataTable
              columns={[
                { key: 'name', header: t('common.name'), render: (p: PlayerRow) => <div>{p.full_name}<span className="ms-2 text-xs text-text-secondary">{t(`customers.relationshipLabels.${p.relationship}`, { defaultValue: p.relationship })}{p.is_primary ? ` ${t('academy.players.primary')}` : ''}</span></div> },
                { key: 'membership', header: t('academy.memberships.name'), render: (p: PlayerRow) => p.membership_name ?? t('academy.players.noActiveSubscription') },
                { key: 'end', header: t('academy.players.expiry'), render: (p: PlayerRow) => p.end_date ?? '—' },
                { key: 'outstanding', header: t('customers.outstanding'), render: (p: PlayerRow) => p.outstanding > 0 ? <MoneyDisplay amount={p.outstanding} tone="danger" size="sm" /> : <span className="text-status-success">—</span> },
              ] as DataTableColumn<PlayerRow>[]}
              rows={players ?? []}
              rowKey={(p) => p.player_id}
              emptyTitle={t('academy.players.emptyTitle')}
            />
          </div>
        </TabsContent>

        <TabsContent value="financial">
          <div className="mt-4 flex flex-col gap-4">
            {financial && (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatCard label={t('customers.detail.totalInvoiced', { defaultValue: 'Invoiced' })} value={formatMoney(financial.summary.total_invoiced, 'EGP', locale)} />
                <StatCard label={t('customers.detail.totalPaid', { defaultValue: 'Paid' })} value={formatMoney(financial.summary.total_paid, 'EGP', locale)} />
                <StatCard label={t('customers.detail.totalRefunded', { defaultValue: 'Refunded' })} value={formatMoney(financial.summary.total_refunded, 'EGP', locale)} />
                <StatCard label={t('customers.detail.outstanding')} value={formatMoney(financial.summary.outstanding, 'EGP', locale)} tone={financial.summary.outstanding > 0 ? 'danger' : 'default'} />
              </div>
            )}

            <div>
              <p className="mb-2 text-sm font-medium text-text-secondary">{t('customers.detail.invoices')}</p>
              <DataTable
                columns={[
                  { key: 'invoice', header: t('customers.detail.invoices'), render: (i: LedgerRow) => <span className="tabular-nums text-accent-foreground"><bdi>{i.invoice_number}</bdi></span> },
                  { key: 'source', header: t('customers.detail.source', { defaultValue: 'Source' }), render: (i: LedgerRow) => t(`customers.detail.sourceLabels.${i.source}`, { defaultValue: i.source }) },
                  { key: 'total', header: t('common.total', { defaultValue: 'Total' }), render: (i: LedgerRow) => <MoneyDisplay amount={i.total} size="sm" /> },
                  { key: 'status', header: t('common.status', { defaultValue: 'Status' }), render: (i: LedgerRow) => <StatusBadge tone={PAYMENT_STATUS_TONE[i.payment_status] ?? 'neutral'} label={t(`secureBooking.paymentStatusLabels.${i.payment_status}`, { defaultValue: PAYMENT_STATUS_LABELS[i.payment_status] ?? i.payment_status })} /> },
                  {
                    key: 'actions', header: '', render: (i: LedgerRow) => i.outstanding > 0 ? (
                      <Button size="sm" onClick={() => { setCollectInvoice(i); setCollectOpen(true) }}>{t('customers.detail.collectPayment', { defaultValue: 'Collect payment' })}</Button>
                    ) : null,
                  },
                ] as DataTableColumn<LedgerRow>[]}
                rows={financial?.ledger.rows ?? []}
                rowKey={(i) => i.invoice_id}
                emptyTitle={t('customers.detail.noInvoicesYet')}
              />
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-text-secondary">{t('customers.detail.paymentHistory', { defaultValue: 'Payment history' })}</p>
              <DataTable
                columns={[
                  { key: 'date', header: t('common.date', { defaultValue: 'Date' }), render: (p: PaymentHistoryRow) => <span className="tabular-nums"><bdi>{new Date(p.received_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi></span> },
                  { key: 'amount', header: t('common.total', { defaultValue: 'Amount' }), render: (p: PaymentHistoryRow) => <MoneyDisplay amount={p.amount} size="sm" /> },
                  { key: 'method', header: t('common.method', { defaultValue: 'Method' }), render: (p: PaymentHistoryRow) => t(`common.paymentMethodLabels.${p.method}`, { defaultValue: PAYMENT_METHOD_LABELS[p.method] ?? p.method }) },
                  { key: 'receipt', header: t('customers.detail.officialReceipt', { defaultValue: 'Official receipt' }), render: (p: PaymentHistoryRow) => p.official_receipt_serial ? <span className="tabular-nums"><bdi>{p.official_receipt_serial}</bdi></span> : '—' },
                  { key: 'by', header: t('customers.detail.receivedBy', { defaultValue: 'Received by' }), render: (p: PaymentHistoryRow) => p.received_by_name ?? '—' },
                ] as DataTableColumn<PaymentHistoryRow>[]}
                rows={financial?.payments.rows ?? []}
                rowKey={(p) => p.id}
                emptyTitle={t('customers.detail.noPaymentsYet', { defaultValue: 'No payments yet' })}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="whatsapp">
          <WhatsAppCommunicationTab clubId={currentClubId!} customerId={c.id} comms={comms} onChanged={invalidateAll} />
        </TabsContent>

        <TabsContent value="activity">
          <div className="mt-4">
            <DataTable
              columns={[
                { key: 'date', header: t('common.date', { defaultValue: 'Date' }), render: (a: ActivityRow) => <span className="tabular-nums"><bdi>{new Date(a.created_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi></span> },
                { key: 'action', header: t('customers.detail.action', { defaultValue: 'Action' }), render: (a: ActivityRow) => a.action },
                { key: 'actor', header: t('customers.detail.actor', { defaultValue: 'By' }), render: (a: ActivityRow) => a.actor_name ?? '—' },
              ] as DataTableColumn<ActivityRow>[]}
              rows={activity?.rows ?? []}
              rowKey={(a) => a.id}
              emptyTitle={t('customers.detail.noActivityYet', { defaultValue: 'No activity yet' })}
            />
          </div>
        </TabsContent>
      </Tabs>

      {editOpen && (
        <EditCustomerDialog
          clubId={currentClubId!}
          customer={c}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); invalidateAll() }}
        />
      )}

      {collectOpen && collectInvoice && (
        <CollectPaymentDialog
          clubId={currentClubId!}
          invoice={collectInvoice}
          onClose={() => { setCollectOpen(false); setCollectInvoice(null) }}
          onCollected={() => {
            setCollectOpen(false)
            setCollectInvoice(null)
            invalidateAll()
            void queryClient.invalidateQueries({ queryKey: ['customer-360-financial', currentClubId, customerId] })
          }}
        />
      )}
    </div>
  )
}

// Directive section 9: "Phone must reuse Phone/E.164 normalization...
// Invalid phone: HARD REJECT. Duplicate canonical phone: show existing
// customer." Routes through the same upsert_customer RPC as every
// other authenticated staff creation surface (directive section 46).
function EditCustomerDialog({
  clubId, customer, onClose, onSaved,
}: {
  clubId: string
  customer: Summary['customer']
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [fullName, setFullName] = useState(customer.full_name)
  const [mobile, setMobile] = useState(customer.mobile_display ?? '')
  const [mobileCountry, setMobileCountry] = useState<CountryCode>('EG')
  const [phoneValid, setPhoneValid] = useState(true)
  const [email, setEmail] = useState(customer.email ?? '')
  const [error, setError] = useState<string | null>(null)
  const [duplicateId, setDuplicateId] = useState<string | null>(null)

  const { data: clubCountry } = useQuery({ queryKey: ['club-country', clubId], queryFn: () => fetchClubCountry(clubId), enabled: !!clubId })
  useEffect(() => {
    if (clubCountry) setMobileCountry(clubCountry)
  }, [clubCountry])

  const saveMutation = useMutation({
    mutationFn: async () => {
      let phoneE164: string | null = customer.phone_e164
      if (mobile.trim() && mobile !== customer.mobile_display) {
        const result = normalizePhone(mobile, mobileCountry)
        if (!result.valid || !result.e164) throw new Error(t('phoneInput.invalidError'))
        phoneE164 = result.e164
      }
      const { data, error: rpcError } = await supabase.rpc('upsert_customer', {
        p_club_id: clubId,
        p_full_name: fullName,
        p_phone_e164: phoneE164 as string,
        p_mobile_display: mobile || undefined,
        p_email: email || undefined,
        p_customer_id: customer.id,
      })
      if (rpcError) throw rpcError
      const row = data?.[0]
      if (row?.duplicate_of_customer_id) {
        setDuplicateId(row.duplicate_of_customer_id)
        throw new Error('duplicate')
      }
    },
    onSuccess: onSaved,
    onError: (err) => {
      if (err instanceof Error && err.message === 'duplicate') return
      setError(translateSupabaseError(err, t('customers.saveEditError')))
    },
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('customers.editCustomer')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('customers.fullName')}</label>
            <Input required value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <PhoneInput
            label={t('common.phone')}
            value={{ raw: mobile, country: mobileCountry }}
            onChange={(v) => { setMobile(v.raw); setMobileCountry(v.country); setDuplicateId(null) }}
            onValidChange={(r) => setPhoneValid(r.valid)}
          />
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('customers.emailOptional')}</label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {duplicateId && (
            <div className="flex flex-col gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-sm">
              <p>{t('phoneInput.duplicateCustomer')}</p>
              <Button size="sm" variant="outline" onClick={() => navigate(`/app/customers/${duplicateId}`)}>{t('customers.detail.openCustomer', { defaultValue: 'Open customer' })}</Button>
            </div>
          )}
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <Button
            disabled={!fullName.trim() || (mobile.trim().length > 0 && !phoneValid) || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? t('academy.players.saving') : t('common.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Directive sections 19-21: same Invoice Engine/Payment Engine/Cash
// Shift/Government Compliance every other payment surface uses -- no
// second implementation.
function CollectPaymentDialog({
  clubId, invoice, onClose, onCollected,
}: {
  clubId: string
  invoice: LedgerRow
  onClose: () => void
  onCollected: () => void
}) {
  const { t } = useTranslation()
  const [method, setMethod] = useState('cash')
  // Bug found in live QA: this dialog originally hardcoded
  // p_amount: invoice.outstanding with no input at all, so it could
  // only ever collect the full balance -- silently missing the
  // directive's "Partial/Full Payment" requirement that every other
  // collect-payment surface (BookingDetailSheet, Academy) already
  // supports. Mirrors BookingDetailSheet's exact amount-input +
  // validation + idempotency-key pattern instead of inventing a new one.
  const [amount, setAmount] = useState(() => invoice.outstanding.toFixed(2))
  const [error, setError] = useState<string | null>(null)
  const idempotencyKeyRef = useRef<string | null>(null)

  const receipt = useOfficialReceipt({ clubId, branchId: null, fieldId: null, method, enabled: true })

  const collectMutation = useMutation({
    mutationFn: async () => {
      const parsedAmount = Number(amount)
      if (!parsedAmount || parsedAmount <= 0) throw new Error(t('bookings.detail.invalidAmountError'))
      if (parsedAmount - invoice.outstanding > 0.01) {
        throw new Error(t('bookings.detail.amountExceedsOutstanding', { amount: parsedAmount.toFixed(2), outstanding: invoice.outstanding.toFixed(2) }))
      }
      if (!idempotencyKeyRef.current) {
        idempotencyKeyRef.current = crypto.randomUUID()
      }
      const receiptPayload = receipt.getPayload()
      if (receiptPayload) {
        const { p_receipt_notes, ...rest } = receiptPayload
        const { error: payError } = await supabase.rpc('record_payment_with_official_receipt', {
          p_invoice_id: invoice.invoice_id, p_amount: parsedAmount, p_method: method, ...rest, p_notes: p_receipt_notes,
          p_idempotency_key: idempotencyKeyRef.current,
        })
        if (payError) throw payError
      } else {
        const { error: payError } = await supabase.rpc('record_payment', {
          p_invoice_id: invoice.invoice_id, p_amount: parsedAmount, p_method: method,
          p_idempotency_key: idempotencyKeyRef.current,
        })
        if (payError) throw payError
      }
    },
    onSuccess: onCollected,
    onError: (err) => setError(translateSupabaseError(err, t('academy.enrollments.enrollError'))),
  })

  const canSubmit = !!amount && receipt.isValid

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('customers.detail.collectPayment', { defaultValue: 'Collect payment' })}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
            <span className="tabular-nums text-text-secondary"><bdi>{invoice.invoice_number}</bdi></span>
            <MoneyDisplay amount={invoice.outstanding} tone="danger" size="sm" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="number"
              min={0}
              step="0.01"
              placeholder={t('bookings.detail.amountPlaceholder', { amount: invoice.outstanding.toFixed(0) })}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(PAYMENT_METHOD_LABELS).map(([key]) => (
                  <SelectItem key={key} value={key}>{t(`common.paymentMethodLabels.${key}`, { defaultValue: PAYMENT_METHOD_LABELS[key] })}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <OfficialCollectionReceiptFields state={receipt} />
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <Button disabled={!canSubmit || collectMutation.isPending} onClick={() => collectMutation.mutate()}>
            {collectMutation.isPending ? t('academy.enrollments.enrolling') : t('customers.detail.collectPayment', { defaultValue: 'Collect payment' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Directive sections 31-33: consent read/revoke UI -- the audit found
// NO surface anywhere read notification_consent before this. Explicit
// YES/NO only, never a default; revoking here calls
// set_customer_whatsapp_consent, a dedicated RPC that only ever
// touches consent (never full_name/phone/email), delegating to the
// same record_staff_whatsapp_consent function every other
// consent-recording surface uses, so the "staff cannot silently
// restore revoked consent" invariant proven in the foundation tests
// holds here too.
function WhatsAppCommunicationTab({
  clubId, customerId, comms, onChanged,
}: {
  clubId: string
  customerId: string
  comms: Awaited<ReturnType<typeof fetchCommunications>> | undefined
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const consentMutation = useMutation({
    mutationFn: async (consented: boolean) => {
      if (!comms?.consent?.phone_e164) throw new Error(t('customers.detail.noPhoneForConsent', { defaultValue: 'This customer has no phone number on file.' }))
      const { error: rpcError } = await supabase.rpc('set_customer_whatsapp_consent', {
        p_club_id: clubId,
        p_customer_id: customerId,
        p_consented: consented,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: () => {
      setError(null)
      onChanged()
      void queryClient.invalidateQueries({ queryKey: ['customer-360-comms', clubId, customerId] })
    },
    onError: (err) => setError(translateSupabaseError(err, t('customers.detail.consentUpdateError', { defaultValue: "Couldn't update consent." }))),
  })

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="rounded-lg border border-border p-4">
        <p className="mb-2 text-sm font-medium text-text-secondary">{t('customers.detail.consentStatus', { defaultValue: 'WhatsApp consent' })}</p>
        {comms?.consent ? (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between">
              <StatusBadge tone={comms.consent.enabled ? 'success' : 'danger'} label={comms.consent.enabled ? t('customers.detail.consentYes', { defaultValue: 'Consented' }) : t('customers.detail.consentNo', { defaultValue: 'No consent' })} />
              <span className="tabular-nums text-text-secondary"><bdi>{comms.consent.phone_e164}</bdi></span>
            </div>
            {comms.consent.consent_at && <p className="text-xs text-text-secondary">{t('customers.detail.consentAt', { defaultValue: 'Recorded' })}: <bdi>{new Date(comms.consent.consent_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi></p>}
            {comms.consent.revoked_at && <p className="text-xs text-status-danger">{t('customers.detail.revokedAt', { defaultValue: 'Revoked' })}: <bdi>{new Date(comms.consent.revoked_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi></p>}
            <div className="mt-1 flex gap-2">
              <Button size="sm" variant={comms.consent.enabled ? 'outline' : 'default'} disabled={consentMutation.isPending} onClick={() => consentMutation.mutate(true)}>{t('customers.detail.recordConsentYes', { defaultValue: 'Record consent (yes)' })}</Button>
              <Button size="sm" variant={!comms.consent.enabled ? 'outline' : 'default'} disabled={consentMutation.isPending} onClick={() => consentMutation.mutate(false)}>{t('customers.detail.revokeConsent', { defaultValue: 'Revoke consent' })}</Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-text-secondary">{t('customers.detail.noConsentRecorded', { defaultValue: 'No consent decision recorded yet.' })}</p>
        )}
        {error && <p role="alert" className="mt-2 text-sm text-status-danger">{error}</p>}
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-text-secondary">{t('customers.detail.communicationHistory', { defaultValue: 'Communication history' })}</p>
        <DataTable
          columns={[
            { key: 'date', header: t('common.date', { defaultValue: 'Date' }), render: (e: CommEventRow) => <span className="tabular-nums"><bdi>{new Date(e.created_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi></span> },
            { key: 'template', header: t('customers.detail.event', { defaultValue: 'Event' }), render: (e: CommEventRow) => e.template_key },
            { key: 'status', header: t('common.status', { defaultValue: 'Status' }), render: (e: CommEventRow) => <StatusBadge tone={e.status === 'sent' ? 'success' : e.status === 'failed' || e.status === 'expired' ? 'danger' : 'neutral'} label={e.status} /> },
          ] as DataTableColumn<CommEventRow>[]}
          rows={comms?.events.rows ?? []}
          rowKey={(e) => e.id}
          emptyTitle={t('customers.detail.noMessagesYet', { defaultValue: 'No messages yet' })}
        />
      </div>
    </div>
  )
}
