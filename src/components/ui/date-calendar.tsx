import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useDirection } from '@/app/providers/DirectionProvider'

// FINAL BOOKINGS UX & LIFECYCLE GAP CLOSURE, Section A: a small,
// dependency-free month calendar for booking date navigation (staff +
// public). Not a generic calendar framework -- bounded to exactly
// what Mal3aby's booking flows need: a month grid, today/selected/
// disabled visual states, month navigation, and a `YYYY-MM-DD`
// value/onSelect contract that matches the plain-string date state
// already used by BookingsPage/BookingsMobileView/PublicClubBookingPage.
//
// Dates are handled purely as calendar-day strings ("YYYY-MM-DD") --
// this component never constructs a `Date` from a date+time pair and
// never converts to/from an Instant itself. The caller is responsible
// for resolving "today" via the club's real timezone (see
// `fromInstant(new Date(), clubTimezone).date`, the established idiom
// in src/lib/domain/time.ts) and passing it in as `todayDate` --
// this component only ever compares plain date strings, so it can
// never regress to a browser-local-timezone "today" itself.

export interface DateCalendarProps {
  /** Selected date, "YYYY-MM-DD". */
  value: string
  onSelect: (date: string) => void
  /** The club-local "today" date string -- caller resolves this via
   *  the club's real IANA timezone, never browser-local. */
  todayDate: string
  /** Inclusive bounds, "YYYY-MM-DD". Dates outside are rendered
   *  disabled (non-interactive) -- convenience only, matching every
   *  server-side enforcement this component sits in front of. */
  minDate?: string
  maxDate?: string
  className?: string
}

const MS_PER_DAY = 86400000

// Exported (not just used internally) so date-calendar.test.ts can
// cover this pure arithmetic directly -- see directive Section I's
// test matrix items 1-6 (today/tomorrow/+7/+30/month boundary/year
// boundary), which are exactly calendar-arithmetic correctness and
// need no DOM/React rendering to verify.
export function parseDateKey(key: string): { year: number; month: number; day: number } {
  const [year = 1970, month = 1, day = 1] = key.split('-').map(Number)
  return { year, month, day }
}

// UTC-anchored Date used purely as a calendar-arithmetic helper (never
// rendered, never converted to an instant) -- avoids any DST/local-
// timezone drift when computing "which weekday does day 1 fall on" or
// "add N days to this calendar date".
export function toUtcDate(key: string): Date {
  const { year, month, day } = parseDateKey(key)
  return new Date(Date.UTC(year, month - 1, day))
}

export function toDateKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function addDaysToKey(key: string, days: number): string {
  return toDateKey(new Date(toUtcDate(key).getTime() + days * MS_PER_DAY))
}

export function addMonths(key: string, delta: number): string {
  const { year, month, day } = parseDateKey(key)
  const d = new Date(Date.UTC(year, month - 1 + delta, 1))
  // Clamp to the target month's own day count (e.g. Jan 31 + 1 month
  // must land on Feb 28/29, not silently roll into March).
  const lastDayOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDayOfTargetMonth))
  return toDateKey(d)
}

