import { Input } from '@/components/ui/input'

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
  return (
    <div className="mb-4 flex gap-2">
      <Input type="date" value={startDate} onChange={(e) => onStart(e.target.value)} />
      <Input type="date" value={endDate} onChange={(e) => onEnd(e.target.value)} />
    </div>
  )
}
