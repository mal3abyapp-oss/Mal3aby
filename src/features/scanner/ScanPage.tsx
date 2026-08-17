import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { ArrowRight, CheckCircle2, XCircle, Clock, ShieldAlert } from 'lucide-react'

// /scan -- camera-based QR scanner. Two explicit steps, never one (ADR-011e):
// scanning only validates + displays; a separate "Confirm Check-in" tap
// performs the atomic consume + bookings.status mutation. Four unambiguous
// outcomes (VALID / ALREADY USED / EXPIRED / INVALID) plus WRONG CLUB.

type ValidateResult = {
  result: string
  credential_id: string | null
  reference_type: string | null
  reference_id: string | null
  club_id: string | null
  display_name: string | null
  display_photo_url: string | null
  display_subtitle: string | null
  subscription_status: string | null
}

// Gate 6: added subscription_inactive (a real gap found in this pass --
// qr_mark_attendance previously checked enrollment status but never the
// player's actual paid subscription status, so a frozen/expired/
// cancelled member could still check in).
const OUTCOME_LABELS: Record<string, { label: string; tone: 'success' | 'danger' | 'warning' }> = {
  success: { label: 'صالح', tone: 'success' },
  already_used: { label: 'تم استخدامه بالفعل', tone: 'warning' },
  expired: { label: 'منتهي الصلاحية', tone: 'danger' },
  invalid: { label: 'غير صالح', tone: 'danger' },
  wrong_club: { label: 'لا ينتمي لهذا النادي', tone: 'danger' },
  permission_denied: { label: 'لا تملك صلاحية هذا الإجراء', tone: 'danger' },
  subscription_inactive: { label: 'الاشتراك غير نشط', tone: 'danger' },
}

const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  pending: 'بانتظار التفعيل',
  active: 'نشط',
  frozen: 'مجمّد',
  expired: 'منتهي',
  cancelled: 'ملغي',
}

interface OpenSession {
  id: string
  group_name: string
}

async function fetchOpenSessionsForCoach(): Promise<OpenSession[]> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('training_sessions')
    .select('id, session_date, groups(name)')
    .eq('session_date', today)
  if (error) throw error
  return (data ?? []).map((s) => ({
    id: s.id,
    group_name: (s.groups as unknown as { name: string } | null)?.name ?? '—',
  }))
}