export function compareDateKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function DateCalendar({ value, onSelect, todayDate, minDate, maxDate, className }: DateCalendarProps) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const intlLocale = locale === 'en' ? 'en-US' : 'ar-EG'

  // The visible month defaults to the selected date's own month so
  // opening the calendar always shows the currently-selected date,
  // not always "today"'s month.
  const [viewMonth, setViewMonth] = useState(() => `${parseDateKey(value).year}-${String(parseDateKey(value).month).padStart(2, '0')}-01`)

  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(intlLocale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(toUtcDate(viewMonth)),
    [viewMonth, intlLocale],
  )

  const weekdayLabels = useMemo(() => {
    // Sunday-first grid (matches the existing "Today/Tue/Wed" public
    // booking cards and every existing day-of-week convention already
    // in this codebase -- day_of_week 0 = Sunday throughout the schema).
    const formatter = new Intl.DateTimeFormat(intlLocale, { weekday: 'short', timeZone: 'UTC' })
    return Array.from({ length: 7 }, (_, i) => formatter.format(new Date(Date.UTC(2026, 7, 30 + i)))) // 2026-08-30 is a Sunday
  }, [intlLocale])

  const weeks = useMemo(() => {
    const { year, month } = parseDateKey(viewMonth)
    const firstOfMonth = new Date(Date.UTC(year, month - 1, 1))
    const startWeekday = firstOfMonth.getUTCDay() // 0 = Sunday
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()

    const cells: Array<{ key: string; day: number; inMonth: boolean }> = []
    // Leading days from the previous month, so the grid always starts
    // on a Sunday.
    for (let i = 0; i < startWeekday; i++) {
      const d = new Date(Date.UTC(year, month - 1, 1 - (startWeekday - i)))
      cells.push({ key: toDateKey(d), day: d.getUTCDate(), inMonth: false })
    }
    for (let day = 1; day <= daysInMonth; day++) {
      cells.push({ key: toDateKey(new Date(Date.UTC(year, month - 1, day))), day, inMonth: true })
    }
    // Trailing days to complete the final week.
    while (cells.length % 7 !== 0) {
      const last = cells[cells.length - 1]!
      const d = new Date(toUtcDate(last.key).getTime() + MS_PER_DAY)
      cells.push({ key: toDateKey(d), day: d.getUTCDate(), inMonth: false })
    }

    const result: (typeof cells)[] = []
    for (let i = 0; i < cells.length; i += 7) result.push(cells.slice(i, i + 7))
    return result
  }, [viewMonth])

  function isDisabled(key: string): boolean {
    if (minDate && compareDateKeys(key, minDate) < 0) return true
    if (maxDate && compareDateKeys(key, maxDate) > 0) return true
    return false
  }

  // Bug found live in this session's own browser verification: comparing
  // `viewMonth` (always day 01 of the visible month) directly against
  // `maxDate`/`minDate` only disabled navigation once the visible
  // month's OWN 1st fell outside the bound -- e.g. with maxDate =
  // 2026-09-02, viewing September (viewMonth = 2026-09-01) still
  // satisfied `viewMonth < maxDate`, leaving "next month" enabled even
  // though October has nothing selectable at all. Comparing whole
  // months (normalized to each date's own month-start) fixes this:
  // "next month" is disabled once the NEXT month's start would already
  // exceed maxDate's month, not merely maxDate's exact day.
  const viewMonthStart = `${parseDateKey(viewMonth).year}-${String(parseDateKey(viewMonth).month).padStart(2, '0')}-01`
  const minMonthStart = minDate ? `${parseDateKey(minDate).year}-${String(parseDateKey(minDate).month).padStart(2, '0')}-01` : null
  const maxMonthStart = maxDate ? `${parseDateKey(maxDate).year}-${String(parseDateKey(maxDate).month).padStart(2, '0')}-01` : null
  const canGoPrevMonth = !minMonthStart || compareDateKeys(viewMonthStart, minMonthStart) > 0
  const canGoNextMonth = !maxMonthStart || compareDateKeys(viewMonthStart, maxMonthStart) < 0

  return (
    <div className={cn('w-full max-w-[320px]', className)}>
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setViewMonth((m) => addMonths(m, -1))}
          disabled={!canGoPrevMonth}
          aria-label={t('common.calendar.previousMonth')}
          className="flex size-9 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-page-bg disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
        </button>
        <span className="text-sm font-semibold tabular-nums" aria-live="polite">{monthLabel}</span>
        <button
          type="button"
          onClick={() => setViewMonth((m) => addMonths(m, 1))}
          disabled={!canGoNextMonth}
          aria-label={t('common.calendar.nextMonth')}
          className="flex size-9 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-page-bg disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />
        </button>
      </div>

      <div role="grid" aria-label={monthLabel}>
        <div className="grid grid-cols-7 gap-1" role="row">
          {weekdayLabels.map((label, i) => (
            <div key={i} role="columnheader" className="flex h-8 items-center justify-center text-xs font-medium text-text-secondary">
              {label}
            </div>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 gap-1" role="row">
            {week.map((cell) => {
              const disabled = isDisabled(cell.key)
              const isSelected = cell.key === value
              const isToday = cell.key === todayDate
              return (
                <button
                  key={cell.key}
                  type="button"
                  role="gridcell"
                  aria-selected={isSelected}
                  aria-current={isToday ? 'date' : undefined}
                  aria-label={cell.key}
                  disabled={disabled}
                  onClick={() => onSelect(cell.key)}
                  className={cn(
                    'flex size-9 items-center justify-center rounded-md text-sm tabular-nums transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
                    !cell.inMonth && 'text-text-secondary/40',
                    cell.inMonth && !isSelected && 'text-text-primary hover:bg-page-bg',
                    isToday && !isSelected && 'font-semibold text-accent-foreground ring-1 ring-inset ring-accent/40',
                    isSelected && 'bg-accent font-semibold text-dark-base hover:bg-accent',
                    disabled && 'pointer-events-none text-text-secondary/25',
                  )}
                >
                  {cell.day}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
