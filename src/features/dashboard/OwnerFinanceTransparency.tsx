import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatMoney } from '@/lib/domain/billing'
import { useDirection } from '@/app/providers/DirectionProvider'

// Gate 13 #61: an owner finance transparency section, right on the page
// they land on daily -- not another report they have to remember to open.
// Reuses the RPCs already built for #58 (collections by employee) and #59
// (financial exceptions), scoped to today only, so "who collected what
// today" and "did anything unusual happen today" are visible at a glance
// without navigating into Reports. club_owner only -- this is owner-facing
// financial oversight, not an operational task list like AttentionNeeded.
interface CollectionsByEmployee {
  user_id: string | null
  full_name: string
  amount: number
  payment_count: number
}

interface TodayFinanceSummary {
  byEmployee: CollectionsByEmployee[]
  discountsToday: number
  refundsToday: number
}

async function fetchTodayFinance(clubId: string): Promise<TodayFinanceSummary> {
  const today = new Date().toISOString().slice(0, 10)

  const [collectionsRes, exceptionsRes] = await Promise.all([
    supabase.rpc('get_collections_report', { p_club_id: clubId, p_start_date: today, p_end_date: today }),
    supabase.rpc('get_financial_exceptions_report', { p_club_id: clubId, p_start_date: today, p_end_date: today }),
  ])

  if (collectionsRes.error) throw collectionsRes.error
  if (exceptionsRes.error) throw exceptionsRes.error

  const collections = collectionsRes.data as unknown as { by_employee: CollectionsByEmployee[] }
  const exceptions = exceptionsRes.data as unknown as { total_discounts: number; total_refunds: number }

  return {
    byEmployee: collections.by_employee ?? [],
    discountsToday: exceptions.total_discounts ?? 0,
    refundsToday: exceptions.total_refunds ?? 0,
  }
}

export function OwnerFinanceTransparency() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const navigate = useNavigate()
  const { locale } = useDirection()

  const { data, isLoading } = useQuery({
    queryKey: ['owner-finance-transparency', currentClubId],
    queryFn: () => fetchTodayFinance(currentClubId!),
    enabled: !!currentClubId,
    refetchInterval: 60_000,
  })

  if (isLoading || !data) return null

  const hasExceptions = data.discountsToday > 0 || data.refundsToday > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('dashboard.ownerFinanceTransparency.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {data.byEmployee.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('dashboard.ownerFinanceTransparency.noCollectionsToday')}</p>
        ) : (
          <div>
            <p className="mb-1 text-xs font-medium text-text-secondary">{t('dashboard.ownerFinanceTransparency.collectionsByEmployee')}</p>
            <ul className="flex flex-col gap-1">
              {data.byEmployee.map((e) => (
                <li key={e.user_id ?? 'unknown'} className="flex justify-between rounded-md border border-border p-2 text-sm">
                  <span>{e.full_name}</span>
                  <span>{formatMoney(e.amount, 'EGP', locale)} — {t('dashboard.ownerFinanceTransparency.paymentCount', { count: e.payment_count })}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Master IA/UX audit (Reports decomposition phase): Reports is
            no longer one tabbed screen -- link straight to the
            Exceptions report instead of the generic Overview, since
            that's exactly what this alert is about. */}
        {hasExceptions && (
          <button
            onClick={() => navigate('/app/reports/exceptions')}
            className="flex items-center justify-between gap-2 rounded-md border border-status-warning/40 bg-status-warning/5 p-2.5 text-start text-sm hover:bg-status-warning/10"
          >
            <span>{t('dashboard.ownerFinanceTransparency.hasExceptionsToday')}</span>
            <span className="text-xs text-text-secondary tabular-nums">
              {data.discountsToday > 0 && t('dashboard.ownerFinanceTransparency.discounts', { amount: formatMoney(data.discountsToday, 'EGP', locale) })}
              {data.discountsToday > 0 && data.refundsToday > 0 && ' — '}
              {data.refundsToday > 0 && t('dashboard.ownerFinanceTransparency.refunds', { amount: formatMoney(data.refundsToday, 'EGP', locale) })}
            </span>
          </button>
        )}
      </CardContent>
    </Card>
  )
}
