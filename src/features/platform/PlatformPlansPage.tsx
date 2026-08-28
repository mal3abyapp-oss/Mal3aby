import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { MoneyDisplay } from '@/components/ui/money-display'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface PlanRow {
  id: string
  name_ar: string
  billing_interval: string
  billing_interval_count: number
  price: number
  currency: string
  is_public: boolean
  display_order: number
  // PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 4: optional plan
  // defaults (see migration 20260828230000_plan_entitlement_seeding.sql).
  // Seed-only, never retroactive -- see set_commercial_entitlements's
  // sibling create_platform_subscription() for the actual seeding logic.
  default_modules: string[] | null
  default_branch_limit: number | null
  default_field_limit: number | null
  default_academy_limit: number | null
}

const DEFAULT_MODULE_OPTIONS = ['fields', 'academy', 'shop', 'club_membership'] as const

async function fetchPlans(): Promise<PlanRow[]> {
  const { data, error } = await supabase.from('platform_plans').select('*').order('display_order')
  if (error) throw error
  return data ?? []
}

const INTERVAL_LABEL: Record<string, string> = { month: 'شهر', year: 'سنة' }

export function PlatformPlansPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: plans = [], isLoading } = useQuery({ queryKey: ['platform-plans-all'], queryFn: fetchPlans })

  // V1 Implementation Gap Audit (2026-08-16): platform_plans has full
  // CRUD RLS for platform_owner (platform_plans_platform_owner_full_access,
  // cmd=ALL) but the UI only ever offered a publish/unpublish toggle --
  // no way to actually change a plan's price or name without the
  // Supabase dashboard, despite the table's own DB comment describing
  // editing as an expected operation ("editing never retroactively
  // changes an already-created platform_subscriptions row").
  const [editingPlan, setEditingPlan] = useState<PlanRow | null>(null)
  const [editName, setEditName] = useState('')
  const [editPrice, setEditPrice] = useState('')
  // PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 4: optional plan
  // defaults -- empty selection/blank inputs mean "this plan defines no
  // defaults" (the RPC's own NULL semantics), not "zero of everything".
  const [editDefaultModules, setEditDefaultModules] = useState<string[]>([])
  const [editDefaultBranchLimit, setEditDefaultBranchLimit] = useState('')
  const [editDefaultFieldLimit, setEditDefaultFieldLimit] = useState('')
  const [editDefaultAcademyLimit, setEditDefaultAcademyLimit] = useState('')

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isPublic }: { id: string; isPublic: boolean }) => {
      const { error } = await supabase.rpc('set_plan_publish_status', { p_plan_id: id, p_is_public: !isPublic })
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-plans-all'] }),
  })

  const updatePlanMutation = useMutation({
    mutationFn: async () => {
      if (!editingPlan) throw new Error('no plan selected')
      const toLimit = (v: string) => (v.trim() === '' ? null : Number(v))
      const { error } = await supabase.rpc('update_platform_plan', {
        p_plan_id: editingPlan.id,
        p_name_ar: editName.trim(),
        p_price: Number(editPrice),
        p_reason: 'Commercial plan definition updated',
        p_default_modules: editDefaultModules.length > 0 ? editDefaultModules : undefined,
        p_default_branch_limit: toLimit(editDefaultBranchLimit) ?? undefined,
        p_default_field_limit: toLimit(editDefaultFieldLimit) ?? undefined,
        p_default_academy_limit: toLimit(editDefaultAcademyLimit) ?? undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setEditingPlan(null)
      void queryClient.invalidateQueries({ queryKey: ['platform-plans-all'] })
    },
  })

  const columns: DataTableColumn<PlanRow>[] = [
    {
      key: 'name',
      header: t('platform.plansPage.columns.plan'),
      render: (p) => (
        <button
          className="text-accent-foreground hover:underline"
          onClick={() => {
            setEditingPlan(p)
            setEditName(p.name_ar)
            setEditPrice(String(p.price))
            setEditDefaultModules(p.default_modules ?? [])
            setEditDefaultBranchLimit(p.default_branch_limit?.toString() ?? '')
            setEditDefaultFieldLimit(p.default_field_limit?.toString() ?? '')
            setEditDefaultAcademyLimit(p.default_academy_limit?.toString() ?? '')
          }}
        >
          {p.name_ar}
        </button>
      ),
    },
    {
      key: 'interval',
      header: t('platform.plansPage.columns.interval'),
      render: (p) =>
        `${p.billing_interval_count} ${t(`platform.plansPage.intervalLabels.${p.billing_interval}`, {
          defaultValue: INTERVAL_LABEL[p.billing_interval] ?? p.billing_interval,
        })}`,
    },
    { key: 'price', header: t('platform.plansPage.columns.price'), render: (p) => <MoneyDisplay amount={Number(p.price)} currency={p.currency} size="sm" /> },
    {
      key: 'public',
      header: t('platform.plansPage.columns.publish'),
      render: (p) =>
        p.is_public ? (
          <StatusBadge tone="success" label={t('platform.plansPage.published')} />
        ) : (
          <StatusBadge tone="neutral" label={t('platform.plansPage.unpublished')} />
        ),
    },
    {
      key: 'actions',
      header: '',
      render: (p) => (
        <Button size="sm" variant="outline" onClick={() => toggleMutation.mutate({ id: p.id, isPublic: p.is_public })}>
          {p.is_public ? t('platform.plansPage.unpublish') : t('platform.plansPage.publish')}
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader title={t('platform.plansPage.title')} description={t('platform.plansPage.description')} />
      <DataTable columns={columns} rows={plans} rowKey={(p) => p.id} isLoading={isLoading} emptyTitle={t('platform.plansPage.emptyTitle')} />

      <Dialog open={!!editingPlan} onOpenChange={(open) => !open && setEditingPlan(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('platform.plansPage.editDialog.title', { name: editingPlan?.name_ar })}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('platform.plansPage.editDialog.nameLabel')}</label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('platform.plansPage.editDialog.priceLabel', { currency: editingPlan?.currency })}</label>
              <Input type="number" min="0" step="0.01" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} />
            </div>
            <p className="text-xs text-text-secondary">
              {t('platform.plansPage.editDialog.priceChangeNote')}
            </p>
            {/* PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 4: optional
                plan defaults -- only take effect for a NEW subscription
                on a club with no existing configuration; never
                retroactive, matching the price-change note above. */}
            <div className="flex flex-col gap-1.5 border-t border-border pt-3">
              <label className="text-sm font-medium text-text-secondary">{t('platform.plansPage.editDialog.defaultModulesLabel')}</label>
              <div className="flex flex-wrap gap-3">
                {DEFAULT_MODULE_OPTIONS.map((m) => (
                  <label key={m} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={editDefaultModules.includes(m)}
                      onChange={(e) =>
                        setEditDefaultModules((prev) => (e.target.checked ? [...prev, m] : prev.filter((x) => x !== m)))
                      }
                    />
                    {t(`platform.clubDetailPage.modules.${m === 'club_membership' ? 'clubMembership' : m}`)}
                  </label>
                ))}
              </div>
              <p className="text-xs text-text-secondary">{t('platform.plansPage.editDialog.defaultModulesHint')}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('platform.plansPage.editDialog.defaultBranchLimitLabel')}</label>
                <Input type="number" min="0" value={editDefaultBranchLimit} onChange={(e) => setEditDefaultBranchLimit(e.target.value)} placeholder={t('platform.clubDetailPage.limitsCard.unlimitedPlaceholder')} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('platform.plansPage.editDialog.defaultFieldLimitLabel')}</label>
                <Input type="number" min="0" value={editDefaultFieldLimit} onChange={(e) => setEditDefaultFieldLimit(e.target.value)} placeholder={t('platform.clubDetailPage.limitsCard.unlimitedPlaceholder')} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('platform.plansPage.editDialog.defaultAcademyLimitLabel')}</label>
                <Input type="number" min="0" value={editDefaultAcademyLimit} onChange={(e) => setEditDefaultAcademyLimit(e.target.value)} placeholder={t('platform.clubDetailPage.limitsCard.unlimitedPlaceholder')} />
              </div>
            </div>
            <Button disabled={!editName.trim() || !editPrice || Number(editPrice) <= 0 || updatePlanMutation.isPending} onClick={() => updatePlanMutation.mutate()}>
              {updatePlanMutation.isPending ? t('platform.plansPage.editDialog.saving') : t('platform.plansPage.editDialog.save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
