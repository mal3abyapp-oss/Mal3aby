import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { StatCard } from '@/components/ui/stat-card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ReportPrintHeader } from '@/components/ui/report-print-header'
import { useDateRange } from '@/features/reports/hooks/useDateRangeReport'
import { ReportHeaderActions } from '@/features/shop/reports/shopReportShared'
import { TrendingUp, DollarSign, PieChart, AlertTriangle } from 'lucide-react'

const ALL_VALUE = '__all__'

interface CategoryOption { id: string; label: string }

// Commerce Pro C7 -- report suite item 14 (GROSS PROFIT / MARGIN). The
// single most important honesty requirement in this whole phase: any
// sale line whose unit_cost_snapshot is null (created before the
// column existed, or whose unit had never been received via
// receive_shop_stock at time of sale) is EXCLUDED from every money
// figure here -- never treated as zero cost (which would fabricate a
// 100% margin on exactly the sales this feature can least afford to be
// wrong about). get_shop_gross_profit (this phase's own RPC) enforces
// this structurally: it returns known-cost aggregates AND a separate
// cost_unavailable_lines/cost_unavailable_revenue pair, so this
// component can show both "the real, measurable profit" and an
// explicit, unmissable "N lines / EGP X of revenue not included"
// notice side by side -- never a silent gap.
export function ReportShopGrossProfitContent() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const [categoryId, setCategoryId] = useState(ALL_VALUE)

  const { data: categories = [] } = useQuery({
    queryKey: ['shop-report-gp-categories', currentClubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_shop_categories', { p_club_id: currentClubId as string })
      if (error) throw error
      return (data ?? []).map((c) => ({ id: c.category_id, label: c.name_ar })) as CategoryOption[]
    },
    enabled: !!currentClubId,
  })

  const { data, isLoading, isError } = useQuery({
    queryKey: ['shop-report-gross-profit', currentClubId, startDate, endDate, categoryId],
    queryFn: async () => {
      const { data: row, error } = await supabase.rpc('get_shop_gross_profit', {
        p_club_id: currentClubId as string, p_start_date: startDate || undefined, p_end_date: endDate || undefined,
        p_category_id: categoryId === ALL_VALUE ? undefined : categoryId,
      }).maybeSingle()
      if (error) throw error
      return row
    },
    enabled: !!currentClubId,
  })

  if (isError) {
    return <p className="py-8 text-center text-sm text-status-danger" data-testid="report-gross-profit-permission-denied">{t('shop.reports.permissionDenied')}</p>
  }

  const knownLines = Number(data?.known_cost_lines ?? 0)
  const unknownLines = Number(data?.cost_unavailable_lines ?? 0)
  const hasUnknown = unknownLines > 0

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2 print:hidden">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.sales.filters.startDate')}</label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.sales.filters.endDate')}</label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('shop.sales.filters.category')}</label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_VALUE}>{t('shop.sales.filters.allCategories')}</SelectItem>
                {categories.map((c) => <SelectItem key={c.id} value={c.id}><bdi>{c.label}</bdi></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <ReportHeaderActions hasRows={!isLoading && !!data} />
      </div>

      <div className="print-target visible-for-print">
        <ReportPrintHeader reportName={t('shop.reports.gp.title')} />

        {!isLoading && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 p-3 text-sm text-status-warning" data-testid="report-gross-profit-honesty-notice" data-has-gap={hasUnknown}>
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">{t('shop.reports.gp.honestyNoticeTitle')}</p>
              <p className="mt-0.5 text-text-secondary">
                {hasUnknown
                  ? t('shop.reports.gp.honestyNoticeWithGap', { lines: unknownLines, revenue: Number(data?.cost_unavailable_revenue ?? 0).toFixed(2) })
                  : t('shop.reports.gp.honestyNoticeNoGap')}
              </p>
            </div>
          </div>
        )}

        <p className="mb-1.5 text-xs font-medium text-text-secondary">{t('shop.reports.gp.grossSectionLabel')}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="report-gross-profit-stats">
          <StatCard label={t('shop.reports.gp.revenue')} value={<span data-testid="report-gross-profit-revenue"><MoneyDisplay amount={Number(data?.revenue_known_cost ?? 0)} size="md" /></span>} icon={DollarSign} />
          <StatCard label={t('shop.reports.gp.cogs')} value={<MoneyDisplay amount={Number(data?.cost_of_goods ?? 0)} size="md" />} icon={PieChart} />
          <StatCard label={t('shop.reports.gp.grossProfit')} value={<span data-testid="report-gross-profit-gross-profit"><MoneyDisplay amount={Number(data?.gross_profit ?? 0)} size="md" /></span>} icon={TrendingUp} tone={Number(data?.gross_profit ?? 0) >= 0 ? 'success' : 'danger'} />
          <StatCard label={t('shop.reports.gp.marginPct')} value={<span data-testid="report-gross-profit-margin-pct">{`${Number(data?.margin_pct ?? 0).toFixed(1)}%`}</span>} icon={TrendingUp} />
        </div>

        {/* Found during a post-close live QA pass (2026-08-28): a fully
            (or partially) refunded sale's original revenue/cost still
            counted in full toward the GROSS figures above, with no way
            to see the return-adjusted reality -- a club owner could be
            shown paper profit from merchandise that was physically
            returned and refunded. Fixed at the RPC layer
            (get_shop_gross_profit now also returns net_* columns,
            proportionally excluding each line's returned quantity) and
            surfaced here as a clearly separate, clearly labeled second
            row -- the gross figures above are NOT replaced (still valid
            as "gross"), this is the honest net-of-returns counterpart
            shown alongside them, not instead of them. */}
        <p className="mb-1.5 mt-4 text-xs font-medium text-text-secondary">{t('shop.reports.gp.netSectionLabel')}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="report-gross-profit-net-stats">
          <StatCard label={t('shop.reports.gp.netRevenue')} value={<span data-testid="report-gross-profit-net-revenue"><MoneyDisplay amount={Number(data?.net_revenue_known_cost ?? 0)} size="md" /></span>} icon={DollarSign} />
          <StatCard label={t('shop.reports.gp.netCogs')} value={<MoneyDisplay amount={Number(data?.net_cost_of_goods ?? 0)} size="md" />} icon={PieChart} />
          <StatCard label={t('shop.reports.gp.netGrossProfit')} value={<span data-testid="report-gross-profit-net-gross-profit"><MoneyDisplay amount={Number(data?.net_gross_profit ?? 0)} size="md" /></span>} icon={TrendingUp} tone={Number(data?.net_gross_profit ?? 0) >= 0 ? 'success' : 'danger'} />
          <StatCard label={t('shop.reports.gp.netMarginPct')} value={<span data-testid="report-gross-profit-net-margin-pct">{`${Number(data?.net_margin_pct ?? 0).toFixed(1)}%`}</span>} icon={TrendingUp} />
        </div>

        <p className="mt-4 text-xs text-text-secondary">
          {t('shop.reports.gp.coverageNote', { known: knownLines, unknown: unknownLines })}
        </p>
      </div>
    </div>
  )
}
