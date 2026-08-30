import { CalendarDays } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DateCalendar } from '@/components/ui/date-calendar'
import { useState } from 'react'

// FINAL BOOKINGS UX & LIFECYCLE GAP CLOSURE, Section A1/A2: the
// clickable "[ 31 August 2026 📅 ]" control the directive asks for,
// wrapping DateCalendar in a Dialog. Shared by staff Bookings and
// Public Booking -- one implementation, not two near-duplicates.
export interface DatePickerButtonProps {
  /** Already-formatted display label for the trigger button (caller
   *  formats via formatDate/formatInstant with the correct venue
   *  timezone + locale -- this component never formats dates itself). */
  label: string
  value: string
  onSelect: (date: string) => void
  todayDate: string
  minDate?: string
  maxDate?: string
  className?: string
}

export function DatePickerButton({ label, value, onSelect, todayDate, minDate, maxDate, className }: DatePickerButtonProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('common.calendar.openPicker')}
        className={className ?? 'flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-page-bg'}
      >
        <CalendarDays className="size-4 text-text-secondary" aria-hidden="true" />
        <span className="tabular-nums">{label}</span>
      </button>
      <DialogContent className="w-auto max-w-none p-4 sm:max-w-none">
        <DialogHeader>
          <DialogTitle className="text-base">{t('common.calendar.openPicker')}</DialogTitle>
        </DialogHeader>
        <DateCalendar
          value={value}
          todayDate={todayDate}
          minDate={minDate}
          maxDate={maxDate}
          onSelect={(date) => {
            onSelect(date)
            setOpen(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
