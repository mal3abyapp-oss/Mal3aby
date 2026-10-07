import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Building, Pencil, Plus } from 'lucide-react'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RENTAL_SPACE_TYPES, RENT_CYCLES, rentalSpaceTypeLabel, rentCycleLabel } from '@/lib/domain/rental'
import { useInvalidateRentals, useRentalPermissions, useRentalSpaces } from './hooks'
import type { RentalSpaceRow } from './types'
import { NewContractDialog } from './NewContractDialog'
import { Field } from './Field'

const SPACE_STATUS_TONE = { active: 'success', inactive: 'warning', archived: 'neutral' } as const

export function SpacesSection() {
  const { t } = useTranslation()
  const { canManageSpaces, canCreateContracts } = useRentalPermissions()
  const invalidate = useInvalidateRentals()
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<RentalSpaceRow | 'new' | null>(null)
  const [rentSpaceId, setRentSpaceId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const { data: spaces = [], isLoading, isError, error, refetch } = useRentalSpaces(showArchived)

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error: rpcError } = await supabase.rpc('set_rental_space_status', { p_space_id: id, p_status: status })
      if (rpcError) throw rpcError
    },
    onSuccess: () => { setActionError(null); invalidate() },
    onError: (err) => setActionError(translateSupabaseError(err, t('rentals.spaces.statusError'))),
  })

  const actionsColumn: DataTableColumn<RentalSpaceRow> = {
    key: 'actions',
    header: '',
    hideOnCard: true,
    render: (s) => (
      <div className="flex flex-wrap justify-end gap-1">
        {canCreateContracts && s.status === 'active' && (
          <Button size="sm" variant="outline" onClick={() => setRentSpaceId(s.id)}>{t('rentals.contracts.new')}</Button>
        )}
        {canManageSpaces && (
          <>
            <Button size="sm" variant="ghost" aria-label={t('common.edit', { defaultValue: 'Edit' })} onClick={() => setEditing(s)}><Pencil /></Button>
            {s.status === 'active' && (
              <Button size="sm" variant="ghost" onClick={() => statusMutation.mutate({ id: s.id, status: 'inactive' })}>{t('rentals.spaces.deactivate')}</Button>
            )}
            {s.status === 'inactive' && (
              <Button size="sm" variant="ghost" onClick={() => statusMutation.mutate({ id: s.id, status: 'active' })}>{t('rentals.spaces.activate')}</Button>
            )}
            {s.status !== 'archived' ? (
              <Button size="sm" variant="ghost" onClick={() => statusMutation.mutate({ id: s.id, status: 'archived' })}>{t('rentals.spaces.archive')}</Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => statusMutation.mutate({ id: s.id, status: 'active' })}>{t('rentals.spaces.restore')}</Button>
            )}
          </>
        )}
      </div>
    ),
  }

  const columns: DataTableColumn<RentalSpaceRow>[] = [
    {
      key: 'name',
      header: t('rentals.spaces.name'),
      cardPriority: 'primary',
      render: (s) => (
        <div className="flex flex-col">
          <span className="font-medium">{s.name}</span>
          <span className="text-xs text-text-secondary">{rentalSpaceTypeLabel(t, s.space_type, s.custom_type_label)}</span>
        </div>
      ),
    },
    { key: 'branch', header: t('rentals.branch'), render: (s) => s.branch_name },
    {
      key: 'occupancy',
      header: t('rentals.spaces.occupancy'),
      render: (s) => s.current_contract ? (
        <span className="text-sm">
          {s.current_contract.customer_name} · <span className="tabular-nums"><bdi>{s.current_contract.contract_number}</bdi></span>
          <span className="block text-xs text-text-secondary">{t('rentals.spaces.until', { date: s.current_contract.end_date })}</span>
        </span>
      ) : (
        <StatusBadge tone="info" label={t('rentals.spaces.vacant')} />
      ),
    },
    {
      key: 'defaultRent',
      header: t('rentals.spaces.defaultRent'),
      render: (s) => s.default_rent_amount != null ? (
        <span className="flex flex-col">
          <MoneyDisplay amount={Number(s.default_rent_amount)} size="sm" />
          {s.default_rent_cycle && <span className="text-xs text-text-secondary">{rentCycleLabel(t, s.default_rent_cycle)}</span>}
        </span>
      ) : '—',
    },
    {
      key: 'status',
      header: t('common.status', { defaultValue: 'Status' }),
      render: (s) => <StatusBadge tone={SPACE_STATUS_TONE[s.status]} label={t(`rentals.spaces.statusLabels.${s.status}`)} />,
    },
    actionsColumn,
  ]

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {t('rentals.spaces.showArchived')}
        </label>
        {canManageSpaces && (
          <Button size="sm" onClick={() => setEditing('new')}><Plus />{t('rentals.spaces.add')}</Button>
        )}
      </div>

      {actionError && <p role="alert" className="text-sm text-status-danger">{actionError}</p>}

      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('rentals.spaces.loadError'))} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={spaces}
          rowKey={(s) => s.id}
          isLoading={isLoading}
          variant="cards-on-mobile"
          renderCardActions={(s, i, all) => actionsColumn.render(s, i, all)}
          emptyTitle={t('rentals.spaces.emptyTitle')}
          emptyDescription={t('rentals.spaces.emptyDescription')}
        />
      )}

      {editing && (
        <SpaceFormDialog
          space={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidate() }}
        />
      )}

      {rentSpaceId && (
        <NewContractDialog
          initialSpaceId={rentSpaceId}
          onClose={() => setRentSpaceId(null)}
          onCreated={() => { setRentSpaceId(null); invalidate() }}
        />
      )}
    </div>
  )
}

