import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

// IA restructuring (Phase 8): the one genuinely NEW screen in the
// WhatsApp module -- the data already existed in notification_queue
// (every booking confirmation, payment receipt, refund notice, etc.
// that has ever been queued for this club), but there was no read-only
// view of it anywhere. Confirmed in the audit as a real gap: staff
// could see aggregate counts (MessagingSafetyCard's diagnostics --
// "6 sent, 1 failed") but never *which* message went to *which*
// customer, or *why* a specific send failed. This tab is that missing
// per-message log -- read-only, no new backend logic, channel fixed to
// 'whatsapp' since this module is WhatsApp-specific.
//
// HIGH-ROI UX PASS 01, Priority 1 + 2 (design audit findings):
// "Failed permanently: N" was a passive number with no drill-down, and
// the Recipient column always showed "—" because notification_queue's
// own recipient_phone column is genuinely never populated in the real
// send flow (confirmed live via direct SQL) -- the real phone/name
// only exist one join away via recipient_customer_id -> customers.
// For the 'failed' status specifically, this tab now calls
// get_whatsapp_failed_messages() (a new RPC, see migration
// 20260819240000) which does that join server-side and also carries
// the linked booking/payment reference for a "view booking" action and
// a real, idempotency-safe retry action
// (retry_failed_whatsapp_message()). Every other status keeps using
// the original direct notification_queue read -- unchanged, lower risk.
interface ActivityRow {
  id: string
  templateKey: string
  status: string
  recipientPhone: string | null
  recipientName: string | null
  recipientCustomerId: string | null
  createdAt: string
  scheduledAt: string
  lastAttemptAt: string | null
  lastError: string | null
  attempts: number
  referenceType: string | null
  referenceId: string | null
  // WHATSAPP DELIVERY TRUTH fix (2026-08-22, real production defect):
  // 'sent' previously meant, and was labeled as, "delivered" -- it only
  // ever proved the connector's own outbound socket write completed,
  // never that WhatsApp's server or the recipient's device received
  // anything. These three columns carry the REAL evidence (a genuine
  // WhatsApp-server-originated receipt, see
  // supabase/migrations/20260822010000) -- null means no such receipt
  // has arrived, which for a row queued before this fix shipped means
  // "unverified" forever (the receipt listener did not exist yet), not
  // "not delivered". Never fabricated or backfilled.
  providerAcceptedAt: string | null
  deliveredAt: string | null
  readAt: string | null
  // WHATSAPP BUSINESS MESSAGING FINAL HARDENING (2026-08-22), Sections
  // 53-54: notification_queue.variables already carries every field
  // the detail view needs (booking_ref, invoice_number, receipt_serial,
  // player_name, group_name, invoice_token, booking_qr_token, ...) --
  // set by the same RPCs that queue the message, no new backend RPC
  // required for this UI work. Read via a direct PostgREST select
  // (RLS-gated on notification.view + own-club, confirmed via
  // pg_policies), not exposed as a raw blob to the row list -- only
  // the detail drawer reads specific known keys out of it.
  variables: Record<string, unknown> | null
}

// Sections 53-54: Message Family -- a business-outcome-oriented
// grouping distinct from the raw template_key, matching the
// directive's explicit list (Field Booking / Academy / Payment /
// Cancellation / Refund). Derived purely from template_key, which is
// a closed, fully-enumerated set (confirmed via templates.ts's
// TemplateKey union) -- no guessing, no free-text matching.
type MessageFamily = 'field_booking' | 'academy' | 'payment' | 'cancellation' | 'refund'

const TEMPLATE_TO_FAMILY: Record<string, MessageFamily> = {
  'booking-created': 'field_booking',
  'booking-confirmed-paid': 'field_booking',
  // Historical/dead template (still real rows exist) -- see the
  // TEMPLATE_LABEL_KEYS comment below for why this stays mapped.
  'booking-confirmed': 'field_booking',
  'invoice-created': 'field_booking',
  'booking-cancelled': 'cancellation',
  'payment-received': 'payment',
  'academy-payment-received': 'academy',
  'payment-refunded': 'refund',
}

