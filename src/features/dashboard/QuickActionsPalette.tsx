import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/app/providers/AuthProvider'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { CalendarPlus, UserPlus, Wallet, ScanLine, Receipt } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Desktop-only Quick Actions palette (Ctrl/Cmd+K), per SCREEN_MAP.md --
// each item opens an existing flow from Phases 4/6/7/8, never a new
// implementation of any of them. Role-filtered client-side (each target
// route/flow is still independently gated server-side by RLS -- this is
// only about not showing a shortcut to an action the user can't complete).
interface QuickAction {
  id: string
  labelKey: string
  icon: LucideIcon
  to: string
  roles: string[] // role keys allowed to see this action
}

const ACTIONS: QuickAction[] = [
  { id: 'new-booking', labelKey: 'dashboard.quickActionsPalette.actions.newBooking', icon: CalendarPlus, to: '/app/bookings', roles: ['club_owner', 'club_manager', 'branch_manager', 'receptionist'] },
  { id: 'new-customer', labelKey: 'dashboard.quickActionsPalette.actions.newCustomer', icon: UserPlus, to: '/app/customers', roles: ['club_owner', 'club_manager', 'branch_manager', 'receptionist', 'academy_manager'] },
  { id: 'collect-payment', labelKey: 'dashboard.quickActionsPalette.actions.collectPayment', icon: Wallet, to: '/app/billing', roles: ['club_owner', 'club_manager', 'branch_manager', 'receptionist', 'accountant'] },
  { id: 'scan-qr', labelKey: 'dashboard.quickActionsPalette.actions.scanQr', icon: ScanLine, to: '/scan', roles: ['club_owner', 'club_manager', 'branch_manager', 'receptionist', 'scanner'] },
  { id: 'find-invoice', labelKey: 'dashboard.quickActionsPalette.actions.findInvoice', icon: Receipt, to: '/app/billing', roles: ['club_owner', 'club_manager', 'branch_manager', 'receptionist', 'accountant'] },
]

export function QuickActionsPalette() {
  const { t } = useTranslation()
  const { currentMembership } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const visibleActions = useMemo(() => {
    const roleKey = currentMembership?.roleKey
    if (!roleKey) return []
    return ACTIONS.filter((a) => a.roles.includes(roleKey))
  }, [currentMembership])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (visibleActions.length === 0) return null

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md p-2">
        <p className="px-2 pb-2 pt-1 text-xs text-text-secondary">{t('dashboard.quickActionsPalette.heading')}</p>
        <div className="flex flex-col gap-1">
          {visibleActions.map((action) => (
            <button
              key={action.id}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-start text-sm hover:bg-muted/50"
              onClick={() => {
                setOpen(false)
                navigate(action.to)
              }}
            >
              <action.icon className="size-4 text-text-secondary" />
              {t(action.labelKey)}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
