import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

// Club Memberships -- Plans tab. Plan create/edit/archive, mirroring
// PlayersSection.tsx/EnrollmentSection.tsx's own dialog-with-mutation
// shape and CashShiftPage.tsx's inline branch-fetch pattern (no shared
// useBranches hook exists in this codebase).

interface PlanRow {
  plan_id: string
  name_ar: string
  name_en: string
  description: string | null
  price: number
  duration_value: number
  duration_unit: 'day' | 'month' | 'year'
  is_active: boolean
  is_public: boolean
  allow_renewal: boolean
  allow_freeze: boolean
  max_freeze_days_per_period: number | null
  branch_scope: 'all_branches' | 'selected_branches'
  sort_order: number
  archived_at: string | null
  active_membership_count: number
  total_membership_count: number
  branch_ids: string[]
}

interface BranchRow { id: string; name: string }

async function fetchPlans(clubId: string, includeArchived: boolean): Promise<PlanRow[]> {
  const { data, error } = await supabase.rpc('list_club_membership_plans', { p_club_id: clubId, p_include_archived: includeArchived })
  if (error) throw error
  return (data ?? []) as unknown as PlanRow[]
}

async function fetchBranches(clubId: string): Promise<BranchRow[]> {
  const { data, error } = await supabase.from('branches').select('id, name').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

export function PlansSection() {
  const { t, i18n } = useTranslation()
  const { currentClubId, currentMembership } = useAuth()
  const queryClient = useQueryClient()
  const canManage = (currentMembership?.permissionKeys ?? []).includes('club_membership.plan.manage')

  const [includeArchived, setIncludeArchived] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editingPlan, setEditingPlan] = useState<PlanRow | null>(null)

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ['club-membership-plans', currentClubId, includeArchived],
    queryFn: () => fetchPlans(currentClubId!, includeArchived),
    enabled: !!currentClubId,
  })

  const { data: branches = [] } = useQuery({
    queryKey: ['branches-for-membership-plans', currentClubId],
    queryFn: () => fetchBranches(currentClubId!),
    enabled: !!currentClubId,
  })

  const branchNameById = new Map(branches.map((b) => [b.id, b.name]))

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['club-membership-plans', currentClubId] })
  }

  const archiveMutation = useMutation({
    mutationFn: async (planId: string) => {
      const { error } = await supabase.rpc('archive_club_membership_plan', { p_plan_id: planId })
      if (error) throw error
    },
    onSuccess: invalidate,
  })

  const restoreMutation = useMutation({
    mutationFn: async (planId: string) => {
      const { error } = await supabase.rpc('restore_club_membership_plan', { p_plan_id: planId })
      if (error) throw error
    },
    onSuccess: invalidate,
  })

  const columns: DataTableColumn<PlanRow>[] = [
    {
      key: 'name',
      header: t('clubMemberships.plans.columns.name'),
      render: (p) => (
        <button
          className="text-start font-medium text-accent-foreground hover:underline disabled:cursor-default disabled:text-text-primary disabled:no-underline"
          disabled={!canManage}
          onClick={() => canManage && setEditingPlan(p)}
        >
          {i18n.language === 'en' ? p.name_en : p.name_ar}
        </button>
      ),
    },
    {
      key: 'price',
      header: t('clubMemberships.plans.columns.price'),
      render: (p) => <span className="tabular-nums">{p.price.toFixed(0)} {t('common.currency')}</span>,
    },
    {
      key: 'duration',
      header: t('clubMemberships.plans.columns.duration'),
      // Bug found in live QA (2026-08-30): this concatenated the raw
      // count with durationUnits' combined "month/months" dropdown
      // label, always rendering nonsense like "1 شهر/أشهر" ("1
      // month/months") instead of correctly-agreed "1 شهر" / "3
      // أشهر". durationUnits.* is still correct as-is for its own
      // use (the day/month/year picker, a generic unit-name label
      // shown once with no count attached) -- this needs real
      // count-based pluralization instead, via a dedicated key.
      render: (p) => t(`clubMemberships.durationDisplay.${p.duration_unit}`, { count: p.duration_value }),
    },
    {
      key: 'branchScope',
      header: t('clubMemberships.plans.columns.branches'),
      render: (p) => p.branch_scope === 'all_branches'
        ? t('clubMemberships.plans.allBranches')
        : (p.branch_ids.map((id) => branchNameById.get(id) ?? '—').join(', ') || '—'),
    },
    {
      key: 'members',
      header: t('clubMemberships.plans.columns.members'),
      render: (p) => <span className="tabular-nums">{p.active_membership_count} / {p.total_membership_count}</span>,
    },
    {
      key: 'status',
      header: t('clubMemberships.plans.columns.status'),
      render: (p) => p.archived_at
        ? <StatusBadge tone="neutral" label={t('clubMemberships.plans.archived')} />
        : <StatusBadge tone={p.is_active ? 'success' : 'warning'} label={t(p.is_active ? 'clubMemberships.plans.active' : 'clubMemberships.plans.inactive')} />,
    },
    {
      key: 'actions',
      header: '',
      render: (p) => canManage ? (
        p.archived_at ? (
          <Button size="sm" variant="outline" disabled={restoreMutation.isPending} onClick={() => restoreMutation.mutate(p.plan_id)}>
            {t('clubMemberships.plans.restore')}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={archiveMutation.isPending} onClick={() => archiveMutation.mutate(p.plan_id)}>
            {t('clubMemberships.plans.archive')}
          </Button>
        )
      ) : null,
    },
  ]

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
          {t('clubMemberships.plans.showArchived')}
        </label>
        {canManage && (
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm">{t('clubMemberships.plans.create')}</Button>
            </DialogTrigger>
            <PlanFormDialog
              clubId={currentClubId!}
              branches={branches}
              plan={null}
              onClose={() => setCreateOpen(false)}
              onSaved={() => { setCreateOpen(false); invalidate() }}
            />
          </Dialog>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={plans}
        rowKey={(p) => p.plan_id}
        isLoading={isLoading}
        emptyTitle={t('clubMemberships.plans.emptyTitle')}
        emptyDescription={t('clubMemberships.plans.emptyDescription')}
      />

      {editingPlan && (
        <Dialog open onOpenChange={(open) => !open && setEditingPlan(null)}>
          <PlanFormDialog
            clubId={currentClubId!}
            branches={branches}
            plan={editingPlan}
            onClose={() => setEditingPlan(null)}
            onSaved={() => { setEditingPlan(null); invalidate() }}
          />
        </Dialog>
      )}
    </div>
  )
}

