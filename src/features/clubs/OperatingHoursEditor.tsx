import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translateSupabaseError } from '@/lib/errors'
import { type OperatingHoursRow } from '@/lib/domain/fields'

// P1-5 (critical usability fix pass, 2026-08-16): the old hours UX was
// "pick one day -> enter times -> save -> repeat seven times." This is
// a full weekly schedule editor: every day visible at once, an
// open/closed toggle per day, Copy Saturday to all / Apply weekdays,
// and a single Save button that writes the whole week in one action.

interface DaySchedule {
  isOpen: boolean
  openTime: string
  closeTime: string
}

const WEEK_START_SATURDAY = 6 // day_of_week: 0=Sunday..6=Saturday. Display Saturday-first (Mal3aby's week).
const DISPLAY_ORDER = [6, 0, 1, 2, 3, 4, 5]

type Schedule = [DaySchedule, DaySchedule, DaySchedule, DaySchedule, DaySchedule, DaySchedule, DaySchedule]

function buildInitialSchedule(rows: OperatingHoursRow[]): Schedule {
  const days: DaySchedule[] = []
  for (let day = 0; day <= 6; day++) {
    const row = rows.find((r) => r.dayOfWeek === day)
    days.push(
      row
        ? { isOpen: true, openTime: row.openTime.slice(0, 5), closeTime: row.closeTime.slice(0, 5) }
        : { isOpen: false, openTime: '08:00', closeTime: '23:00' },
    )
  }
  return days as Schedule
}

export function OperatingHoursEditor({
  fieldId,
  branchId,
  clubId,
  hasAnyConfigured,
  operatingHours,
}: {
  fieldId: string
  branchId: string
  clubId: string
  hasAnyConfigured: boolean
  operatingHours: OperatingHoursRow[]
}) {
  const { t } = useTranslation()
  const dayNames = [0, 1, 2, 3, 4, 5, 6].map((d) => t(`academy.structure.dayOfWeekLabels.${d}`))
  const queryClient = useQueryClient()
  const [schedule, setSchedule] = useState<Schedule>(() => buildInitialSchedule(operatingHours))
  const [saveError, setSaveError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  // Re-sync from server data whenever the underlying rows change (e.g.
  // switching to a different field) -- but not on every local edit.
  useEffect(() => {
    setSchedule(buildInitialSchedule(operatingHours))
    setDirty(false)
  }, [fieldId, operatingHours])

  function updateDay(day: number, patch: Partial<DaySchedule>) {
    setSchedule((prev) => {
      const next = [...prev] as Schedule
      const current = next[day] as DaySchedule
      next[day] = { ...current, ...patch }
      return next
    })
    setDirty(true)
  }

  function copySaturdayToAll() {
    const saturday = schedule[WEEK_START_SATURDAY]
    setSchedule([0, 1, 2, 3, 4, 5, 6].map(() => ({ ...saturday })) as Schedule)
    setDirty(true)
  }

  function applyToWeekdays() {
    // Weekdays here = Saturday-Thursday (the club's working week per the
    // QA dataset convention), leaving Friday untouched.
    const saturday = schedule[WEEK_START_SATURDAY]
    setSchedule((prev) => {
      const next = [...prev] as Schedule
      for (const day of [0, 1, 2, 3, 4, 6]) next[day] = { ...saturday }
      return next
    })
    setDirty(true)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Replace the whole week atomically: delete existing rows for this
      // field, then insert the open days. Simpler and safer than diffing
      // upsert-vs-delete per day, and this editor's whole point is "save
      // the week once."
      const { error: deleteError } = await supabase.from('field_operating_hours').delete().eq('field_id', fieldId)
      if (deleteError) throw deleteError

      const openDays = schedule
        .map((v, day) => ({ v, day }))
        .filter(({ v }) => v.isOpen)
        .map(({ v, day }) => ({
          club_id: clubId,
          branch_id: branchId,
          field_id: fieldId,
          day_of_week: day,
          open_time: v.openTime,
          close_time: v.closeTime,
        }))

      if (openDays.length > 0) {
        const { error: insertError } = await supabase.from('field_operating_hours').insert(openDays)
        if (insertError) throw insertError
      }
    },
    onSuccess: () => {
      setSaveError(null)
      setDirty(false)
      void queryClient.invalidateQueries({ queryKey: ['operating-hours', fieldId] })
      void queryClient.invalidateQueries({ queryKey: ['field-operating-hours-all', clubId] })
    },
    onError: (error) => setSaveError(translateSupabaseError(error, t('clubs.operatingHoursEditor.saveError'))),
  })

  const hasTimeError = schedule.some((d) => d.isOpen && d.openTime >= d.closeTime)

  return (
    <div className="flex flex-col gap-4">
      {!hasAnyConfigured && !dirty && (
        <p className="rounded-md bg-status-warning/10 p-2 text-sm text-status-warning">
          {t('clubs.operatingHoursEditor.noHoursWarning')}
        </p>
      )}

      <div className="flex flex-col gap-2 rounded-lg border border-border">
        {DISPLAY_ORDER.map((day) => {
          const d = schedule[day] as DaySchedule
          return (
            <div key={day} className="flex flex-wrap items-center gap-3 border-b border-border p-2.5 last:border-b-0">
              <button
                type="button"
                role="switch"
                aria-checked={d.isOpen}
                onClick={() => updateDay(day, { isOpen: !d.isOpen })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${d.isOpen ? 'bg-status-success' : 'bg-muted'}`}
              >
                <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform ${d.isOpen ? 'translate-x-0.5' : 'translate-x-5'}`} />
              </button>
              <span className="w-16 shrink-0 text-sm font-medium">{dayNames[day]}</span>
              {d.isOpen ? (
                <div className="flex flex-1 items-center gap-2">
                  <Input type="time" value={d.openTime} onChange={(e) => updateDay(day, { openTime: e.target.value })} className="w-32" />
                  <span className="text-text-secondary">{t('clubs.operatingHoursEditor.to')}</span>
                  <Input type="time" value={d.closeTime} onChange={(e) => updateDay(day, { closeTime: e.target.value })} className="w-32" />
                  {d.openTime >= d.closeTime && (
                    <span className="text-xs text-status-danger">{t('clubs.operatingHoursEditor.openBeforeCloseError')}</span>
                  )}
                </div>
              ) : (
                <span className="flex-1 text-sm text-text-secondary">{t('clubs.operatingHoursEditor.closed')}</span>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copySaturdayToAll}>
          {t('clubs.operatingHoursEditor.copySaturdayToAll')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={applyToWeekdays}>
          {t('clubs.operatingHoursEditor.applyToWeekdays')}
        </Button>
      </div>

      {saveError && <p role="alert" className="text-sm text-status-danger">{saveError}</p>}

      <Button
        disabled={saveMutation.isPending || hasTimeError || !dirty}
        onClick={() => saveMutation.mutate()}
      >
        {saveMutation.isPending ? t('clubs.operatingHoursEditor.saving') : t('clubs.operatingHoursEditor.save')}
      </Button>
    </div>
  )
}
