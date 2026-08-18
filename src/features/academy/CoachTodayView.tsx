import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BrowserQRCodeReader } from '@zxing/browser'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CheckCircle2, Circle, ScanLine, XCircle } from 'lucide-react'

// Coach Today (sessions list) + session detail + manual/QR attendance
// marking, per SCREEN_MAP.md ("academy" route group, Mobile/Tablet,
// Coach). Rendered in place of the staff Academy tabs when the current
// role is Coach.
interface SessionRow {
  id: string
  groupId: string
  sessionDate: string
  startTime: string
  endTime: string
  groupName?: string
}

interface RosterPlayer {
  playerId: string
  playerName: string
  attendanceStatus: string | null
}

async function fetchTodaySessions(clubId: string) {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('training_sessions')
    .select('id, group_id, session_date, start_time, end_time, groups(name)')
    .eq('club_id', clubId)
    .eq('session_date', today)
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

export function CoachTodayView() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [selectedSession, setSelectedSession] = useState<SessionRow | null>(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [scanResult, setScanResult] = useState<{ result: string } | null>(null)

  const ATTENDANCE_LABELS: Record<string, string> = {
    present: t('academy.coachToday.attendanceLabels.present'),
    absent: t('academy.coachToday.attendanceLabels.absent'),
    excused: t('academy.coachToday.attendanceLabels.excused'),
    late: t('academy.coachToday.attendanceLabels.late'),
  }

  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ['coach-today-sessions', currentClubId],
    queryFn: () => fetchTodaySessions(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: roster = [] } = useQuery({
    queryKey: ['session-roster', selectedSession?.id],
    queryFn: () => fetchRoster(selectedSession!.groupId, selectedSession!.id),
    enabled: !!selectedSession,
  })

  function invalidateRoster() {
    void queryClient.invalidateQueries({ queryKey: ['session-roster', selectedSession?.id] })
  }

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
    onSuccess: invalidateRoster,
  })

  async function handleScan() {
    setScanOpen(true)
    setScanResult(null)
    const reader = new BrowserQRCodeReader()
    try {
      const result = await reader.decodeOnceFromVideoDevice(undefined, 'coach-qr-video')
      const token = result.getText()
      if (!token || !selectedSession) return
      const { data, error } = await supabase.rpc('qr_mark_attendance', { p_token: token, p_session_id: selectedSession.id })
      if (error || !data?.[0]) {
        setScanResult({ result: 'invalid' })
        return
      }
      setScanResult({ result: data[0].result })
      invalidateRoster()
    } catch {
      setScanResult({ result: 'invalid' })
    }
  }

  return (
    <div>
      <PageHeader title={t('academy.coachToday.title')} description={t('academy.coachToday.description')} />

      {isLoading && <p className="text-sm text-text-secondary">{t('academy.coachToday.loading')}</p>}

      <div className="flex flex-col gap-3">
        {sessions.length === 0 && !isLoading && (
          <p className="text-sm text-text-secondary">{t('academy.coachToday.noSessions')}</p>
        )}
        {sessions.map((s) => (
          <Card key={s.id} className="cursor-pointer" onClick={() => setSelectedSession(s)}>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="font-semibold">{s.groupName}</p>
                {/* Same RTL bidi-swap risk as StatCard's composite values
                    (owner-level review finding). */}
                <p className="text-sm text-text-secondary tabular-nums"><bdi>{s.startTime} - {s.endTime}</bdi></p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!selectedSession} onOpenChange={(open) => !open && setSelectedSession(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('academy.coachToday.attendanceDialogTitle', { group: selectedSession?.groupName })}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Button variant="outline" size="sm" className="w-fit" onClick={() => void handleScan()}>
              <ScanLine className="me-2 size-4" />
              {t('academy.coachToday.scanQr')}
            </Button>

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
        </DialogContent>
      </Dialog>

      <Dialog open={scanOpen} onOpenChange={setScanOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('academy.coachToday.scanPlayerCard')}</DialogTitle></DialogHeader>
          <div className="flex flex-col items-center gap-3">
            <video id="coach-qr-video" className="w-full rounded-md" muted playsInline />
            {scanResult && (
              <StatusBadge
                tone={scanResult.result === 'success' ? 'success' : 'danger'}
                label={scanResult.result === 'success' ? t('academy.coachToday.checkedIn') : t('academy.coachToday.scanFailed')}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
