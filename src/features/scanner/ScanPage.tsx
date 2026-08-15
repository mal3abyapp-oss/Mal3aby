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
}

const OUTCOME_LABELS: Record<string, { label: string; tone: 'success' | 'danger' | 'warning' }> = {
  success: { label: 'صالح', tone: 'success' },
  already_used: { label: 'تم استخدامه بالفعل', tone: 'warning' },
  expired: { label: 'منتهي الصلاحية', tone: 'danger' },
  invalid: { label: 'غير صالح', tone: 'danger' },
  wrong_club: { label: 'لا ينتمي لهذا النادي', tone: 'danger' },
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
      setValidated({ result: 'invalid', credential_id: null, reference_type: null, reference_id: null, club_id: null })
      return
    }
    setValidated(data[0] as ValidateResult)
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

  function resetToScan() {
    setValidated(null)
    setConfirmResult(null)
    setLastToken(null)
    setScanning(true)
  }

  const outcome = confirmResult ? OUTCOME_LABELS[confirmResult] : validated ? OUTCOME_LABELS[validated.result] : null

  return (
    <div className="flex min-h-screen flex-col bg-dark-base text-white">
      <header className="flex items-center gap-3 p-4">
        <button onClick={() => navigate(-1)} aria-label="رجوع">
          <ArrowRight className="size-5" />
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

          <div className="mt-4 flex w-full max-w-xs flex-col gap-2">
            {validated.result === 'success' && validated.reference_type === 'booking' && (
              <Button size="lg" disabled={busy} onClick={() => void handleConfirm()}>
                {busy ? 'جارٍ التأكيد...' : 'تأكيد تسجيل الحضور'}
              </Button>
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
