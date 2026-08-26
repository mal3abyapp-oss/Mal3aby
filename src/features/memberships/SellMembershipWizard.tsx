import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CustomerSelector, type SelectedCustomer } from '@/components/ui/customer-selector'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { previewClubMembershipEndDate } from '@/lib/domain/clubMembership'

// Sell Membership wizard -- single scrollable dialog with progressive
// sections, mirroring PlayersSection.tsx's SubscribePlayerWizard shape
// (Customer -> Plan -> dates -> discount -> submit) rather than a
// step-indicator wizard component (none exists in this codebase).
// Customer search/create reuses CustomerSelector (the one shared
// upsert_customer entry point) rather than reimplementing it.

interface PlanOption {
  plan_id: string
  name_ar: string
  name_en: string
  price: number
  duration_value: number
  duration_unit: 'day' | 'month' | 'year'
  branch_scope: 'all_branches' | 'selected_branches'
  branch_ids: string[]
  is_active: boolean
}

interface BranchRow { id: string; name: string }

async function fetchActivePlans(clubId: string): Promise<PlanOption[]> {
  const { data, error } = await supabase.rpc('list_club_membership_plans', { p_club_id: clubId, p_include_archived: false })
  if (error) throw error
  return ((data ?? []) as unknown as PlanOption[]).filter((p) => p.is_active)
}

async function fetchBranches(clubId: string): Promise<BranchRow[]> {
  const { data, error } = await supabase.from('branches').select('id, name').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

export function SellMembershipWizard({
  onClose, onSold, initialCustomer,
}: {
  onClose: () => void
  onSold: () => void
  /** Pin the customer and hide the picker -- used from Customer 360's own "Sell membership" action, where the customer is already the page's own context. */
  initialCustomer?: SelectedCustomer
}) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { currentClubId } = useAuth()

  const [customer, setCustomer] = useState<SelectedCustomer | null>(initialCustomer ?? null)
  const [planId, setPlanId] = useState('')
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [branchId, setBranchId] = useState('')
  const [discount, setDiscount] = useState('0')
  const [error, setError] = useState<string | null>(null)

  const { data: plans = [] } = useQuery({ queryKey: ['club-membership-plans-active', currentClubId], queryFn: () => fetchActivePlans(currentClubId!), enabled: !!currentClubId })
  const { data: branches = [] } = useQuery({ queryKey: ['branches-for-sell-membership', currentClubId], queryFn: () => fetchBranches(currentClubId!), enabled: !!currentClubId })

  const plan = plans.find((p) => p.plan_id === planId) ?? null
  const allowedBranches = plan?.branch_scope === 'selected_branches'
    ? branches.filter((b) => plan.branch_ids.includes(b.id))
    : branches

  const price = plan?.price ?? 0
  const total = Math.max(price - Number(discount || 0), 0)
  const endDatePreview = plan ? previewClubMembershipEndDate(startDate, plan.duration_value, plan.duration_unit) : null

  const sellMutation = useMutation({
    mutationFn: async () => {
      if (!customer?.id) throw new Error(t('clubMemberships.sell.errors.customerRequired'))
      if (!plan) throw new Error(t('clubMemberships.sell.errors.planRequired'))
      const resolvedBranchId = plan.branch_scope === 'selected_branches' ? branchId : (branchId || allowedBranches[0]?.id)
      if (!resolvedBranchId) throw new Error(t('clubMemberships.sell.errors.branchRequired'))
      const { data, error: rpcError } = await supabase.rpc('sell_club_membership', {
        p_club_id: currentClubId!,
        p_customer_id: customer.id,
        p_plan_id: plan.plan_id,
        p_branch_id: resolvedBranchId,
        p_start_date: startDate,
        p_discount: Number(discount || 0),
        p_idempotency_key: crypto.randomUUID(),
      })
      if (rpcError) throw rpcError
      return data?.[0]
    },
    onSuccess: (row) => {
      onSold()
      if (row?.invoice_id) {
        navigate(`/app/finance/payments?invoice=${row.invoice_id}`)
      }
    },
    onError: (err) => setError(translateSupabaseError(err, t('clubMemberships.sell.errors.sellError'))),
  })

  const needsBranchChoice = plan?.branch_scope === 'selected_branches'
  const canSubmit = !!customer?.id && !!plan && !!startDate && (!needsBranchChoice || !!branchId)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('clubMemberships.sell.title')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          {!initialCustomer && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('customers.page.title')}</label>
              <CustomerSelector clubId={currentClubId as string} value={customer} onSelect={setCustomer} />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('clubMemberships.membershipPlan')}</label>
            <Select value={planId} onValueChange={(v) => { setPlanId(v); setBranchId('') }}>
              <SelectTrigger><SelectValue placeholder={t('clubMemberships.membershipPlan')} /></SelectTrigger>
              <SelectContent>
                {plans.map((p) => (
                  <SelectItem key={p.plan_id} value={p.plan_id}>
                    {i18n.language === 'en' ? p.name_en : p.name_ar} — {p.price.toFixed(0)} {t('common.currency')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {needsBranchChoice && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('clubMemberships.branch')}</label>
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger><SelectValue placeholder={t('clubMemberships.branch')} /></SelectTrigger>
                <SelectContent>
                  {allowedBranches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('clubMemberships.startDate')}</label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('clubMemberships.expiryDate')}</label>
              <Input disabled value={endDatePreview ?? '—'} />
            </div>
          </div>

          {plan && (
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span className="text-text-secondary">{t('clubMemberships.sell.planPrice')}</span>
                  <span className="font-medium tabular-nums">{price.toFixed(0)} {t('common.currency')}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-secondary">{t('academy.enrollments.discount')}</span>
                  <Input type="number" min={0} max={price} value={discount} onChange={(e) => setDiscount(e.target.value)} className="h-7 w-24 text-end" />
                </div>
                <div className="mt-1 flex justify-between border-t border-accent/20 pt-1 font-semibold">
                  <span>{t('academy.enrollments.total')}</span>
                  <span className="tabular-nums">{total.toFixed(0)} {t('common.currency')}</span>
                </div>
              </div>
            </div>
          )}

          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}

          <Button disabled={!canSubmit || sellMutation.isPending} onClick={() => sellMutation.mutate()}>
            {sellMutation.isPending ? t('academy.enrollments.enrolling') : t('clubMemberships.sell.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
