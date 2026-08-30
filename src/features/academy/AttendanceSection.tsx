import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CheckCircle2, Circle, XCircle } from 'lucide-react'

// Academy radical simplification directive section 24: attendance is a
// real operational function -- kept, but reachable directly from the
// Academy nav for managers/receptionists too, not only via the
// coach-only Today view. Reuses the exact same mark_attendance RPC
// CoachTodayView already uses (directive: "one shared implementation").
interface SessionRow {
  id: string
  groupId: string
  groupName?: string
  sessionDate: string
  startTime: string
  endTime: string
}

// Live QA E2E (2026-08-20) surfaced a real gap: training_sessions rows
// only ever get created by generate_training_sessions(), which itself
// requires group_schedule_slots -- the legacy weekly-schedule
// machinery the radical simplification directive explicitly demoted
// (section 27: "never force the user to deal with it"). A membership
// created through the new minimal Create Membership flow has no
// schedule slots at all, so it could never produce a session and
// attendance could never be recorded for it -- directly contradicting
// section 24 ("do not make attendance depend on building a complex
// Program/Season/Group construction"). This is the fixed start/end
// time used for an ad-hoc, schedule-free session: a session still has
// to have *a* time (attendance/training_sessions' schema requires
// one), but staff marking attendance for a simple membership should
// never have to think about it.
const ADHOC_SESSION_START = '00:00:00'
const ADHOC_SESSION_END = '23:59:00'

interface RosterPlayer {
  playerId: string
  playerName: string
  attendanceStatus: string | null
}

async function fetchSessionsForDate(clubId: string, date: string) {
  const { data, error } = await supabase
    .from('training_sessions')
    .select('id, group_id, session_date, start_time, end_time, groups(name)')
    .eq('club_id', clubId)
    .eq('session_date', date)
    .order('start_time')
  if (error) throw error
  return (data ?? []).map<SessionRow>((s) => ({
    id: s.id,
    groupId: s.group_id,
    sessionDate: s.session_date,
    startTime: s.start_time,
    endTime: s.end_time,
    groupName: (s.groups as unknown as { name: string } | null)?.name,
  }))
}

async function fetchMemberships(clubId: string) {
  const { data, error } = await supabase
    .from('groups')
    .select('id, name')
    .eq('club_id', clubId)
    .eq('status', 'active')
    .order('name')
  if (error) throw error
  return data ?? []
}

async function fetchRoster(groupId: string, sessionId: string): Promise<RosterPlayer[]> {
  const { data: enrollments, error } = await supabase
    .from('enrollments')
    .select('player_id, players(full_name)')
    .eq('group_id', groupId)
    .eq('status', 'active')
  if (error) throw error

  const { data: attendance, error: attError } = await supabase
    .from('attendance')
    .select('player_id, status')
    .eq('session_id', sessionId)
  if (attError) throw attError

  const statusByPlayer = new Map((attendance ?? []).map((a) => [a.player_id, a.status]))

  return (enrollments ?? []).map((e) => ({
    playerId: e.player_id,
    playerName: (e.players as unknown as { full_name: string } | null)?.full_name ?? '—',
    attendanceStatus: statusByPlayer.get(e.player_id) ?? null,
  }))
}