function messageFamilyOf(templateKey: string): MessageFamily | null {
  return TEMPLATE_TO_FAMILY[templateKey] ?? null
}

// Entity type -- directly from notification_events.reference_type,
// which is a real, already-populated column (confirmed via every
// emit_notification_event() call site: 'booking'/'payment'/'refund').
// No 'subscription'/'player' reference_type is emitted by any current
// producer -- academy-payment-received messages are queued from
// payment.received the same way Field Booking payment messages are
// (record_payment's own event), so their entity is genuinely
// 'payment', not 'subscription' -- confirmed via direct RPC read, not
// assumed. Documented here rather than silently mapped to a value
// that doesn't exist in the data.
const ENTITY_LABEL_KEYS = ['booking', 'payment', 'refund'] as const

// Masks a phone number for the row list per Section 54 ("no unsafe
// secret/token exposure") -- keeps the country code and last 2 digits
// visible (enough for staff to recognize/distinguish customers) while
// not displaying the full number in a list view; the full number is
// still available in the failed-messages view (existing behavior,
// unchanged) and via the customer's own record through "View customer".
function maskPhone(phone: string | null): string {
  if (!phone) return '—'
  const digits = phone.replace(/[^\d+]/g, '')
  if (digits.length <= 4) return digits
  const visibleEnd = digits.slice(-2)
  const visibleStart = digits.slice(0, digits.startsWith('+') ? 4 : 3)
  return `${visibleStart}${'•'.repeat(Math.max(digits.length - visibleStart.length - 2, 2))}${visibleEnd}`
}

// Template/status label text lives in i18n resources under
// whatsapp.page.activityTab.templateLabels / .statusLabels (see
// WhatsAppActivityTab render below) -- these keys are the lookup keys,
// not the display text.
// WHATSAPP BUSINESS MESSAGING FINAL HARDENING (2026-08-22): 'booking-
// confirmed' and 'invoice-created' were removed from templates.ts as
// dead/fragmenting templates -- no live RPC queues either key anymore
// (confirmed: zero Postgres functions reference 'booking-confirmed'/
// 'invoice-created' as a template_key). They are DELIBERATELY kept
// here, though: real historical notification_queue rows exist with
// these template_keys (11 'booking-confirmed' rows, 2026-08-17/18,
// confirmed via direct query) and must still show a real label rather
// than falling back to the raw key string when staff filter/view old
// activity. Do not remove these two entries unless the historical rows
// are also being purged.
const TEMPLATE_LABEL_KEYS = [
  'booking-created',
  'booking-confirmed',
  // Duplicate-message fix (2026-08-18): the merged booking+payment
  // message queued by _create_booking_internal() when a payment is
  // recorded in the same transaction as booking creation -- see
  // whatsapp-connector/src/templates.ts's 'booking-confirmed-paid'.
  'booking-confirmed-paid',
  'booking-cancelled',
  'payment-received',
  // Academy identity (2026-08-22, migration 20260822080000): the
  // first-ever Academy-specific message -- see templates.ts.
  'academy-payment-received',
  'payment-refunded',
  'invoice-created',
] as const

// WHATSAPP DELIVERY TRUTH fix (2026-08-22): 'delivered' was defined in
// the DB CHECK constraint from the start but never actually written by
// anything (confirmed live) until this fix wired up a real receipt
// listener -- see supabase/migrations/20260822010000. It now
// represents genuine evidence-backed delivery, distinct from 'sent'
// (provider-accepted only).
//
// WHATSAPP BUSINESS MESSAGING FINAL HARDENING (2026-08-22), Section
// 53/65 (preserve the full delivery-tracking distinction -- queued/
// processing/provider accepted/sent/delivered/read/failed/superseded):
// confirmed via the real notification_queue CHECK constraint that
// 'scheduled' and 'processing' are genuine, real status values this
// table can hold, but this UI never listed either one -- a message
// waiting for its scheduled_at time, or one a connector worker had
// currently claimed, showed up as an unfiltered/unlabeled row. Added
// both. There is no separate literal 'superseded' status in the DB --
// supersession (directive Section 11) is represented as
// status='cancelled' on a row that was never sent (via
// cancel_pending_whatsapp_for_booking(), confirmed by direct source
// read) -- the existing 'cancelled' label already covers this
// correctly; the detail drawer additionally surfaces dedup_key so
// staff can see which later message superseded it.
const STATUS_LABEL_KEYS = ['pending', 'scheduled', 'processing', 'retrying', 'sent', 'delivered', 'failed', 'expired', 'cancelled', 'suppressed_invalid_recipient', 'suppressed_no_consent'] as const

