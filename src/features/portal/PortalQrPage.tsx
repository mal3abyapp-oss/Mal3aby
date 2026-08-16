import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// Gate 3 — "My QR": shows a scannable QR for a selected upcoming
// booking. Reuses the same ensure_booking_qr() RPC the staff-side
// BookingDetailSheet already calls -- the QR content/security model is
// unchanged, this only exposes the existing secure QR to the booking's
// own customer directly instead of requiring them to ask staff to show it.
interface UpcomingBooking {
  id: string
  start_at: string
  fields: { name: string } | null
}

async function fetchUpcomingBookings(): Promise<UpcomingBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, start_at, fields(name)')
    .in('status', ['confirmed', 'pending_payment'])
    .gte('start_at', new Date().toISOString())
    .order('start_at')
    .limit(20)
  if (error) throw error
  return (data ?? []) as unknown as UpcomingBooking[]
}

export function PortalQrPage() {
  const { data: bookings = [], isLoading } = useQuery({ queryKey: ['portal', 'qr-bookings'], queryFn: fetchUpcomingBookings })
  const [selectedId, setSelectedId] = useState<string>('')
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)
  const [loadingQr, setLoadingQr] = useState(false)

  async function handleSelect(id: string) {
    setSelectedId(id)
    setQrDataUrl(null)
    setQrError(null)
    setLoadingQr(true)
    const { data, error } = await supabase.rpc('ensure_booking_qr', { p_booking_id: id })
    setLoadingQr(false)
    if (error || !data) {
      setQrError('تعذّر إنشاء رمز QR لهذا الحجز.')
      return
    }
    const url = await QRCode.toDataURL(data as string, { width: 240, margin: 1 })
    setQrDataUrl(url)
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="رمزي" description="رمز QR لتسجيل الحضور عند الوصول" />

      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}

      {!isLoading && bookings.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          لا توجد حجوزات قادمة.
        </p>
      )}

      {bookings.length > 0 && (
        <Select value={selectedId} onValueChange={handleSelect}>
          <SelectTrigger>
            <SelectValue placeholder="اختر حجزًا لعرض رمزه" />
          </SelectTrigger>
          <SelectContent>
            {bookings.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.fields?.name} — {new Date(b.start_at).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long' })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {loadingQr && <p className="text-sm text-text-secondary">جارٍ إنشاء الرمز...</p>}
      {qrError && <p className="text-sm text-status-danger">{qrError}</p>}

      {qrDataUrl && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-6">
          <img src={qrDataUrl} alt="رمز QR" className="size-60" />
          <p className="text-xs text-text-secondary">اعرض هذا الرمز عند وصولك للنادي</p>
        </div>
      )}
    </div>
  )
}
