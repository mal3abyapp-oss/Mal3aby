import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { formatInstant } from '@/lib/domain/time'
import { CheckCircle2, XCircle, Clock, Ban } from 'lucide-react'

// WhatsApp secure links directive: public booking-QR verification
// page a customer lands on from their WhatsApp check-in link. Same
// standalone-route pattern as VerifyInvoicePage.tsx (no PublicLayout
// marketing chrome, no app shell, no login) -- reachable with NO auth
// via verify_booking_qr_public() (anon-granted). Deliberately shows
// ONLY what that RPC returns: booking_ref, field_name, sport,
// start/end time, booking_status -- never customer name/phone/
// internal IDs, matching VerifyInvoicePage's exact security posture.
//
// Distinct from /verify/:token (invoice) and from the staff-only
// scanner at /scan (which requires login, consumes the credential,
// and confirms attendance via qr_confirm_checkin). This page never
// mutates anything -- it's a read-only "is my check-in code still
// valid" answer for the customer themselves.

type VerifyResult = 'valid' | 'expired' | 'cancelled' | 'already_used' | 'invalid'

interface BookingQrVerification {
  result: VerifyResult
  bookingRef: string | null
  fieldName: string | null
  sport: string | null
  startAt: string | null
  endAt: string | null
  timezone: string | null
  bookingStatus: string | null
}

async function verifyBookingQr(token: string): Promise<BookingQrVerification> {
  const { data, error } = await supabase.rpc('verify_booking_qr_public', { p_token: token })
  if (error) throw error
  const row = data?.[0]
  return {
    result: (row?.result as VerifyResult) ?? 'invalid',
    bookingRef: row?.booking_ref ?? null,
    fieldName: row?.field_name ?? null,
    sport: row?.sport ?? null,
    startAt: row?.start_at ?? null,
    endAt: row?.end_at ?? null,
    timezone: row?.timezone ?? null,
    bookingStatus: row?.booking_status ?? null,
  }
}

// Directive rule 3/4: every lifecycle state gets its own honest
// message -- never a bare "invalid" that hides whether the real
// reason is cancellation, expiry, prior use, or a genuinely bad token.
const STATE_CONTENT: Record<VerifyResult, { icon: typeof CheckCircle2; tone: string; title: string; message: string }> = {
  valid: { icon: CheckCircle2, tone: 'text-status-success', title: 'رمز صالح', message: '' },
  expired: {
    icon: Clock,
    tone: 'text-status-warning',
    title: 'انتهت صلاحية الرمز',
    message: 'انتهت صلاحية رمز الحضور الخاص بهذا الحجز. تواصل مع النادي إذا كنت بحاجة إلى رمز جديد.',
  },
  cancelled: {
    icon: Ban,
    tone: 'text-status-danger',
    title: 'الحجز ملغي',
    message: 'هذا الحجز ملغي ولم يعد رمز الحضور صالحًا.',
  },
  already_used: {
    icon: CheckCircle2,
    tone: 'text-text-secondary',
    title: 'تم استخدام الرمز بالفعل',
    message: 'تم تسجيل الحضور بهذا الرمز مسبقًا.',
  },
  invalid: {
    icon: XCircle,
    tone: 'text-status-danger',
    title: 'رمز غير صالح',
    message: 'لم يتم العثور على حجز مطابق لهذا الرمز. تأكد من فتح الرابط الصحيح، أو تواصل مع النادي مباشرة.',
  },
}

export function BookingQrVerifyPage() {
  const { token } = useParams<{ token: string }>()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['verify-booking-qr', token],
    queryFn: () => verifyBookingQr(token!),
    enabled: !!token,
    retry: false,
  })

  const result: VerifyResult = isError || !data ? 'invalid' : data.result
  const content = STATE_CONTENT[result]
  const Icon = content.icon
  const tz = data?.timezone ?? 'UTC'

  return (
    <div className="flex min-h-screen items-center justify-center bg-page-bg p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 text-center shadow">
        <p className="mb-4 text-sm font-medium text-text-secondary">رمز الحضور للحجز</p>

        {isLoading && <p className="text-sm text-text-secondary">جارٍ التحقق...</p>}

        {!isLoading && result !== 'valid' && (
          <div className="flex flex-col items-center gap-3">
            <Icon className={`size-12 ${content.tone}`} />
            <p className={`font-medium ${content.tone}`}>{content.title}</p>
            <p className="text-sm text-text-secondary">{content.message}</p>
            {data?.bookingRef && (
              <p className="text-xs text-text-secondary">
                رقم الحجز: <bdi>{data.bookingRef}</bdi>
              </p>
            )}
          </div>
        )}

        {!isLoading && result === 'valid' && data && (
          <div className="flex flex-col items-center gap-3">
            <CheckCircle2 className="size-12 text-status-success" />
            <p className="font-medium text-status-success">رمز صالح للحضور</p>
            <div className="w-full rounded-md border border-border p-4 text-start text-sm">
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">رقم الحجز</span>
                <span className="font-medium"><bdi>{data.bookingRef}</bdi></span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">الملعب</span>
                <span className="font-medium">{data.fieldName ?? '—'}</span>
              </div>
              {data.sport && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">النشاط</span>
                  <span className="font-medium">{data.sport}</span>
                </div>
              )}
              {data.startAt && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">الموعد</span>
                  <span className="font-medium tabular-nums">
                    <bdi>
                      {formatInstant(data.startAt, tz, { day: 'numeric', month: 'long' })}
                      {' — '}
                      {formatInstant(data.startAt, tz, { hour: '2-digit', minute: '2-digit' })}
                    </bdi>
                  </span>
                </div>
              )}
            </div>
            <p className="text-xs text-text-secondary">اعرض هذا الرمز لموظفي الاستقبال عند الوصول.</p>
          </div>
        )}
      </div>
    </div>
  )
}
