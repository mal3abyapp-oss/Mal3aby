import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckCircle2, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'

// Dismissible checklist, not a wizard continuation (ADR-043). Each item is
// an independent existence check, not stored progress state. "Add a field"
// and "create a first booking" are deferred until Phase 5/6 build those
// tables — listed here as not-yet-actionable so the checklist still
// reflects the true four-item scope from IMPLEMENTATION_PLAN.md without
// linking to routes that don't do anything real yet.
const STORAGE_KEY = 'mala3by.firstRunChecklistDismissed'

async function fetchChecklistState(clubId: string) {
  const [{ count: staffCount }, { count: customerCount }] = await Promise.all([
    supabase.from('club_memberships').select('id', { count: 'exact', head: true }).eq('club_id', clubId).eq('status', 'active'),
    // customers table doesn't exist until Phase 4 -- guarded below.
    Promise.resolve({ count: null as number | null }),
  ])
  return {
    hasStaff: (staffCount ?? 0) > 1, // >1 because the owner's own membership always exists
    hasCustomer: (customerCount ?? 0) > 0,
  }
}

export function FirstRunChecklist() {
  const { currentClubId } = useAuth()
  const { data } = useQuery({
    queryKey: ['first-run-checklist', currentClubId],
    queryFn: () => fetchChecklistState(currentClubId!),
    enabled: !!currentClubId,
  })

  if (typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true') {
    return null
  }

  const items = [
    { label: 'أضف موظفًا', done: !!data?.hasStaff, to: '/app/staff' },
    { label: 'أضف أول عميل', done: !!data?.hasCustomer, to: '/app/customers' },
    { label: 'أضف ملعبًا (قريبًا)', done: false, to: null },
    { label: 'أنشئ أول حجز (قريبًا)', done: false, to: null },
  ]

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">خطوات البداية</CardTitle>
        <button
          className="text-xs text-text-secondary hover:underline"
          onClick={() => {
            localStorage.setItem(STORAGE_KEY, 'true')
            window.location.reload()
          }}
        >
          إخفاء
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
