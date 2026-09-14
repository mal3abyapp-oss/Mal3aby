import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CheckCircle2, Circle, Clock, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

// FULL-PLATFORM AUDIT FIX (2026-09-14, design-system-violation finding):
// docs/DESIGN_SYSTEM.md's "Academy & Attendance UX" rule states
// verbatim: "Attendance marking is mobile-first: one row per player
// (photo optional, name, status), a single tap cycles or sets status
// -- never a multi-step form per player." Both CoachTodayView.tsx and
// AttendanceSection.tsx previously rendered FOUR separate size="sm"
// (32px) buttons per player row -- closer to a multi-step form than a
// single-tap control, and well below a thumb-friendly touch target
// when four must fit beside a player name on a coach's phone.
//
// This is the ONE shared implementation both call sites now use
// (matching this codebase's own established "one shared
// implementation, not two near-duplicates" convention -- see
// AttendanceSection.tsx's own header comment about mark_attendance
// itself). A single button shows the CURRENT status (icon + label,
// colored per status -- status is never color-only, matching
// DESIGN_SYSTEM.md's color-token rule) and cycles present -> absent ->
// excused -> late -> present on each tap. Uses the new Button
// size="touch" variant (44px) for a real thumb target, not the
// previous 32px size="sm".
const STATUS_CYCLE = ['present', 'absent', 'excused', 'late'] as const
type AttendanceStatus = (typeof STATUS_CYCLE)[number]

const STATUS_ICON: Record<AttendanceStatus, typeof CheckCircle2> = {
  present: CheckCircle2,
  absent: XCircle,
  excused: Circle,
  late: Clock,
}

const STATUS_TONE_CLASS: Record<AttendanceStatus, string> = {
  present: 'border-status-success/40 bg-status-success/10 text-status-success hover:bg-status-success/15',
  absent: 'border-status-danger/40 bg-status-danger/10 text-status-danger hover:bg-status-danger/15',
  excused: 'border-status-neutral/40 bg-status-neutral/10 text-status-neutral hover:bg-status-neutral/15',
  late: 'border-status-warning/40 bg-status-warning/10 text-status-warning hover:bg-status-warning/15',
}

export function AttendanceStatusControl({
  playerName,
  status,
  onChange,
  disabled,
}: {
  playerName: string
  status: string | null
  onChange: (next: AttendanceStatus) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const current = (STATUS_CYCLE as readonly string[]).includes(status ?? '') ? (status as AttendanceStatus) : null
  const currentIndex = current ? STATUS_CYCLE.indexOf(current) : -1
  const Icon = current ? STATUS_ICON[current] : Circle
  const label = current ? t(`academy.coachToday.attendanceLabels.${current}`) : t('academy.coachToday.attendanceLabels.unmarked')

  function handleClick() {
    const nextIndex = (currentIndex + 1) % STATUS_CYCLE.length
    onChange(STATUS_CYCLE[nextIndex]!)
  }

  return (
    <Button
      type="button"
      size="touch"
      variant="outline"
      disabled={disabled}
      onClick={handleClick}
      className={cn('min-w-32 justify-start gap-2 border', current ? STATUS_TONE_CLASS[current] : 'text-text-secondary')}
      aria-label={t('academy.coachToday.attendanceCycleAria', { name: playerName, status: label })}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {label}
    </Button>
  )
}
