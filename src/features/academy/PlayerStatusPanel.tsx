import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { fetchInvoicePaymentSummaries } from '@/lib/domain/billing'

// Section I4 — Player Profile: a player's own detail dialog previously
// showed only name/DOB/gender/status + guardians + QR -- none of the
// group/subscription/financial/attendance state a receptionist or
// academy manager actually needs when a parent asks "where does my
// child stand." This summary panel surfaces all of it directly.

interface EnrollmentStatus {
  groupName: string | null
  subscriptionStatus: string | null
  startDate: string | null
  endDate: string | null
  effectiveEndDate: string | null
  outstanding: number
}

interface PlayerStatus {
  enrollments: EnrollmentStatus[]
  attendanceRate: number | null
  attendanceCount: { present: number; total: number }
}

// Master IA/UX audit (multi-enrollment fixture verification phase):
// confirmed a REAL bug via a live fixture, not just code-reading -- a
// player with 2 simultaneous active enrollments (a real, supported
// scenario per the enrollments table's own schema, which has no
// unique/exclusion constraint on player_id) hit `.maybeSingle()` here,
// which errors/returns null on >1 row, silently falling through to
// "هذا اللاعب غير مسجّل في أي مجموعة حاليًا" (not enrolled in any
// group) despite two real active enrollments existing. Now fetches
// ALL active enrollments and renders one card per enrollment.
async function fetchPlayerStatus(playerId: string): Promise<PlayerStatus> {
  const { data: enrollments } = await supabase
    .from('enrollments')
    .select('id, group_id, groups(name)')
    .eq('player_id', playerId)
    .eq('status', 'active')

  const enrollmentStatuses = await Promise.all(
    (enrollments ?? []).map(async (enrollment): Promise<EnrollmentStatus> => {
      let subscriptionStatus: string | null = null
      let startDate: string | null = null
      let endDate: string | null = null
      let effectiveEndDate: string | null = null
      let outstanding = 0

      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('id, status, start_date, end_date, price, discount, invoice_id')
        .eq('enrollment_id', enrollment.id)
        .maybeSingle()

      if (subscription) {
        subscriptionStatus = subscription.status
        startDate = subscription.start_date
        endDate = subscription.end_date
        effectiveEndDate = subscription.end_date

        const { data: effectiveEnd } = await supabase.rpc('get_subscription_effective_end_date', { p_subscription_id: subscription.id })
        if (effectiveEnd) effectiveEndDate = effectiveEnd as string

        // Master Payment Directive task #81: was total - sum(payment_allocations)
        // computed locally from the subscription's own price/discount, missing
        // refund netting -- a subscription invoice paid in full then refunded
        // showed 0 outstanding here. Now reads get_invoice_payment_summary()
        // against the invoice's actual total, the single source of truth (see
        // AUTONOMOUS_DECISION_LOG.md D-015).
        if (subscription.invoice_id) {
          const summaries = await fetchInvoicePaymentSummaries([subscription.invoice_id])
          outstanding = summaries.get(subscription.invoice_id)?.outstanding ?? 0
        }
      }

      return {
        groupName: (enrollment.groups as unknown as { name: string } | null)?.name ?? null,
        subscriptionStatus,
        startDate,
        endDate,
        effectiveEndDate,
        outstanding,
      }
    }),
  )

  const { data: attendanceRows } = await supabase.from('attendance').select('status').eq('player_id', playerId)
  const total = attendanceRows?.length ?? 0
  const present = (attendanceRows ?? []).filter((a) => a.status === 'present').length

  return {
    enrollments: enrollmentStatuses,
    attendanceRate: total > 0 ? Math.round((present / total) * 100) : null,
    attendanceCount: { present, total },
  }
}

export function PlayerStatusPanel({ playerId }: { playerId: string }) {
  const { t } = useTranslation()

  const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
    pending: t('academy.subscriptionStatusLabels.pending'),
    active: t('academy.subscriptionStatusLabels.active'),
    frozen: t('academy.subscriptionStatusLabels.frozen'),
    expired: t('academy.subscriptionStatusLabels.expired'),
    cancelled: t('academy.subscriptionStatusLabels.cancelled'),
  }

  const { data, isLoading } = useQuery({
    queryKey: ['player-status', playerId],
    queryFn: () => fetchPlayerStatus(playerId),
    enabled: !!playerId,
  })

  if (isLoading || !data) return <p className="text-sm text-text-secondary">{t('academy.playerStatus.loading')}</p>

  if (data.enrollments.length === 0) {
    return <p className="rounded-md bg-muted/30 p-2 text-sm text-text-secondary">{t('academy.playerStatus.notEnrolled')}</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Live-verified via a real fixture (same player, 2 simultaneous
          active enrollments in different groups): both now render as
          separate cards instead of one enrollment silently winning and
          hiding the other. */}
      {data.enrollments.map((enrollment, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium">{enrollment.groupName}</span>
            {enrollment.subscriptionStatus && (
              <StatusBadge
                tone={enrollment.subscriptionStatus === 'active' ? 'success' : enrollment.subscriptionStatus === 'frozen' ? 'warning' : enrollment.subscriptionStatus === 'pending' ? 'warning' : 'neutral'}
                label={SUBSCRIPTION_STATUS_LABELS[enrollment.subscriptionStatus] ?? enrollment.subscriptionStatus}
              />
            )}
          </div>
          {enrollment.startDate && enrollment.endDate && (
            <p className="text-text-secondary">
              {t('academy.playerStatus.dateRange', { start: enrollment.startDate, end: enrollment.endDate })}
              {enrollment.effectiveEndDate && enrollment.effectiveEndDate !== enrollment.endDate && (
                <span className="text-status-warning">{t('academy.playerStatus.effectiveEndSuffix', { date: enrollment.effectiveEndDate })}</span>
              )}
            </p>
          )}
          <div className="flex items-center justify-between">
            <span className="text-text-secondary">{t('academy.playerStatus.outstanding')}</span>
            {enrollment.outstanding > 0 ? (
              <MoneyDisplay amount={enrollment.outstanding} tone="danger" size="sm" />
            ) : (
              <span className="text-status-success">{t('academy.playerStatus.fullyPaid')}</span>
            )}
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 p-3 text-sm">
        <span className="text-text-secondary">{t('academy.playerStatus.attendanceRate')}</span>
        {data.attendanceRate != null ? (
          <span className="tabular-nums font-medium"><bdi>{data.attendanceRate}% ({data.attendanceCount.present}/{data.attendanceCount.total})</bdi></span>
        ) : (
          <span className="text-text-secondary">{t('academy.playerStatus.noAttendanceRecord')}</span>
        )}
      </div>
    </div>
  )
}
