import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckCircle2, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { canSeeNavDomain, type NavDomain } from '@/lib/domain/navigation'

// Dismissible checklist, not a wizard continuation (ADR-043). Each item is
// an independent existence check, not stored progress state.
//
// Owner-level review finding (P1, dead/stale UI): "أضف ملعبًا" and
// "أنشئ أول حجز" were hardcoded to done=false with `to: null` and a
// "(قريبًا)" (Coming Soon) suffix, permanently unclickable -- leftover
// from a Phase-0-era comment claiming fields/bookings tables "don't
// exist until Phase 5/6". Both tables have existed and been fully
// functional since Phase 5/6 shipped, long before this review; real
// clubs in this dataset already have real fields and real bookings, so
// every club owner has been seeing a permanently-stuck "coming soon"
// message on their primary dashboard for no real reason. Also,
// hasCustomer was hardcoded via `Promise.resolve({ count: null })`
// with a comment claiming "customers table doesn't exist until Phase
// 4" -- also long since shipped -- so "أضف أول عميل" could never mark
// done even for a club with dozens of real customers. Fixed to real
// existence checks against the real, long-existing tables.
const STORAGE_KEY = 'mala3by.firstRunChecklistDismissed'

async function fetchChecklistState(clubId: string) {
  const [{ count: staffCount }, { count: customerCount }, { count: fieldCount }, { count: bookingCount }] = await Promise.all([
    supabase.from('club_memberships').select('id', { count: 'exact', head: true }).eq('club_id', clubId).eq('status', 'active'),
    supabase.from('customers').select('id', { count: 'exact', head: true }).eq('club_id', clubId),
    supabase.from('fields').select('id', { count: 'exact', head: true }).eq('club_id', clubId),
    supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('club_id', clubId),
  ])
  return {
    hasStaff: (staffCount ?? 0) > 1, // >1 because the owner's own membership always exists
    hasCustomer: (customerCount ?? 0) > 0,
    hasField: (fieldCount ?? 0) > 0,
    hasBooking: (bookingCount ?? 0) > 0,
  }
}

export function FirstRunChecklist() {
  const { t } = useTranslation()
  const { currentClubId, currentMembership } = useAuth()
  const { data } = useQuery({
    queryKey: ['first-run-checklist', currentClubId],
    queryFn: () => fetchChecklistState(currentClubId!),
    enabled: !!currentClubId,
  })

  if (typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true') {
    return null
  }

  const allItems: { label: string; done: boolean; to: string; domain: NavDomain }[] = [
    { label: t('dashboard.checklist.addStaff'), done: !!data?.hasStaff, to: '/app/staff', domain: 'staff' as const },
    { label: t('dashboard.checklist.addFirstCustomer'), done: !!data?.hasCustomer, to: '/app/customers', domain: 'customers' as const },
    // Fields live under Settings -> إعدادات الحجوزات (moved there in
    // the P1-7 usability pass) -- not a standalone /app/fields route.
    { label: t('dashboard.checklist.addField'), done: !!data?.hasField, to: '/app/fields', domain: 'settings' as const },
    { label: t('dashboard.checklist.createFirstBooking'), done: !!data?.hasBooking, to: '/app/bookings', domain: 'bookings' as const },
  ]
  const items = allItems.filter((item) => canSeeNavDomain(currentMembership?.roleKey, item.domain))

  if (items.length === 0) return null

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t('dashboard.checklist.title')}</CardTitle>
        <button
          className="text-xs text-text-secondary hover:underline"
          onClick={() => {
            localStorage.setItem(STORAGE_KEY, 'true')
            window.location.reload()
          }}
        >
          {t('dashboard.checklist.hide')}
        </button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-2 text-sm">
            {item.done ? (
              <CheckCircle2 className="size-4 text-status-success" />
            ) : (
              <Circle className="size-4 text-text-secondary" />
            )}
            {item.to ? (
              <Link to={item.to} className={cn('hover:underline', item.done && 'text-text-secondary line-through')}>
                {item.label}
              </Link>
            ) : (
              <span className="text-text-secondary">{item.label}</span>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
