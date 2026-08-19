import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translateSupabaseError } from '@/lib/errors'

/**
 * BookingPolicyCard -- directive Part XVI, Section 60: Booking Policy
 * settings. Reads/writes via get_public_club_booking_policy() (already
 * anon-safe, reused here for staff too since it always returns
 * defaults for a club with no row yet -- exactly what this form should
 * show before the owner ever saves anything) and
 * set_club_booking_policy() (the real RPC, permission-gated on
 * club.update, matches the pattern used elsewhere in Settings).
 */
interface BookingPolicy {
  sameDayOnlineBookingEnabled: boolean
  onlineBookingStartOffsetDays: number
  onlineBookingWindowDays: number
  paymentHoldMinutes: number
}

async function fetchPolicy(clubId: string): Promise<BookingPolicy> {
  const { data, error } = await supabase.rpc('get_public_club_booking_policy', { p_club_id: clubId })
  if (error) throw error
  const row = data?.[0]
  return {
    sameDayOnlineBookingEnabled: row?.same_day_online_booking_enabled ?? false,
    onlineBookingStartOffsetDays: row?.online_booking_start_offset_days ?? 1,
    onlineBookingWindowDays: row?.online_booking_window_days ?? 2,
    paymentHoldMinutes: row?.payment_hold_minutes ?? 60,
  }
}

export function BookingPolicyCard() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<BookingPolicy | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['club-booking-policy', currentClubId],
    queryFn: () => fetchPolicy(currentClubId!),
    enabled: !!currentClubId,
  })

  useEffect(() => {
    if (data && !form) setForm(data)
  }, [data, form])

  const mutation = useMutation({
    mutationFn: async () => {
      if (!form) return
      const { error: rpcError } = await supabase.rpc('set_club_booking_policy', {
        p_club_id: currentClubId!,
        p_same_day_online_booking_enabled: form.sameDayOnlineBookingEnabled,
        p_online_booking_start_offset_days: form.onlineBookingStartOffsetDays,
        p_online_booking_window_days: form.onlineBookingWindowDays,
        p_payment_hold_minutes: form.paymentHoldMinutes,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: () => {
      setSaved(true)
      setError(null)
      setTimeout(() => setSaved(false), 3000)
      void queryClient.invalidateQueries({ queryKey: ['club-booking-policy', currentClubId] })
    },
    onError: (err) => setError(translateSupabaseError(err, t('clubs.bookingPolicyCard.saveError'))),
  })

  if (isLoading || !form) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">{t('clubs.bookingPolicyCard.title')}</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-text-secondary">{t('clubs.bookingPolicyCard.loading')}</p></CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('clubs.bookingPolicyCard.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">{t('clubs.bookingPolicyCard.sameDayLabel')}</p>
            <p className="text-xs text-text-secondary">{t('clubs.bookingPolicyCard.sameDayHint')}</p>
          </div>
          <Button
            size="sm"
            variant={form.sameDayOnlineBookingEnabled ? 'outline' : 'default'}
            onClick={() => setForm({ ...form, sameDayOnlineBookingEnabled: !form.sameDayOnlineBookingEnabled })}
          >
            {form.sameDayOnlineBookingEnabled ? t('clubs.bookingPolicyCard.disable') : t('clubs.bookingPolicyCard.enable')}
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-text-secondary">{t('clubs.bookingPolicyCard.startOffsetLabel')}</label>
            <Input
              type="number"
              min={0}
              max={14}
              value={form.onlineBookingStartOffsetDays}
              onChange={(e) => setForm({ ...form, onlineBookingStartOffsetDays: Number(e.target.value) })}
            />
            <p className="text-xs text-text-secondary">{t('clubs.bookingPolicyCard.startOffsetHint')}</p>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-text-secondary">{t('clubs.bookingPolicyCard.windowLabel')}</label>
            <Input
              type="number"
              min={1}
              max={30}
              value={form.onlineBookingWindowDays}
              onChange={(e) => setForm({ ...form, onlineBookingWindowDays: Number(e.target.value) })}
            />
            <p className="text-xs text-text-secondary">{t('clubs.bookingPolicyCard.windowHint')}</p>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-text-secondary">{t('clubs.bookingPolicyCard.holdMinutesLabel')}</label>
            <Input
              type="number"
              min={5}
              max={1440}
              value={form.paymentHoldMinutes}
              onChange={(e) => setForm({ ...form, paymentHoldMinutes: Number(e.target.value) })}
            />
            <p className="text-xs text-text-secondary">{t('clubs.bookingPolicyCard.holdMinutesHint')}</p>
          </div>
        </div>

        {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? t('clubs.bookingPolicyCard.saving') : t('clubs.bookingPolicyCard.save')}
          </Button>
          {saved && <span className="text-sm text-status-success">{t('clubs.bookingPolicyCard.saved')}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