interface BranchRow { id: string; name: string }

function SpaceFormDialog({ space, onClose, onSaved }: { space: RentalSpaceRow | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const [name, setName] = useState(space?.name ?? '')
  const [spaceType, setSpaceType] = useState<string>(space?.space_type ?? 'gym')
  const [customLabel, setCustomLabel] = useState(space?.custom_type_label ?? '')
  const [branchId, setBranchId] = useState(space?.branch_id ?? '')
  const [description, setDescription] = useState(space?.description ?? '')
  const [area, setArea] = useState(space?.area_sqm != null ? String(space.area_sqm) : '')
  const [capacity, setCapacity] = useState(space?.capacity != null ? String(space.capacity) : '')
  const [defaultCycle, setDefaultCycle] = useState<string>(space?.default_rent_cycle ?? 'monthly')
  const [defaultAmount, setDefaultAmount] = useState(space?.default_rent_amount != null ? String(space.default_rent_amount) : '')
  const [allowOverlap, setAllowOverlap] = useState(space?.allow_overlapping_contracts ?? false)
  const [error, setError] = useState<string | null>(null)

  const { data: branches = [] } = useQuery({
    queryKey: ['rental-branches', currentClubId],
    queryFn: async () => {
      const { data, error: qError } = await supabase.from('branches').select('id, name').eq('club_id', currentClubId!).eq('status', 'active').order('name')
      if (qError) throw qError
      return (data ?? []) as BranchRow[]
    },
    enabled: !!currentClubId,
  })
  const resolvedBranchId = branchId || (branches.length === 1 ? (branches[0]?.id ?? '') : '')

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error(t('rentals.spaces.errors.nameRequired'))
      if (!resolvedBranchId) throw new Error(t('rentals.spaces.errors.branchRequired'))
      if (spaceType === 'custom' && !customLabel.trim()) throw new Error(t('rentals.spaces.errors.customTypeRequired'))
      const { data, error: rpcError } = await supabase.rpc('upsert_rental_space', {
        p_club_id: currentClubId!,
        p_space_id: space?.id ?? null,
        p_branch_id: resolvedBranchId,
        p_name: name.trim(),
        p_space_type: spaceType,
        p_custom_type_label: spaceType === 'custom' ? customLabel.trim() : undefined,
        p_description: description.trim() || undefined,
        p_area_sqm: area ? Number(area) : undefined,
        p_capacity: capacity ? Number(capacity) : undefined,
        p_default_rent_cycle: defaultAmount ? defaultCycle : undefined,
        p_default_rent_amount: defaultAmount ? Number(defaultAmount) : undefined,
        p_allow_overlapping_contracts: allowOverlap,
      })
      if (rpcError) throw rpcError
      return data
    },
    onSuccess: onSaved,
    onError: (err) => setError(translateSupabaseError(err, t('rentals.spaces.saveError'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Building className="size-5" />{space ? t('rentals.spaces.edit') : t('rentals.spaces.add')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field label={t('rentals.spaces.name')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('rentals.spaces.namePlaceholder')} maxLength={120} />
          </Field>

          <Field label={t('rentals.spaces.type')}>
            <Select value={spaceType} onValueChange={setSpaceType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RENTAL_SPACE_TYPES.map((type) => <SelectItem key={type} value={type}>{t(`rentals.spaceTypes.${type}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>

          {spaceType === 'custom' && (
            <Field label={t('rentals.spaces.customType')}>
              <Input value={customLabel} onChange={(e) => setCustomLabel(e.target.value)} placeholder={t('rentals.spaces.customTypePlaceholder')} maxLength={80} />
            </Field>
          )}

          {branches.length > 1 && (
            <Field label={t('rentals.branch')}>
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger><SelectValue placeholder={t('rentals.branch')} /></SelectTrigger>
                <SelectContent>
                  {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}

          <div className="flex gap-2">
            <Field label={t('rentals.spaces.area')} className="flex-1">
              <Input type="number" min={0} value={area} onChange={(e) => setArea(e.target.value)} />
            </Field>
            <Field label={t('rentals.spaces.capacity')} className="flex-1">
              <Input type="number" min={0} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            </Field>
          </div>

          <div className="flex gap-2">
            <Field label={t('rentals.spaces.defaultRent')} className="flex-1">
              <Input type="number" min={0} value={defaultAmount} onChange={(e) => setDefaultAmount(e.target.value)} />
            </Field>
            <Field label={t('rentals.contracts.cycle')} className="flex-1">
              <Select value={defaultCycle} onValueChange={setDefaultCycle}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RENT_CYCLES.filter((c) => c !== 'custom').map((c) => <SelectItem key={c} value={c}>{t(`rentals.cycles.${c}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label={t('rentals.spaces.descriptionLabel')}>
            <textarea
              className="min-h-16 rounded-md border border-border-subtle bg-transparent p-2 text-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </Field>

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={allowOverlap} onChange={(e) => setAllowOverlap(e.target.checked)} />
            <span>
              {t('rentals.spaces.allowOverlap')}
              <span className="block text-xs text-text-secondary">{t('rentals.spaces.allowOverlapHint')}</span>
            </span>
          </label>

          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}

          <Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? t('rentals.saving') : t('rentals.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
