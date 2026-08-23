import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'

// NAVIGATION/TABS/RTL AUDIT (2026-08-23): this filter previously had
// no labels at all -- not even visually -- so "من"/"إلى" could only
// be inferred from left/right position. Flexbox in RTL already places
// the first DOM child (startDate) on the right and the second
// (endDate) on the left, which is the correct من→right / إلى→left
// reading order (not reversed by RTL, since this never manually
// swapped order in the first place) -- the missing piece was labeling
// each field so that ordering is confirmed, not just assumed.
export function DateRangeFilter({
  startDate,
  endDate,
  onStart,
  onEnd,
}: {
  startDate: string
  endDate: string
  onStart: (v: string) => void
  onEnd: (v: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-xs text-text-secondary">
        {t('reports.dateFrom')}
        <Input type="date" value={startDate} onChange={(e) => onStart(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-secondary">
        {t('reports.dateTo')}
        <Input type="date" value={endDate} onChange={(e) => onEnd(e.target.value)} />
      </label>
    </div>
  )
}