const STATUS_LABEL_KEYS_WITH_ALL = ['all', ...STATUS_LABEL_KEYS] as const

const STATUS_TONE: Record<string, StatusTone> = {
  pending: 'neutral',
  scheduled: 'neutral',
  processing: 'neutral',
  retrying: 'warning',
  // 'sent' is intentionally NOT 'success' anymore -- it only proves
  // provider acceptance, not real delivery (the exact overstatement
  // this fix corrects). 'delivered' below is the genuinely
  // evidence-backed success state.
  sent: 'neutral',
  delivered: 'success',
  failed: 'danger',
  expired: 'danger',
  cancelled: 'neutral',
  // P0 Phone Identity directive: a suppressed-invalid-recipient row is
  // NOT a provider failure (directive section 44) -- distinct tone/
  // label so it never gets misread as "WhatsApp/provider is broken".
  suppressed_invalid_recipient: 'warning',
  suppressed_no_consent: 'warning',
}

// Phase G (G5): template is the second highest-value filter alongside
// the existing status filter -- lets staff isolate "did our
// booking-confirmed-paid messages go out" from the noise of every
// other template, same real server-side .eq() pattern as status.
async function fetchActivity(clubId: string, status: string, templateKey: string): Promise<ActivityRow[]> {
  // Sections 53-54: entity type/reference now read via the same
  // event_id -> notification_events join get_whatsapp_failed_messages()
  // already uses server-side -- here as a direct nested PostgREST
  // select, RLS-gated identically (confirmed via pg_policies: same
  // notification.view + own-club predicate on both tables), so this
  // is not a wider access surface than the failed-messages RPC
  // already has. `variables` carries the full message-detail payload
  // (booking_ref, invoice_number, receipt_serial, player_name, ...)
  // already set by the queuing RPC -- no new backend needed.
  let query = supabase
    .from('notification_queue')
    .select('id, template_key, status, recipient_phone, recipient_customer_id, customers(full_name), created_at, scheduled_at, last_attempt_at, last_error, attempts, provider_accepted_at, delivered_at, read_at, variables, notification_events(reference_type, reference_id)')
    .eq('club_id', clubId)
    .eq('channel', 'whatsapp')
    .order('created_at', { ascending: false })
    .limit(100)
  if (status !== 'all') {
    query = query.eq('status', status)
  }
  if (templateKey !== 'all') {
    query = query.eq('template_key', templateKey)
  }
  const { data, error } = await query
  if (error) throw error
  return (data ?? []).map((r) => {
    const event = r.notification_events as unknown as { reference_type: string | null; reference_id: string | null } | null
    return {
      id: r.id,
      templateKey: r.template_key,
      status: r.status,
      recipientPhone: r.recipient_phone,
      recipientName: (r.customers as unknown as { full_name: string } | null)?.full_name ?? null,
      recipientCustomerId: r.recipient_customer_id,
      createdAt: r.created_at,
      scheduledAt: r.scheduled_at,
      lastAttemptAt: r.last_attempt_at,
      lastError: r.last_error,
      attempts: r.attempts,
      referenceType: event?.reference_type ?? null,
      referenceId: event?.reference_id ?? null,
      providerAcceptedAt: r.provider_accepted_at,
      deliveredAt: r.delivered_at,
      readAt: r.read_at,
      variables: (r.variables as Record<string, unknown> | null) ?? null,
    }
  })
}

