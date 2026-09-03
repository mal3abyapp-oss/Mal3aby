import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/domain/billing'
import { ArrowLeft, CheckCircle2, XCircle, Clock, ShieldAlert } from 'lucide-react'

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
  // Club Memberships QR integration: the machine-readable code behind
  // `result`, needed to distinguish MEMBERSHIP_EXPIRED from
  // MEMBERSHIP_FROZEN from MEMBERSHIP_CANCELLED etc. (all collapse to
  // result='invalid' otherwise). Present on every qr_validate response,
  // only actually branched on for reference_type === 'club_membership'.
  diagnostic_code: string | null
  // P0 CHECK-IN FINANCIAL ELIGIBILITY HOTFIX (2026-08-23): qr_validate
  // now returns the real outstanding amount whenever result is
  // 'payment_required' (0 otherwise) -- QR CREDENTIAL VALIDITY and
  // CHECK-IN ELIGIBILITY are two separate questions; a cryptographically
  // valid, non-expired, non-consumed QR for a booking that still has an
  // outstanding balance must never be presented to staff as "صالح" --
  // see qr_confirm_checkin/qr_validate's own migration doc comment
  // (20260823170000_checkin_financial_eligibility_hotfix.sql) for the
  // full incident/root-cause writeup.
  amount_due: number | null
}

// Gate 6: added subscription_inactive (a real gap found in this pass --
// qr_mark_attendance previously checked enrollment status but never the
// player's actual paid subscription status, so a frozen/expired/
// cancelled member could still check in).
//
// P0 hotfix: added payment_required (booking QR valid, but the booking
// still has an outstanding balance -- must never be collapsed into the
// generic 'invalid' outcome, since staff need to see this is a distinct,
// actionable "collect payment first" state, not a broken/fake QR).
const OUTCOME_TONES: Record<string, 'success' | 'danger' | 'warning'> = {
  success: 'success',
  already_used: 'warning',
  expired: 'danger',
  invalid: 'danger',
  wrong_club: 'danger',
  permission_denied: 'danger',
  subscription_inactive: 'danger',
  payment_required: 'danger',
}

const OUTCOME_LABEL_KEYS: Record<string, string> = {
  success: 'scanner.outcomes.success',
  already_used: 'scanner.outcomes.already_used',
  expired: 'scanner.outcomes.expired',
  invalid: 'scanner.outcomes.invalid',
  wrong_club: 'scanner.outcomes.wrong_club',
  permission_denied: 'scanner.outcomes.permission_denied',
  subscription_inactive: 'scanner.outcomes.subscription_inactive',
  payment_required: 'scanner.outcomes.payment_required',
}

// Club Memberships QR integration: qr_validate's `result` field alone
// ('success'/'invalid'/'permission_denied'/...) is not granular enough
// for a club_membership scan -- an EXPIRED, FROZEN, CANCELLED, and
// NOT_STARTED membership all come back as the generic result='invalid'.
// The real distinction lives in `diagnostic_code`
// ('MEMBERSHIP_EXPIRED'/'MEMBERSHIP_FROZEN'/'MEMBERSHIP_CANCELLED'/
// 'MEMBERSHIP_NOT_STARTED'/'MEMBERSHIP_NO_MEMBERSHIP'/
// 'MEMBERSHIP_VERIFY_NOT_GRANTED'/'SUCCESS'), so this scanner branches on
// diagnostic_code specifically when reference_type === 'club_membership'
// (see outcomeKey below) rather than reusing the generic result-keyed
// maps above for this reference type.
const MEMBERSHIP_DIAGNOSTIC_TONES: Record<string, 'success' | 'danger' | 'warning'> = {
  SUCCESS: 'success',
  MEMBERSHIP_EXPIRED: 'danger',
  MEMBERSHIP_FROZEN: 'warning',
  MEMBERSHIP_CANCELLED: 'danger',
  MEMBERSHIP_NOT_STARTED: 'warning',
  MEMBERSHIP_NO_MEMBERSHIP: 'danger',
  MEMBERSHIP_VERIFY_NOT_GRANTED: 'danger',
}

const MEMBERSHIP_DIAGNOSTIC_LABEL_KEYS: Record<string, string> = {
  SUCCESS: 'scanner.outcomes.success',
  MEMBERSHIP_EXPIRED: 'scanner.membershipOutcomes.expired',
  MEMBERSHIP_FROZEN: 'scanner.membershipOutcomes.frozen',
  MEMBERSHIP_CANCELLED: 'scanner.membershipOutcomes.cancelled',
  MEMBERSHIP_NOT_STARTED: 'scanner.membershipOutcomes.notStarted',
  MEMBERSHIP_NO_MEMBERSHIP: 'scanner.membershipOutcomes.noMembership',
  MEMBERSHIP_VERIFY_NOT_GRANTED: 'scanner.outcomes.permission_denied',
}

