import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { StatusBadge } from '@/components/ui/status-badge'
import { ErrorState } from '@/components/ui/error-state'
import { EmptyState } from '@/components/ui/empty-state'
import { fetchPaymentInvoiceIds } from '@/lib/domain/billing'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'
import { useAuth } from '@/app/providers/AuthProvider'
import { supabase } from '@/lib/supabase/client'
import { AlertTriangle, CheckCircle2, CreditCard, ShieldAlert } from 'lucide-react'
import { useDateRange } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'
import { ReportPrintButton, ReportPrintHeader } from '@/components/ui/report-print-header'

// PRODUCTION MONITORING (Phase 3, 2026-08-28): surfaces two already-real,
// already-correct pieces of gateway observability that previously had
// NO proactive UI consumer anywhere in the app -- both were queryable
// only via a direct SQL/RPC call, never something a Club Owner/Manager/
// Accountant would ever actually see without knowing to go look:
//
//   1. gateway_reconciliation_report(p_club_id, p_date_from, p_date_to)
//      -- built and verified during Phase 2 (Multi-Gateway Online
//      Payments), read-only, exception-detecting (succeeded transaction
//      with no linked payment, payment with zero allocations, amount
//      mismatch). Never wired into any screen until now.
//   2. payment_gateway_webhook_events.processing_error -- populated by
//      every gateway webhook Edge Function on a processing failure
//      (see supabase/functions/*-gateway-webhook/index.ts), previously
//      only reachable by a staff member manually querying the table.
//
// This is NOT a new source of truth -- both queries read tables/RPCs
// that already existed and were already correct; this page only makes
// them visible without a manual query. Gated on payment.methods.view,
// matching gateway_reconciliation_report's own server-side permission
// check exactly (defense-in-depth UI hint only; the RPC and RLS
// independently re-enforce this regardless of what this component
// renders, per the same pattern PaymentGatewayConnectionsCard.tsx uses).
interface ReconciliationException {
  transaction_id: string
  exception_type: string
  detail: string
}

interface ReconciliationSummary {
  total_transactions: number
  succeeded_transactions: number
  failed_transactions: number
  pending_transactions: number
}

interface GatewayReconciliationReport {
  transactions: {
    transaction_id: string
    gateway: string
    environment: string | null
    status: string
    amount: number
    currency: string
    created_at: string
    payment_id: string | null
  }[]
  exceptions: ReconciliationException[]
  summary: ReconciliationSummary
}

interface WebhookFailureRow {
  id: string
  provider_key: string
  processing_error: string | null
  received_at: string
  processed: boolean
}

function useGatewayReconciliationReport(startDate: string, endDate: string, enabled: boolean) {
  const { currentClubId } = useAuth()
  return useQuery({
    queryKey: ['gateway-reconciliation-report', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('gateway_reconciliation_report', {
        p_club_id: currentClubId!,
        p_date_from: startDate,
        p_date_to: endDate,
      })
      if (error) throw error
      return data as unknown as GatewayReconciliationReport
    },
    enabled: enabled && !!currentClubId,
  })
}