async function fetchFailedActivity(clubId: string): Promise<ActivityRow[]> {
  const { data, error } = await supabase.rpc('get_whatsapp_failed_messages', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    templateKey: r.template_key,
    status: r.status,
    recipientPhone: r.recipient_phone,
    recipientName: r.recipient_name,
    recipientCustomerId: r.recipient_customer_id,
    createdAt: r.created_at,
    scheduledAt: r.created_at,
    lastAttemptAt: r.last_attempt_at,
    lastError: r.last_error,
    attempts: r.attempts,
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    // A failed row structurally cannot have delivery evidence.
    providerAcceptedAt: null,
    deliveredAt: null,
    readAt: null,
    // get_whatsapp_failed_messages() does not currently return
    // variables -- the failed-messages detail view falls back to
    // whatever the row list already shows (template/recipient/error)
    // rather than a fuller business-outcome breakdown. Extending that
    // RPC is a reasonable follow-up but out of scope for this pass
    // (failed rows already have a dedicated retry/view-booking action
    // set the non-failed detail view doesn't need).
    variables: null,
  }))
}

// Production audit finding H-1 (RTL-bidi gap): this local helper (also
// duplicated in WhatsAppConnectionCard.tsx and MessagingSafetyCard.tsx)
// returns a plain string with no bidi isolation, same defect class as
// lib/i18n/config.ts's formatDate(). Every call site here needs a
// string (DetailRow's value prop, template-literal concatenation with
// the attempts count), not a React node, so this follows the same
// FSI/PDI convention formatMoney()/formatDateIsolated() already use for
// exactly that constraint rather than switching call sites to a
// component they can't actually accept.
const DATETIME_FSI = '⁦'
const DATETIME_PDI = '⁩'
function formatDateTime(iso: string | null, locale: string): string {
  if (!iso) return '—'
  const formatted = new Date(iso).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
  return `${DATETIME_FSI}${formatted}${DATETIME_PDI}`
}

// Translates a subset of known raw error strings into operational
// language, per the directive's explicit instruction not to invent a
// failure-classification taxonomy the data doesn't support. Anything
// not recognized falls back to showing the raw reason plainly labeled
// -- never a silent generic "failed" with no explanation, but also
// never a fabricated category.
function describeFailure(lastError: string | null, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!lastError) return t('whatsapp.page.activityTab.failureReason.generic', { reason: '—' })
  if (/timed out/i.test(lastError)) return t('whatsapp.page.activityTab.failureReason.timeout')
  if (/unknown.*template/i.test(lastError)) return t('whatsapp.page.activityTab.failureReason.unknownTemplate')
  return t('whatsapp.page.activityTab.failureReason.generic', { reason: lastError })
}