const SUBSCRIPTION_STATUS_LABEL_KEYS: Record<string, string> = {
  pending: 'scanner.subscriptionStatus.pending',
  active: 'scanner.subscriptionStatus.active',
  frozen: 'scanner.subscriptionStatus.frozen',
  expired: 'scanner.subscriptionStatus.expired',
  cancelled: 'scanner.subscriptionStatus.cancelled',
  // Club Memberships domain -- UPPERCASE, distinct from academy's
  // lowercase convention above (qr_validate's own club_membership
  // branch returns subscription_status in uppercase). Kept alongside the
  // lowercase academy keys rather than merged, since both are read from
  // the same `subscription_status` field keyed only by reference_type.
  ACTIVE: 'scanner.subscriptionStatus.active',
  FROZEN: 'scanner.subscriptionStatus.frozen',
  EXPIRED: 'scanner.subscriptionStatus.expired',
  CANCELLED: 'scanner.subscriptionStatus.cancelled',
  NOT_STARTED: 'scanner.subscriptionStatus.notStarted',
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
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const [scanning, setScanning] = useState(true)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [validated, setValidated] = useState<ValidateResult | null>(null)
  const [confirmResult, setConfirmResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastToken, setLastToken] = useState<string | null>(null)
  // M-9 fix: "Identity Match" (per Doc 3's stated check-in rule -- "Valid
  // QR + Correct Account + Verified Membership + Active Entitlement +
  // Identity Match = Approved Check-in") must be an explicit staff
  // action with a persisted system record (qr_scan_events.
  // identity_confirmed), not merely a photo that happens to render on
  // screen. Staff must tap the identity card to attest they visually
  // compared the presenting person to the photo before Confirm Check-in
  // becomes available; resets on every new scan/result.
  const [identityConfirmed, setIdentityConfirmed] = useState(false)
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
      .catch(() => setCameraError(t('scanner.cameraError')))

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
        diagnostic_code: null, amount_due: null,
      })
      return
    }
    const row = data[0] as ValidateResult
    setValidated(row)
    setIdentityConfirmed(false)
    if (row.reference_type === 'player_membership') {
      fetchOpenSessionsForCoach().then(setOpenSessions).catch(() => setOpenSessions([]))
    }
  }

  async function handleConfirm() {
    if (!lastToken) return
    setBusy(true)
    const { data, error } = await supabase.rpc('qr_confirm_checkin', {
      p_token: lastToken,
      p_identity_confirmed: identityConfirmed,
    })
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
    setIdentityConfirmed(false)
    setScanning(true)
  }

  // Club Memberships: qr_validate scanning IS the terminal verify action
  // for this reference_type -- there is no separate "confirm" RPC, so
  // confirmResult never applies here, and the generic result-keyed maps
  // are not granular enough (EXPIRED/FROZEN/CANCELLED/NOT_STARTED all
  // collapse to result='invalid'). Branch on diagnostic_code instead,
  // only for this one reference_type.
  const isClubMembershipScan = !confirmResult && validated?.reference_type === 'club_membership'
  const outcomeKey = confirmResult ?? validated?.result ?? null
  const outcome = isClubMembershipScan && validated?.diagnostic_code
    ? {
        label: t(MEMBERSHIP_DIAGNOSTIC_LABEL_KEYS[validated.diagnostic_code] ?? validated.diagnostic_code),
        tone: MEMBERSHIP_DIAGNOSTIC_TONES[validated.diagnostic_code] ?? 'danger',
      }
    : outcomeKey
      ? { label: t(OUTCOME_LABEL_KEYS[outcomeKey] ?? outcomeKey), tone: OUTCOME_TONES[outcomeKey] ?? 'danger' }
      : null

  // M-9 fix: only the booking success path is gated on the identity-
  // confirmation tap -- that is the only case where a further mutating
  // "confirm" RPC (qr_confirm_checkin) follows this screen and where the
  // identity card's photo is meaningful (a booking QR presents exactly
  // one person to compare against).
  const requiresIdentityConfirmation = validated?.result === 'success' && validated?.reference_type === 'booking'

  return (
    <div className="flex min-h-screen flex-col bg-dark-base text-white">
      <header className="flex items-center gap-3 p-4">
        {/* Master IA/UX audit (RTL phase): base icon is the LTR-correct
            "back" direction (left), rtl:rotate-180 flips it for RTL.
            Verified live in both directions after an earlier version
            had this backwards. */}
        <button onClick={() => navigate(-1)} aria-label={t('scanner.back')}>
          <ArrowLeft className="size-5 rtl:rotate-180" />
        </button>
        <h1 className="text-lg font-bold">{t('scanner.title')}</h1>
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
          <Button onClick={() => { setCameraError(null); setScanning(true) }}>{t('scanner.retry')}</Button>
        </div>
      )}

      {!scanning && validated && !confirmResult && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          {/* Gate 6: identity-verification card -- staff must be able to
              visually compare the person presenting the QR to a
              verified photo, and see current membership/subscription
              standing, before approving entry. Previously this screen
              showed only a bare valid/invalid state with zero identity
              context.

              M-9 fix: for a booking check-in specifically, Identity
              Match is now a required, explicit staff action with a
              persisted system record (qr_scan_events.identity_confirmed)
              -- not just a photo rendering on screen. Tapping the photo
              toggles identityConfirmed, which gates the Confirm
              Check-in button below and is passed through to
              qr_confirm_checkin as p_identity_confirmed. */}
          {validated.display_name && (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-white/15 bg-white/5 p-4">
              {requiresIdentityConfirmation ? (
                <button
                  type="button"
                  aria-label={identityConfirmed ? t('scanner.identityConfirmed') : t('scanner.identityConfirmPrompt')}
                  aria-pressed={identityConfirmed}
                  onClick={() => setIdentityConfirmed((prev) => !prev)}
                  className={`flex flex-col items-center gap-2 rounded-lg p-1 outline-none ${identityConfirmed ? 'ring-2 ring-status-success' : 'ring-2 ring-transparent'}`}
                >
                  {validated.display_photo_url ? (
                    <img src={validated.display_photo_url} alt={validated.display_name} className="size-24 rounded-full object-cover" />
                  ) : (
                    <div className="flex size-24 items-center justify-center rounded-full bg-white/10 text-2xl font-semibold">
                      {validated.display_name.charAt(0)}
                    </div>
                  )}
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${identityConfirmed ? 'bg-status-success/20 text-status-success' : 'bg-white/10 text-white/70'}`}>
                    {identityConfirmed ? t('scanner.identityConfirmed') : t('scanner.identityConfirmPrompt')}
                  </span>
                </button>
              ) : validated.display_photo_url ? (
                <img src={validated.display_photo_url} alt={validated.display_name} className="size-24 rounded-full object-cover" />
              ) : (
                <div className="flex size-24 items-center justify-center rounded-full bg-white/10 text-2xl font-semibold">
                  {validated.display_name.charAt(0)}
                </div>
              )}
              <p className="text-lg font-bold">{validated.display_name}</p>
              {validated.display_subtitle && <p className="text-sm text-white/60">{validated.display_subtitle}</p>}
              {validated.subscription_status && (
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${validated.subscription_status === 'active' || validated.subscription_status === 'ACTIVE' ? 'bg-status-success/20 text-status-success' : 'bg-status-danger/20 text-status-danger'}`}>
                  {t('scanner.subscriptionPrefix')} {t(SUBSCRIPTION_STATUS_LABEL_KEYS[validated.subscription_status] ?? validated.subscription_status)}
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
            <p className="text-white/60">{t('scanner.bookingAwaitingCheckin')}</p>
          )}
          {validated.result === 'success' && validated.reference_type === 'player_membership' && (
            <p className="text-white/60">{t('scanner.membershipChooseSession')}</p>
          )}
          {/* P0 CHECK-IN FINANCIAL ELIGIBILITY HOTFIX: QR credential
              validity and check-in eligibility are two separate
              questions -- this booking's QR is real, non-expired, and
              non-consumed, but the booking still carries an outstanding
              balance, so entry is denied until it is settled. Staff see
              the exact amount owed (never customer-facing/public
              scanner surfaces); the actual enforcement lives server-side
              in qr_confirm_checkin, this is purely informative. */}
          {validated.result === 'payment_required' && (
            <p className="text-white/60">
              {t('scanner.paymentRequiredAmount', { amount: formatMoney(validated.amount_due ?? 0, 'EGP', i18n.language === 'en' ? 'en' : 'ar') })}
            </p>
          )}

          <div className="mt-4 flex w-full max-w-xs flex-col gap-2">
            {validated.result === 'success' && validated.reference_type === 'booking' && (
              <>
                {!identityConfirmed && (
                  <p className="text-sm text-white/60">{t('scanner.identityConfirmRequiredHint')}</p>
                )}
                <Button size="lg" disabled={busy || !identityConfirmed} onClick={() => void handleConfirm()}>
                  {busy ? t('scanner.confirming') : t('scanner.confirmCheckin')}
                </Button>
              </>
            )}
            {validated.result === 'payment_required' && (
              <Button size="lg" onClick={() => navigate('/app/bookings')}>
                {t('scanner.collectPayment')}
              </Button>
            )}
            {validated.result === 'success' && validated.reference_type === 'player_membership' && (
              <>
                {openSessions.length === 0 ? (
                  <p className="text-sm text-white/60">{t('scanner.noSessionsToday')}</p>
                ) : (
                  <select
                    className="h-10 rounded-md border border-white/20 bg-white/10 px-2 text-sm text-white"
                    value={selectedSessionId}
                    onChange={(e) => setSelectedSessionId(e.target.value)}
                  >
                    <option value="">{t('scanner.chooseSessionPlaceholder')}</option>
                    {openSessions.map((s) => (
                      <option key={s.id} value={s.id} className="text-black">{s.group_name}</option>
                    ))}
                  </select>
                )}
                <Button size="lg" disabled={busy || !selectedSessionId} onClick={() => void handleAttendanceMark()}>
                  {busy ? t('scanner.recordingAttendance') : t('scanner.markAttendance')}
                </Button>
              </>
            )}
            <Button variant="outline" size="lg" className="border-white/20 bg-transparent text-white hover:bg-white/10" onClick={resetToScan}>
              {t('scanner.scanAnother')}
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
            {t('scanner.scanAnother')}
          </Button>
        </div>
      )}
    </div>
  )
}