export function ScanPage() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const [scanning, setScanning] = useState(true)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [validated, setValidated] = useState<ValidateResult | null>(null)
  const [confirmResult, setConfirmResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastToken, setLastToken] = useState<string | null>(null)
  // Gate 6: qr_mark_attendance() (the academy membership check-in RPC)
  // already existed server-side but this scanner never called it at
  // all -- only the booking check-in path (qr_confirm_checkin) was
  // wired. A player_membership QR needs the coach to pick which
  // today's session they're checking the player into.
  const [openSessions, setOpenSessions] = useState<OpenSession[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState('')

  useEffect(() => {
    if (!scanning) return
    const reader = new BrowserQRCodeReader()
    let cancelled = false

    reader
      .decodeFromVideoDevice(undefined, videoRef.current ?? undefined, (result, _err, controls) => {
        controlsRef.current = controls
        if (cancelled || !result) return
        const token = result.getText()
        if (!token) return
        controls.stop()
        setScanning(false)
        void handleValidate(token)
      })
      .catch(() => setCameraError('تعذّر الوصول إلى الكاميرا. تأكد من منح الإذن.'))

    return () => {
      cancelled = true
      controlsRef.current?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning])

  async function handleValidate(token: string) {
    setLastToken(token)
    setBusy(true)
    const { data, error } = await supabase.rpc('qr_validate', { p_token: token })
    setBusy(false)
    if (error || !data?.[0]) {
      setValidated({
        result: 'invalid', credential_id: null, reference_type: null, reference_id: null, club_id: null,
        display_name: null, display_photo_url: null, display_subtitle: null, subscription_status: null,
      })
      return
    }
    const row = data[0] as ValidateResult
    setValidated(row)
    if (row.reference_type === 'player_membership') {
      fetchOpenSessionsForCoach().then(setOpenSessions).catch(() => setOpenSessions([]))
    }
  }

  async function handleConfirm() {
    if (!lastToken) return
    setBusy(true)
    const { data, error } = await supabase.rpc('qr_confirm_checkin', { p_token: lastToken })
    setBusy(false)
    if (error || !data?.[0]) {
      setConfirmResult('invalid')
      return
    }
    setConfirmResult(data[0].result as string)
  }

  async function handleAttendanceMark() {
    if (!lastToken || !selectedSessionId) return
    setBusy(true)
    const { data, error } = await supabase.rpc('qr_mark_attendance', { p_token: lastToken, p_session_id: selectedSessionId })
    setBusy(false)
    if (error || !data?.[0]) {
      setConfirmResult('invalid')
      return
    }
    setConfirmResult(data[0].result as string)
  }

  function resetToScan() {
    setValidated(null)
    setConfirmResult(null)
    setLastToken(null)
    setSelectedSessionId('')
    setOpenSessions([])
    setScanning(true)
  }

  const outcome = confirmResult ? OUTCOME_LABELS[confirmResult] : validated ? OUTCOME_LABELS[validated.result] : null

  return (
    <div className="flex min-h-screen flex-col bg-dark-base text-white">
      <header className="flex items-center gap-3 p-4">
        {/* Master IA/UX audit (RTL phase): back arrow now flips with
            direction instead of assuming RTL (right = back). */}
        <button onClick={() => navigate(-1)} aria-label="رجوع">
          <ArrowRight className="size-5 rtl:rotate-180" />
        </button>
        <h1 className="text-lg font-bold">مسح QR</h1>
      </header>

      {scanning && !cameraError && (
        <div className="relative flex-1 overflow-hidden">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="size-64 rounded-2xl border-4 border-accent/80" />
          </div>
        </div>
      )}

      {cameraError && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <ShieldAlert className="size-10 text-status-danger" />
          <p>{cameraError}</p>
          <Button onClick={() => { setCameraError(null); setScanning(true) }}>إعادة المحاولة</Button>
        </div>
      )}

      {!scanning && validated && !confirmResult && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          {/* Gate 6: identity-verification card -- staff must be able to
              visually compare the person presenting the QR to a
              verified photo, and see current membership/subscription
              standing, before approving entry. Previously this screen
              showed only a bare valid/invalid state with zero identity
              context. */}
          {validated.display_name && (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-white/15 bg-white/5 p-4">
              {validated.display_photo_url ? (
                <img src={validated.display_photo_url} alt={validated.display_name} className="size-24 rounded-full object-cover" />
              ) : (
                <div className="flex size-24 items-center justify-center rounded-full bg-white/10 text-2xl font-semibold">
                  {validated.display_name.charAt(0)}
                </div>
              )}
              <p className="text-lg font-bold">{validated.display_name}</p>
              {validated.display_subtitle && <p className="text-sm text-white/60">{validated.display_subtitle}</p>}
              {validated.subscription_status && (
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${validated.subscription_status === 'active' ? 'bg-status-success/20 text-status-success' : 'bg-status-danger/20 text-status-danger'}`}>
                  الاشتراك: {SUBSCRIPTION_STATUS_LABELS[validated.subscription_status] ?? validated.subscription_status}
                </span>
              )}
            </div>
          )}

          {outcome?.tone === 'success' ? (
            <CheckCircle2 className="size-16 text-status-success" />
          ) : outcome?.tone === 'warning' ? (
            <Clock className="size-16 text-status-warning" />
          ) : (
            <XCircle className="size-16 text-status-danger" />
          )}
          <p className="text-xl font-bold">{outcome?.label}</p>
          {validated.result === 'success' && validated.reference_type === 'booking' && (
            <p className="text-white/60">حجز — بانتظار تأكيد تسجيل الحضور</p>
          )}
          {validated.result === 'success' && validated.reference_type === 'player_membership' && (
            <p className="text-white/60">عضوية أكاديمية — اختر الجلسة لتسجيل الحضور</p>
          )}

          <div className="mt-4 flex w-full max-w-xs flex-col gap-2">
            {validated.result === 'success' && validated.reference_type === 'booking' && (
              <Button size="lg" disabled={busy} onClick={() => void handleConfirm()}>
                {busy ? 'جارٍ التأكيد...' : 'تأكيد تسجيل الحضور'}
              </Button>
            )}
            {validated.result === 'success' && validated.reference_type === 'player_membership' && (
              <>
                {openSessions.length === 0 ? (
                  <p className="text-sm text-white/60">لا توجد جلسات اليوم لمجموعاتك.</p>
                ) : (
                  <select
                    className="h-10 rounded-md border border-white/20 bg-white/10 px-2 text-sm text-white"
                    value={selectedSessionId}
                    onChange={(e) => setSelectedSessionId(e.target.value)}
                  >
                    <option value="">اختر الجلسة...</option>
                    {openSessions.map((s) => (
                      <option key={s.id} value={s.id} className="text-black">{s.group_name}</option>
                    ))}
                  </select>
                )}
                <Button size="lg" disabled={busy || !selectedSessionId} onClick={() => void handleAttendanceMark()}>
                  {busy ? 'جارٍ التسجيل...' : 'تسجيل الحضور'}
                </Button>
              </>
            )}
            <Button variant="outline" size="lg" className="border-white/20 bg-transparent text-white hover:bg-white/10" onClick={resetToScan}>
              مسح رمز آخر
            </Button>
          </div>
        </div>
      )}

      {confirmResult && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          {outcome?.tone === 'success' ? (
            <CheckCircle2 className="size-16 text-status-success" />
          ) : outcome?.tone === 'warning' ? (
            <Clock className="size-16 text-status-warning" />
          ) : (
            <XCircle className="size-16 text-status-danger" />
          )}
          <p className="text-xl font-bold">{outcome?.label}</p>
          <Button size="lg" className="mt-4 w-full max-w-xs" onClick={resetToScan}>
            مسح رمز آخر
          </Button>
        </div>
      )}
    </div>
  )
}