export function WhatsAppActivityTab({
  initialStatusFilter,
  onStatusFilterConsumed,
}: {
  initialStatusFilter?: string | null
  onStatusFilterConsumed?: () => void
}) {
  const { t, i18n } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter ?? 'all')
  const [templateFilter, setTemplateFilter] = useState('all')
  const [retryError, setRetryError] = useState<string | null>(null)
  const [detailRow, setDetailRow] = useState<ActivityRow | null>(null)

  useEffect(() => {
    if (initialStatusFilter) {
      setStatusFilter(initialStatusFilter)
      onStatusFilterConsumed?.()
    }
    // Only react to a genuine external request to switch filters (e.g.
    // the Overview tab's "review failures" card) -- onStatusFilterConsumed
    // is intentionally excluded from deps so this doesn't re-fire on
    // every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialStatusFilter])

  const isFailedView = statusFilter === 'failed'

  // Finding H-2 (frozen production audit): this list previously
  // destructured only `data = [], isLoading` -- a failed fetch silently
  // rendered as "no messages" (or, in the failed-only view, the
  // actively misleading "everything is sending normally"),
  // indistinguishable from a genuinely clean queue. isError is now
  // surfaced as a distinct inline message.
  const { data: rows = [], isLoading, isError } = useQuery({
    queryKey: ['whatsapp-activity', currentClubId, statusFilter, templateFilter],
    queryFn: () => (isFailedView ? fetchFailedActivity(currentClubId!) : fetchActivity(currentClubId!, statusFilter, templateFilter)),
    enabled: !!currentClubId,
    refetchInterval: 15000,
  })

  const retryMutation = useMutation({
    mutationFn: async (queueId: string) => {
      const { error } = await supabase.rpc('retry_failed_whatsapp_message', { p_queue_id: queueId })
      if (error) throw error
    },
    onSuccess: () => {
      setRetryError(null)
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-activity', currentClubId] })
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-quick-health', currentClubId] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : ''
      setRetryError(
        message.includes('no longer valid')
          ? t('whatsapp.page.activityTab.actions.retryInvalidSource')
          : t('whatsapp.page.activityTab.actions.retryError'),
      )
    },
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <div className="w-48">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_LABEL_KEYS_WITH_ALL.map((key) => (
                <SelectItem key={key} value={key}>
                  {t(`whatsapp.page.activityTab.statusLabels.${key}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Phase G (G5): template, the second highest-value filter --
            disabled in the failed-messages view since that RPC already
            returns only failed rows regardless of template. */}
        <div className="w-56">
          <Select value={templateFilter} onValueChange={setTemplateFilter} disabled={isFailedView}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('whatsapp.page.activityTab.allTemplates')}</SelectItem>
              {TEMPLATE_LABEL_KEYS.map((key) => (
                <SelectItem key={key} value={key}>
                  {t(`whatsapp.page.activityTab.templateLabels.${key}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {retryError && <p role="alert" className="text-sm text-status-danger">{retryError}</p>}

      {isLoading && <p className="text-sm text-text-secondary">{t('common.loading')}</p>}
      {isError && <p className="text-sm text-status-danger">{t('whatsapp.page.activityTab.loadError')}</p>}
      {!isLoading && !isError && rows.length === 0 && (
        <p className="text-sm text-text-secondary">
          {isFailedView ? t('whatsapp.page.activityTab.emptyFailed') : t('whatsapp.page.activityTab.emptyTitle')}
        </p>
      )}
      {!isLoading && !isError && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-sm">
            <thead>
              <tr className="border-b border-border text-text-secondary">
                <th className="p-2 text-start">{t('whatsapp.page.activityTab.columns.family')}</th>
                <th className="p-2 text-start">{t('whatsapp.page.activityTab.columns.message')}</th>
                <th className="p-2 text-start">{t('whatsapp.page.activityTab.columns.entity')}</th>
                <th className="p-2 text-start">{t('whatsapp.page.activityTab.columns.recipient')}</th>
                <th className="p-2 text-start">{t('whatsapp.page.activityTab.columns.status')}</th>
                <th className="p-2 text-start">{t('whatsapp.page.activityTab.columns.timing')}</th>
                <th className="p-2 text-start">{t('whatsapp.page.activityTab.columns.lastAttempt')}</th>
                {isFailedView && <th className="p-2 text-start">{t('whatsapp.page.activityTab.actions.retry')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const templateLabel = (TEMPLATE_LABEL_KEYS as readonly string[]).includes(r.templateKey)
                  ? t(`whatsapp.page.activityTab.templateLabels.${r.templateKey}`)
                  : r.templateKey
                const statusLabel = (STATUS_LABEL_KEYS as readonly string[]).includes(r.status)
                  ? t(`whatsapp.page.activityTab.statusLabels.${r.status}`)
                  : r.status
                const family = messageFamilyOf(r.templateKey)
                const familyLabel = family ? t(`whatsapp.page.activityTab.familyLabels.${family}`) : '—'
                const entityLabel = r.referenceType && (ENTITY_LABEL_KEYS as readonly string[]).includes(r.referenceType)
                  ? t(`whatsapp.page.activityTab.entityLabels.${r.referenceType}`)
                  : '—'
                const isRetryingThis = retryMutation.isPending && retryMutation.variables === r.id
                return (
                  <tr
                    key={r.id}
                    className="cursor-pointer border-b border-border align-top hover:bg-surface-hover"
                    onClick={() => setDetailRow(r)}
                  >
                    <td className="p-2">
                      <span className="inline-flex rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium">{familyLabel}</span>
                    </td>
                    <td className="p-2 font-medium">{templateLabel}</td>
                    <td className="p-2 text-xs text-text-secondary">{entityLabel}</td>
                    <td className="p-2">
                      {isFailedView ? (
                        <div className="flex flex-col">
                          <span>{r.recipientName ?? t('whatsapp.page.activityTab.unknownCustomer')}</span>
                          <span dir="ltr" className="text-xs tabular-nums text-text-secondary">
                            {maskPhone(r.recipientPhone)}
                          </span>
                        </div>
                      ) : (
                        <span dir="ltr" className="tabular-nums">{maskPhone(r.recipientPhone)}</span>
                      )}
                    </td>
                    <td className="p-2">
                      <StatusBadge tone={STATUS_TONE[r.status] ?? 'neutral'} label={statusLabel} />
                      {r.status === 'failed' && r.lastError && (
                        <p className="mt-1 max-w-xs text-xs text-status-danger">{describeFailure(r.lastError, t)}</p>
                      )}
                      {r.status === 'suppressed_invalid_recipient' && (
                        <p className="mt-1 max-w-xs text-xs text-status-warning">{t('phoneInput.invalidRecipient')}</p>
                      )}
                      {r.status === 'suppressed_no_consent' && (
                        <p className="mt-1 max-w-xs text-xs text-status-warning">{t('whatsapp.page.activityTab.noConsentDetail')}</p>
                      )}
                      {/* WHATSAPP DELIVERY TRUTH fix (2026-08-22): a
                          'sent' row with no deliveredAt is either
                          genuinely awaiting a receipt, OR a legacy row
                          from before the receipt listener existed --
                          this cannot be distinguished from providerAcceptedAt
                          alone, so both are honestly labeled
                          "unverified" rather than silently implying
                          delivery. Never claim more than the evidence
                          supports. */}
                      {r.status === 'sent' && !r.deliveredAt && (
                        <p className="mt-1 max-w-xs text-xs text-text-secondary">{t('whatsapp.page.activityTab.sentLegacyUnverified')}</p>
                      )}
                      {r.deliveredAt && (
                        <p className="mt-1 max-w-xs text-xs text-text-secondary">
                          {t('whatsapp.page.activityTab.deliveredAtLabel')}: {formatDateTime(r.deliveredAt, i18n.language)}
                        </p>
                      )}
                      {r.readAt && (
                        <p className="mt-1 max-w-xs text-xs text-text-secondary">
                          {t('whatsapp.page.activityTab.readAtLabel')}: {formatDateTime(r.readAt, i18n.language)}
                        </p>
                      )}
                    </td>
                    <td className="p-2 text-xs text-text-secondary">{formatDateTime(r.scheduledAt, i18n.language)}</td>
                    <td className="p-2 text-xs text-text-secondary">
                      {r.lastAttemptAt
                        ? `${formatDateTime(r.lastAttemptAt, i18n.language)} (${t('whatsapp.page.activityTab.attemptsLabel', { count: r.attempts })})`
                        : '—'}
                    </td>
                    {isFailedView && (
                      <td className="p-2" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={retryMutation.isPending}
                            onClick={() => retryMutation.mutate(r.id)}
                          >
                            {isRetryingThis ? t('whatsapp.page.activityTab.actions.retrying') : t('whatsapp.page.activityTab.actions.retry')}
                          </Button>
                          {r.referenceType === 'booking' && (
                            <Button size="sm" variant="ghost" asChild>
                              <Link to="/app/bookings">{t('whatsapp.page.activityTab.actions.viewBooking')}</Link>
                            </Button>
                          )}
                          {r.recipientCustomerId && (
                            <Button size="sm" variant="ghost" asChild>
                              <Link to={`/app/customers/${r.recipientCustomerId}`}>{t('whatsapp.page.activityTab.actions.viewCustomer')}</Link>
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Sections 53-54: Message Detail -- Business Outcome, Template,
          Recipient, Entity type/reference, Booking reference, Invoice
          number, Official receipt if applicable, Secure link (presence
          only -- NEVER the raw token itself, see Section 54's explicit
          "no unsafe secret/token exposure" rule), Attempts, Provider
          reference, Delivery/read state, Last error. Every value here
          comes from notification_queue.variables (already set by the
          queuing RPC at send time) or the row's own columns -- no new
          backend call, no raw booking_qr_token/invoice_token ever
          rendered as text or a clickable link in this staff-facing view. */}
      <Sheet open={!!detailRow} onOpenChange={(open) => !open && setDetailRow(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {detailRow && (() => {
            const family = messageFamilyOf(detailRow.templateKey)
            const v = detailRow.variables ?? {}
            const asString = (key: string): string | null => {
              const value = v[key]
              return typeof value === 'string' && value.trim().length > 0 ? value : typeof value === 'number' ? String(value) : null
            }
            const hasSecureLink = !!(v.booking_qr_token || v.invoice_token)
            const hasOfficialReceipt = !!asString('receipt_serial')
            return (
              <>
                <SheetHeader>
                  <SheetTitle>
                    {family ? t(`whatsapp.page.activityTab.familyLabels.${family}`) : t('whatsapp.page.activityTab.detail.title')}
                  </SheetTitle>
                </SheetHeader>
                <div className="flex flex-col gap-3 py-4 text-sm">
                  <DetailRow label={t('whatsapp.page.activityTab.detail.template')} value={t(`whatsapp.page.activityTab.templateLabels.${detailRow.templateKey}`, { defaultValue: detailRow.templateKey })} />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.recipient')} value={detailRow.recipientName ?? t('whatsapp.page.activityTab.unknownCustomer')} />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.recipientPhone')} value={maskPhone(detailRow.recipientPhone)} dir="ltr" />
                  <DetailRow
                    label={t('whatsapp.page.activityTab.detail.entity')}
                    value={detailRow.referenceType && (ENTITY_LABEL_KEYS as readonly string[]).includes(detailRow.referenceType) ? t(`whatsapp.page.activityTab.entityLabels.${detailRow.referenceType}`) : '—'}
                  />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.bookingRef')} value={asString('booking_ref')} dir="ltr" />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.player')} value={asString('player_name')} />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.group')} value={asString('group_name')} />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.invoiceNumber')} value={asString('invoice_number')} dir="ltr" />
                  {hasOfficialReceipt && (
                    <DetailRow label={t('whatsapp.page.activityTab.detail.officialReceipt')} value={asString('receipt_serial')} dir="ltr" />
                  )}
                  <DetailRow
                    label={t('whatsapp.page.activityTab.detail.secureLink')}
                    value={hasSecureLink ? t('whatsapp.page.activityTab.detail.secureLinkIncluded') : t('whatsapp.page.activityTab.detail.secureLinkNone')}
                  />
                  <div className="my-1 border-t border-border" />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.status')} value={t(`whatsapp.page.activityTab.statusLabels.${detailRow.status}`, { defaultValue: detailRow.status })} />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.attempts')} value={String(detailRow.attempts)} />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.createdAt')} value={formatDateTime(detailRow.createdAt, i18n.language)} />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.lastAttemptAt')} value={detailRow.lastAttemptAt ? formatDateTime(detailRow.lastAttemptAt, i18n.language) : null} />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.providerAcceptedAt')} value={detailRow.providerAcceptedAt ? formatDateTime(detailRow.providerAcceptedAt, i18n.language) : null} />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.deliveredAt')} value={detailRow.deliveredAt ? formatDateTime(detailRow.deliveredAt, i18n.language) : null} />
                  <DetailRow label={t('whatsapp.page.activityTab.detail.readAt')} value={detailRow.readAt ? formatDateTime(detailRow.readAt, i18n.language) : null} />
                  {detailRow.lastError && (
                    <DetailRow label={t('whatsapp.page.activityTab.detail.lastError')} value={describeFailure(detailRow.lastError, t)} />
                  )}
                  {detailRow.recipientCustomerId && (
                    <div className="pt-2">
                      <Button size="sm" variant="outline" asChild>
                        <Link to={`/app/customers/${detailRow.recipientCustomerId}`}>{t('whatsapp.page.activityTab.actions.viewCustomer')}</Link>
                      </Button>
                    </div>
                  )}
                </div>
              </>
            )
          })()}
        </SheetContent>
      </Sheet>
    </div>
  )
}

function DetailRow({ label, value, dir }: { label: string; value: string | null; dir?: 'ltr' | 'rtl' }) {
  if (!value) return null
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-text-secondary">{label}</span>
      <span dir={dir} className="text-end font-medium">{value}</span>
    </div>
  )
}
