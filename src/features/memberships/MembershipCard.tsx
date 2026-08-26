import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { StatusBadge } from '@/components/ui/status-badge'
import { CLUB_MEMBERSHIP_STATUS_TONE } from '@/lib/domain/clubMembership'

// Digital Membership Card -- directive task 4. Mobile-first, shown both
// from staff's MemberDetailDialog ("QR/Card" action) and from the
// customer Portal's "My Memberships" page. Deliberately does NOT show
// price, payment method, or invoice details (directive requirement) --
// this is an identity/entitlement card, not a receipt.
//
// QR rendering mirrors PlayersSection.tsx's ensure_player_qr pattern
// exactly: mint a fresh raw token every time the card is displayed (never
// cache it beyond this component's lifetime) via
// ensure_customer_membership_qr(p_customer_id), then encode it
// client-side with the same `qrcode` package call
// (QRCode.toDataURL(rawToken, { width, margin })).

interface ClubInfo {
  name: string | null
  nameAr: string | null
  logoUrl: string | null
}

async function fetchClubInfo(clubId: string): Promise<ClubInfo> {
  const { data, error } = await supabase.from('clubs').select('name, name_ar, logo_url').eq('id', clubId).maybeSingle()
  if (error) throw error
  return { name: data?.name ?? null, nameAr: data?.name_ar ?? null, logoUrl: data?.logo_url ?? null }
}

export interface MembershipCardData {
  clubId: string
  customerId: string
  customerName: string
  customerPhotoUrl: string | null
  membershipNumber: string
  planName: string
  effectiveStatus: string
  effectiveEndDate: string | null
}

export function MembershipCard({ data }: { data: MembershipCardData }) {
  const { t, i18n } = useTranslation()
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState(false)

  const { data: club } = useQuery({
    queryKey: ['club-info-for-membership-card', data.clubId],
    queryFn: () => fetchClubInfo(data.clubId),
    enabled: !!data.clubId,
  })

  const clubName = i18n.language === 'en' ? (club?.name ?? club?.nameAr) : (club?.nameAr ?? club?.name)

  useEffect(() => {
    let cancelled = false
    setQrDataUrl(null)
    setQrError(false)
    ;(async () => {
      const { data: rawToken, error } = await supabase.rpc('ensure_customer_membership_qr', { p_customer_id: data.customerId })
      if (cancelled) return
      if (error || !rawToken) {
        setQrError(true)
        return
      }
      const dataUrl = await QRCode.toDataURL(rawToken as string, { width: 220, margin: 1 })
      if (!cancelled) setQrDataUrl(dataUrl)
    })().catch(() => { if (!cancelled) setQrError(true) })
    return () => { cancelled = true }
  }, [data.customerId])

  return (
    <div className="mx-auto flex w-full max-w-xs flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2">
        {club?.logoUrl ? (
          <img src={club.logoUrl} alt={clubName ?? ''} className="size-8 rounded-full object-cover" />
        ) : (
          <div className="flex size-8 items-center justify-center rounded-full bg-muted text-sm font-semibold">
            {clubName?.charAt(0) ?? '—'}
          </div>
        )}
        <p className="text-sm font-semibold text-text-primary">{clubName}</p>
      </div>

      <div className="flex items-center gap-3 border-t border-border pt-3">
        {data.customerPhotoUrl ? (
          <img src={data.customerPhotoUrl} alt={data.customerName} className="size-14 rounded-full object-cover" />
        ) : (
          <div className="flex size-14 items-center justify-center rounded-full bg-muted text-lg font-semibold">
            {data.customerName.charAt(0)}
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate font-bold text-text-primary">{data.customerName}</p>
          <p className="text-xs text-text-secondary">{data.planName}</p>
          <p className="text-xs tabular-nums text-text-secondary"><bdi>{data.membershipNumber}</bdi></p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <StatusBadge
          tone={CLUB_MEMBERSHIP_STATUS_TONE[data.effectiveStatus] ?? 'neutral'}
          label={t(`clubMemberships.statusLabels.${data.effectiveStatus}`, { defaultValue: data.effectiveStatus })}
        />
        {data.effectiveEndDate && (
          <span className="text-xs text-text-secondary">
            {t('clubMemberships.validUntil', { date: data.effectiveEndDate })}
          </span>
        )}
      </div>

      <div className="flex flex-col items-center gap-2 border-t border-border pt-3">
        {qrDataUrl ? (
          <img src={qrDataUrl} alt={t('clubMemberships.qrAlt')} className="size-40" />
        ) : qrError ? (
          <p className="text-xs text-status-danger">{t('clubMemberships.qrError')}</p>
        ) : (
          <div className="flex size-40 items-center justify-center text-xs text-text-secondary">{t('clubMemberships.generatingQr')}</div>
        )}
        <p className="text-center text-xs text-text-secondary">{t('clubMemberships.qrHint')}</p>
      </div>
    </div>
  )
}
