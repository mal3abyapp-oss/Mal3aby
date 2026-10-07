import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useDirection } from '@/app/providers/DirectionProvider'
import { useRentalContracts, useRentalPermissions } from './hooks'
import type { RentalContractRow, RentalSpaceRow } from './types'

// Availability calendar for one space (wedding/event halls in
// particular): a month grid showing which days are taken and by whom,
// with the hours of hourly bookings, so staff can see free slots before
// booking. Occupancy uses the same rule as the server's overlap check:
// a lease occupies start_date .. (termination_date ?? end_date);
// cancelled leases free their dates.

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function occupancyEnd(c: RentalContractRow): string {
  return c.termination_date && c.termination_date < c.end_date ? c.termination_date : c.end_date
}

const short = (time: string | null) => (time ? time.slice(0, 5) : '')

export function SpaceCalendarDialog({
  space, onClose, onOpenContract, onNewBooking,
}: {
  space: RentalSpaceRow
  onClose: () => void
  onOpenContract: (contractId: string) => void
  onNewBooking: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { canCreateContracts } = useRentalPermissions()
  const { data: contracts = [], isLoading } = useRentalContracts({ spaceId: space.id })
  const [month, setMonth] = useState(() => {
    const now = new Date()
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))
  })

  const live = contracts.filter((c) => c.status !== 'cancelled')
  const today = iso(new Date())

  const days = useMemo(() => {
    const first = new Date(month)
    const lead = first.getUTCDay() // Sunday-first grid
    const daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
    const cells: (string | null)[] = Array.from({ length: lead }, () => null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), d))))
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [month])

  const weekdayNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ar-EG', { weekday: 'short', timeZone: 'UTC' })
    // 2026-10-04 is a Sunday.
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2026, 9, 4 + i))))
  }, [locale])

  const monthLabel = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ar-EG', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(month)

  function shift(delta: number) {
    setMonth((m) => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + delta, 1)))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{t('rentals.calendar.title', { name: space.name })}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" aria-label={t('rentals.calendar.prev')} onClick={() => shift(-1)}>
                <ChevronLeft className="size-4 rtl:rotate-180" />
              </Button>
              <span className="min-w-32 text-center font-medium">{monthLabel}</span>
              <Button size="sm" variant="ghost" aria-label={t('rentals.calendar.next')} onClick={() => shift(1)}>
                <ChevronRight className="size-4 rtl:rotate-180" />
              </Button>
            </div>
            {canCreateContracts && space.status === 'active' && (
              <Button size="sm" onClick={onNewBooking}><Plus />{t('rentals.calendar.newBooking')}</Button>
            )}
          </div>

          {isLoading ? (
            <p className="text-sm text-text-secondary">…</p>
          ) : (
            <div className="grid grid-cols-7 gap-1 text-xs">
              {weekdayNames.map((n) => (
                <div key={n} className="p-1 text-center font-medium text-text-secondary">{n}</div>
              ))}
              {days.map((day, idx) => {
                if (!day) return <div key={`e${idx}`} />
                const taken = live.filter((c) => c.start_date <= day && occupancyEnd(c) >= day)
                return (
                  <div
                    key={day}
                    className={cn(
                      'flex min-h-16 flex-col gap-0.5 rounded-md border p-1',
                      taken.length > 0 ? 'border-accent/40 bg-accent/10' : 'border-border-subtle',
                      day === today && 'ring-2 ring-accent',
                    )}
                  >
                    <span className="tabular-nums text-text-secondary">{Number(day.slice(8))}</span>
                    {taken.slice(0, 3).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="truncate rounded bg-surface px-1 text-start hover:underline"
                        title={`${c.customer_name} · ${c.contract_number}`}
                        onClick={() => onOpenContract(c.id)}
                      >
                        {c.start_time ? <bdi className="tabular-nums">{short(c.start_time)}–{short(c.end_time)} </bdi> : null}
                        {c.customer_name}
                      </button>
                    ))}
                    {taken.length > 3 && <span className="text-text-secondary">+{taken.length - 3}</span>}
                  </div>
                )
              })}
            </div>
          )}
          <p className="text-xs text-text-secondary">{t('rentals.calendar.legend')}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