export function AttendanceSection() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [selectedSession, setSelectedSession] = useState<SessionRow | null>(null)
  const [pickMembershipId, setPickMembershipId] = useState('')
  const [openError, setOpenError] = useState<string | null>(null)

  const ATTENDANCE_LABELS: Record<string, string> = {
    present: t('academy.coachToday.attendanceLabels.present'),
    absent: t('academy.coachToday.attendanceLabels.absent'),
    excused: t('academy.coachToday.attendanceLabels.excused'),
    late: t('academy.coachToday.attendanceLabels.late'),
  }

  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ['attendance-sessions', currentClubId, date],
    queryFn: () => fetchSessionsForDate(currentClubId!, date),
    enabled: !!currentClubId,
  })

  const { data: memberships = [] } = useQuery({
    queryKey: ['attendance-memberships', currentClubId],
    queryFn: () => fetchMemberships(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: roster = [] } = useQuery({
    queryKey: ['attendance-roster', selectedSession?.id],
    queryFn: () => fetchRoster(selectedSession!.groupId, selectedSession!.id),
    enabled: !!selectedSession,
  })

  // Find-or-create today's session for a membership that has no
  // group_schedule_slots (see ADHOC_SESSION_START/END comment above) --
  // the schedule-free path for the common case of a simple monthly
  // membership with no configured weekly schedule. Goes through the
  // ensure_adhoc_attendance_session RPC (not a direct insert):
  // training_sessions has no client-facing INSERT RLS policy at all --
  // writes only ever happened via the generate_training_sessions RPC
  // (confirmed via pg_policies during live QA) -- so this follows the
  // same RPC-first write pattern the rest of Academy already uses.
  const openSessionMutation = useMutation({
    mutationFn: async (groupId: string) => {
      const { data: sessionId, error } = await supabase.rpc('ensure_adhoc_attendance_session', {
        p_group_id: groupId,
        p_session_date: date,
      })
      if (error) throw error
      const membership = memberships.find((m) => m.id === groupId)
      return { id: sessionId as string, groupId, groupName: membership?.name }
    },
    onSuccess: (s) => {
      setOpenError(null)
      setSelectedSession({
        id: s.id,
        groupId: s.groupId,
        sessionDate: date,
        startTime: ADHOC_SESSION_START,
        endTime: ADHOC_SESSION_END,
        groupName: s.groupName,
      })
      void queryClient.invalidateQueries({ queryKey: ['attendance-sessions', currentClubId, date] })
    },
    onError: (error) => setOpenError(error instanceof Error ? error.message : (error as { message?: string })?.message ?? String(error)),
  })

  const [markError, setMarkError] = useState<string | null>(null)

  const markMutation = useMutation({
    mutationFn: async ({ playerId, status }: { playerId: string; status: string }) => {
      if (!selectedSession) throw new Error('no session selected')
      const { error } = await supabase.rpc('mark_attendance', {
        p_session_id: selectedSession.id,
        p_player_id: playerId,
        p_status: status,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setMarkError(null)
      void queryClient.invalidateQueries({ queryKey: ['attendance-roster', selectedSession?.id] })
    },
    // Real bug found in live QA (2026-08-20): this mutation previously
    // had no onError at all -- a real "not authorized for this
    // session" failure (managers lacked attendance.mark, since fixed)
    // was silently swallowed with no visible error, while the button's
    // own visual state made it look like the mark had succeeded.
    onError: (error) => setMarkError(error instanceof Error ? error.message : (error as { message?: string })?.message ?? String(error)),
  })

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setSelectedSession(null); setOpenError(null); setMarkError(null) }} className="w-48" />
      </div>

      {isLoading && <p className="text-sm text-text-secondary">{t('academy.loading')}</p>}

      <div className="flex flex-col gap-2">
        {sessions.map((s) => (
          <Card key={s.id} className="cursor-pointer" onClick={() => { setSelectedSession(s); setMarkError(null) }}>
            <CardContent className="flex items-center justify-between p-4">
              <p className="font-semibold">{s.groupName}</p>
              <p className="text-sm text-text-secondary tabular-nums"><bdi>{s.startTime.slice(0, 5)} - {s.endTime.slice(0, 5)}</bdi></p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Directive section 24: attendance must not depend on a
          pre-built weekly schedule. If a membership has no scheduled
          session for this date yet, staff can still pick it directly
          and record attendance -- openSessionMutation finds or creates
          today's session for that membership on the fly. */}
      {!isLoading && memberships.length > 0 && (
        <div className="flex items-end gap-2 rounded-lg border border-dashed border-border p-3">
          <div className="flex flex-1 flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('academy.attendance.recordForMembership')}</label>
            <Select value={pickMembershipId} onValueChange={(v) => { setPickMembershipId(v); setOpenError(null) }}>
              <SelectTrigger><SelectValue placeholder={t('academy.memberships.name')} /></SelectTrigger>
              <SelectContent>{memberships.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            disabled={!pickMembershipId || openSessionMutation.isPending}
            onClick={() => openSessionMutation.mutate(pickMembershipId)}
          >
            {openSessionMutation.isPending ? t('academy.loading') : t('academy.attendance.open')}
          </Button>
        </div>
      )}
      {openError && <p role="alert" className="text-sm text-status-danger">{openError}</p>}

      {selectedSession && (
        <div className="rounded-lg border border-border p-4">
          <p className="mb-3 font-medium">{t('academy.coachToday.attendanceDialogTitle', { group: selectedSession.groupName })}</p>
          {markError && <p role="alert" className="mb-3 text-sm text-status-danger">{markError}</p>}
          {roster.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('academy.coachToday.noRoster')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {roster.map((p) => (
                <li key={p.playerId} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                  <span className="flex items-center gap-2">
                    {p.attendanceStatus === 'present' || p.attendanceStatus === 'late' ? (
                      <CheckCircle2 className="size-4 text-status-success" />
                    ) : p.attendanceStatus === 'absent' ? (
                      <XCircle className="size-4 text-status-danger" />
                    ) : (
                      <Circle className="size-4 text-text-secondary" />
                    )}
                    {p.playerName}
                  </span>
                  <div className="flex gap-1">
                    {(['present', 'absent', 'excused', 'late'] as const).map((status) => (
                      <Button
                        key={status}
                        size="sm"
                        variant={p.attendanceStatus === status ? 'default' : 'outline'}
                        onClick={() => markMutation.mutate({ playerId: p.playerId, status })}
                      >
                        {ATTENDANCE_LABELS[status]}
                      </Button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