function useWebhookFailures(startDate: string, endDate: string, enabled: boolean) {
  const { currentClubId } = useAuth()
  return useQuery({
    queryKey: ['gateway-webhook-failures', currentClubId, startDate, endDate],
    queryFn: async () => {
      // payment_gateway_webhook_events has no club_id column of its own
      // (a webhook event is scoped by provider/transaction, not
      // directly by club -- see the table's schema) -- so this filters
      // to the current club's own transaction ids first, matching the
      // same tenant-scoping every other report in this module applies,
      // then looks up only the failed ones in that set. Read-only,
      // no write path, RLS still independently governs visibility.
      const { data: txRows, error: txError } = await supabase
        .from('payment_gateway_transactions')
        .select('id')
        .eq('club_id', currentClubId!)
        .gte('created_at', `${startDate}T00:00:00Z`)
        .lte('created_at', `${endDate}T23:59:59Z`)
      if (txError) throw txError
      const txIds = (txRows ?? []).map((r) => r.id)
      if (txIds.length === 0) return [] as WebhookFailureRow[]

      const { data, error } = await supabase
        .from('payment_gateway_webhook_events')
        .select('id, provider_key, processing_error, received_at, processed')
        .in('transaction_id', txIds)
        .not('processing_error', 'is', null)
        .order('received_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as WebhookFailureRow[]
    },
    enabled: enabled && !!currentClubId,
  })
}

export function ReportGatewayHealthContent() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const navigate = useNavigate()
  const { currentMembership } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const canView = currentMembership?.permissionKeys.includes('payment.methods.view') ?? false

  // React Hooks must run unconditionally on every render (rules-of-hooks)
  // -- the `!canView` early return happens AFTER every hook call below,
  // never before. `enabled: canView` is what actually prevents these
  // queries from firing for a user without the permission (defense-in-
  // depth UI hint only, per this file's header comment -- the RPC and
  // RLS independently re-enforce this regardless).
  const reconciliation = useGatewayReconciliationReport(startDate, endDate, canView)
  const webhookFailures = useWebhookFailures(startDate, endDate, canView)

  // gateway_reconciliation_report's exceptions[] deliberately does not
  // carry payment_id (see the RPC's own definition -- it's a lean
  // exception-only projection). Its sibling transactions[] array (same
  // response, same date range) does, so a lookup by transaction_id here
  // avoids needing to touch the RPC itself (Phase 2's gateway RPCs are
  // out of scope for this phase) while still making "view the invoice"
  // a real, working link instead of a fabricated deep-link into a query
  // param FinancePaymentsPage doesn't read.
  const paymentIdByTransactionId = new Map((reconciliation.data?.transactions ?? []).map((tx) => [tx.transaction_id, tx.payment_id]))
  const paymentIds = [...paymentIdByTransactionId.values()].filter((id): id is string => !!id)
  const { data: paymentInvoiceIds } = useQuery({
    queryKey: ['gateway-exception-payment-invoice-ids', paymentIds.join(',')],
    queryFn: () => fetchPaymentInvoiceIds(paymentIds),
    enabled: canView && paymentIds.length > 0,
  })

  const filterSummary = `${startDate} → ${endDate}`

  if (!canView) {
    return <EmptyState icon={ShieldAlert} title={t('reports.gatewayHealth.noAccess')} />
  }

  const isLoading = reconciliation.isLoading || webhookFailures.isLoading
  const isError = reconciliation.isError || webhookFailures.isError
  const error = reconciliation.error ?? webhookFailures.error

  const exceptions = reconciliation.data?.exceptions ?? []
  const failures = webhookFailures.data ?? []
  const hasIssues = exceptions.length > 0 || failures.length > 0

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
        {reconciliation.data && <ReportPrintButton />}
      </div>
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {isError && (
        <ErrorState
          message={translateSupabaseError(error, t('reports.loadError'))}
          onRetry={() => {
            void reconciliation.refetch()
            void webhookFailures.refetch()
          }}
        />
      )}
      {!isLoading && !isError && reconciliation.data && (
        <div className="print-target visible-for-print">
          <ReportPrintHeader reportName={t('reports.gatewayHealth.description')} filterSummary={filterSummary} />

          <div className={`mb-6 flex items-start gap-2 rounded-lg border p-3 text-sm ${hasIssues ? 'border-status-danger/40 bg-status-danger/5 text-status-danger' : 'border-status-success/40 bg-status-success/5 text-status-success'}`}>
            {hasIssues ? <AlertTriangle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
            <p>{hasIssues ? t('reports.gatewayHealth.issuesFound') : t('reports.gatewayHealth.noIssues')}</p>
          </div>

          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label={t('reports.gatewayHealth.totalTransactions')} value={reconciliation.data.summary.total_transactions} icon={CreditCard} />
            <StatCard label={t('reports.gatewayHealth.succeeded')} value={reconciliation.data.summary.succeeded_transactions} />
            <StatCard
              label={t('reports.gatewayHealth.failed')}
              value={reconciliation.data.summary.failed_transactions}
              tone={reconciliation.data.summary.failed_transactions > 0 ? 'danger' : undefined}
            />
            <StatCard label={t('reports.gatewayHealth.pending')} value={reconciliation.data.summary.pending_transactions} />
          </div>

          <div className="mb-6">
            <p className="mb-2 font-medium">{t('reports.gatewayHealth.exceptionsHeading')}</p>
            {exceptions.length === 0 ? (
              <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {exceptions.map((exc) => {
                  const paymentId = paymentIdByTransactionId.get(exc.transaction_id)
                  const invoiceId = paymentId ? paymentInvoiceIds?.get(paymentId) : undefined
                  return (
                    <li key={exc.transaction_id} className="rounded-md border border-status-danger/30 bg-status-danger/5 p-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <StatusBadge tone="danger" label={t(`reports.gatewayHealth.exceptionTypes.${exc.exception_type}`, { defaultValue: exc.exception_type })} />
                        {invoiceId && (
                          <button
                            className="text-xs text-accent-foreground hover:underline"
                            onClick={() => navigate(`/app/finance/payments?invoice=${invoiceId}`)}
                          >
                            {t('reports.gatewayHealth.viewInvoice')}
                          </button>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">{exc.detail}</p>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div>
            <p className="mb-2 font-medium">{t('reports.gatewayHealth.webhookFailuresHeading')}</p>
            {failures.length === 0 ? (
              <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {failures.map((f) => (
                  <li key={f.id} className="rounded-md border border-status-warning/30 bg-status-warning/5 p-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      {/* provider_key is a small internal enum value
                          ("stripe"/"paypal"/"paymob"/"kashier"/"fawry"),
                          not free text -- safe to render verbatim, no
                          dedicated label catalogue exists for it yet. */}
                      <span className="font-medium capitalize">{f.provider_key}</span>
                      <span className="text-xs text-text-secondary tabular-nums">
                        {new Date(f.received_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}
                      </span>
                    </div>
                    {/* processing_error is already a sanitized string by
                        construction -- every webhook Edge Function writes
                        it via its own sanitize*Error()/rpcError.message
                        path (never a raw provider response body), same
                        discipline as the gateway functions themselves. */}
                    <p className="mt-1 text-xs text-status-warning">{f.processing_error}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="mt-6 text-xs text-text-secondary">{t('reports.gatewayHealth.emptyIsExpected')}</p>
        </div>
      )}
    </div>
  )
}

export function ReportGatewayHealthPage() {
  const { t } = useTranslation()
  return (
    <div>
      <div className="print:hidden">
        <PageHeader title={t('reports.title')} description={t('reports.gatewayHealth.description')} />
        <ReportsNav />
      </div>
      <ReportGatewayHealthContent />
    </div>
  )
}