function PlanFormDialog({
  clubId, branches, plan, onClose, onSaved,
}: {
  clubId: string
  branches: BranchRow[]
  plan: PlanRow | null
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const isEdit = !!plan

  const [nameAr, setNameAr] = useState(plan?.name_ar ?? '')
  const [nameEn, setNameEn] = useState(plan?.name_en ?? '')
  const [description, setDescription] = useState(plan?.description ?? '')
  const [price, setPrice] = useState(String(plan?.price ?? ''))
  const [durationValue, setDurationValue] = useState(String(plan?.duration_value ?? '1'))
  const [durationUnit, setDurationUnit] = useState<'day' | 'month' | 'year'>(plan?.duration_unit ?? 'month')
  const [isActive, setIsActive] = useState(plan?.is_active ?? true)
  const [isPublic, setIsPublic] = useState(plan?.is_public ?? true)
  const [allowRenewal, setAllowRenewal] = useState(plan?.allow_renewal ?? true)
  const [allowFreeze, setAllowFreeze] = useState(plan?.allow_freeze ?? false)
  const [maxFreezeDays, setMaxFreezeDays] = useState(plan?.max_freeze_days_per_period != null ? String(plan.max_freeze_days_per_period) : '')
  const [branchScope, setBranchScope] = useState<'all_branches' | 'selected_branches'>(plan?.branch_scope ?? 'all_branches')
  const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>(plan?.branch_ids ?? [])
  const [error, setError] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: async () => {
      const parsedPrice = Number(price)
      const parsedDuration = Number(durationValue)
      const parsedMaxFreeze = maxFreezeDays.trim() ? Number(maxFreezeDays) : null
      if (branchScope === 'selected_branches' && selectedBranchIds.length === 0) {
        throw new Error(t('clubMemberships.plans.errors.branchRequired'))
      }
      if (isEdit) {
        const { error: rpcError } = await supabase.rpc('update_club_membership_plan', {
          p_plan_id: plan!.plan_id,
          p_name_ar: nameAr,
          p_name_en: nameEn,
          p_description: description,
          p_price: parsedPrice,
          p_duration_value: parsedDuration,
          p_duration_unit: durationUnit,
          p_is_active: isActive,
          p_is_public: isPublic,
          p_allow_renewal: allowRenewal,
          p_allow_freeze: allowFreeze,
          p_max_freeze_days_per_period: parsedMaxFreeze as number,
          p_branch_scope: branchScope,
          p_branch_ids: branchScope === 'selected_branches' ? selectedBranchIds : undefined,
        })
        if (rpcError) throw rpcError
      } else {
        const { error: rpcError } = await supabase.rpc('create_club_membership_plan', {
          p_club_id: clubId,
          p_name_ar: nameAr,
          p_name_en: nameEn,
          p_description: description,
          p_price: parsedPrice,
          p_duration_value: parsedDuration,
          p_duration_unit: durationUnit,
          p_is_active: isActive,
          p_is_public: isPublic,
          p_allow_renewal: allowRenewal,
          p_allow_freeze: allowFreeze,
          p_max_freeze_days_per_period: parsedMaxFreeze ?? undefined,
          p_branch_scope: branchScope,
          p_branch_ids: branchScope === 'selected_branches' ? selectedBranchIds : undefined,
        })
        if (rpcError) throw rpcError
      }
    },
    onSuccess: onSaved,
    onError: (err) => setError(translateSupabaseError(err, t('clubMemberships.plans.errors.saveError'))),
  })

  function toggleBranch(id: string) {
    setSelectedBranchIds((prev) => prev.includes(id) ? prev.filter((b) => b !== id) : [...prev, id])
  }

  const canSubmit = !!nameAr.trim() && !!nameEn.trim() && !!price && Number(price) >= 0 && !!durationValue && Number(durationValue) > 0
    && (branchScope !== 'selected_branches' || selectedBranchIds.length > 0)

  return (
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{isEdit ? t('clubMemberships.plans.editTitle') : t('clubMemberships.plans.createTitle')}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            {/* Acceptance-sweep fix (2026-08-30): create_club_membership_plan()
                genuinely requires a non-empty name_en (raises an
                exception otherwise), and canSubmit below already gated
                Save on name_ar/name_en/price/durationValue all being
                filled -- but none of those four labels showed any
                required indicator. Confirmed live: filled name (Arabic),
                price, and duration, left name (English) blank (nothing
                marked it as needed), clicked Save -- the button had been
                silently disabled the whole time, no plan was created,
                no error shown (canSubmit blocks the mutation from ever
                firing, so there was nothing for the mutation's own error
                handling to catch). Added a plain required marker to all
                four fields the form already treats as mandatory. */}
            <label className="text-xs text-text-secondary">{t('clubMemberships.plans.nameAr')} *</label>
            <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('clubMemberships.plans.nameEn')} *</label>
            <Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} dir="ltr" />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-secondary">{t('clubMemberships.plans.description')}</label>
          <textarea
            className="min-h-16 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('clubMemberships.plans.price')} *</label>
            <Input type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('clubMemberships.plans.durationValue')} *</label>
            <Input type="number" min={1} value={durationValue} onChange={(e) => setDurationValue(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('clubMemberships.plans.durationUnit')}</label>
            <Select value={durationUnit} onValueChange={(v) => setDurationUnit(v as typeof durationUnit)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="day">{t('clubMemberships.durationUnits.day')}</SelectItem>
                <SelectItem value="month">{t('clubMemberships.durationUnits.month')}</SelectItem>
                <SelectItem value="year">{t('clubMemberships.durationUnits.year')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-secondary">{t('clubMemberships.plans.branchScope')}</label>
          <Select value={branchScope} onValueChange={(v) => setBranchScope(v as typeof branchScope)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all_branches">{t('clubMemberships.plans.allBranches')}</SelectItem>
              <SelectItem value="selected_branches">{t('clubMemberships.plans.selectedBranches')}</SelectItem>
            </SelectContent>
          </Select>
          {branchScope === 'selected_branches' && (
            <div className="mt-1 flex flex-col gap-1 rounded-md border border-border p-2">
              {branches.map((b) => (
                <label key={b.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={selectedBranchIds.includes(b.id)} onChange={() => toggleBranch(b.id)} />
                  {b.name}
                </label>
              ))}
              {branches.length === 0 && <p className="text-xs text-text-secondary">{t('clubMemberships.plans.noBranches')}</p>}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            {t('clubMemberships.plans.isActive')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            {t('clubMemberships.plans.isPublic')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowRenewal} onChange={(e) => setAllowRenewal(e.target.checked)} />
            {t('clubMemberships.plans.allowRenewal')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowFreeze} onChange={(e) => setAllowFreeze(e.target.checked)} />
            {t('clubMemberships.plans.allowFreeze')}
          </label>
          {allowFreeze && (
            <div className="flex flex-col gap-1 ps-6">
              <label className="text-xs text-text-secondary">{t('clubMemberships.plans.maxFreezeDays')}</label>
              <Input type="number" min={0} value={maxFreezeDays} onChange={(e) => setMaxFreezeDays(e.target.value)} className="w-32" placeholder={t('clubMemberships.plans.maxFreezeDaysUnlimited')} />
            </div>
          )}
        </div>

        {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}

        <div className="flex gap-2">
          <Button disabled={!canSubmit || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? t('common.saving', { defaultValue: 'Saving...' }) : t('common.save')}
          </Button>
          <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
        </div>
      </div>
    </DialogContent>
  )
}
