import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StatusBadge } from '@/components/ui/status-badge'
import { type FieldRow, type PricingRuleRow, type OperatingHoursRow } from '@/lib/domain/fields'
import { OperatingHoursEditor } from './OperatingHoursEditor'
import { PricingEditor } from './PricingEditor'
import { resolveHoursForDay, useResolvedFieldPrice } from '@/features/bookings/useFieldPricing'

// V1 Implementation Gap Audit (2026-08-16): field_operating_hours had
// full RLS CRUD in place since Phase 5 but no UI at all -- a manager had
// no way to configure a field's open/close hours through the product,
// and the booking engine never enforced them (fixed separately in
// migration 20260816020000_enforce_field_operating_hours.sql). Pricing
// was create-only (no edit/delete, no visibility into which rule wins on
// overlap). This file adds both: a real weekly hours editor and a
// pricing rules table with delete + an "effective now" indicator.
async function fetchFields(clubId: string) {
  const { data, error } = await supabase
    .from('fields')
    .select('id, name, sport, branch_id, status')
    .eq('club_id', clubId)
    .order('name')
  if (error) throw error
  return (data ?? []).map<FieldRow>((f) => ({
    id: f.id,
    name: f.name,
    sport: f.sport,
    branchId: f.branch_id,
    status: f.status,
  }))
}

async function fetchBranches(clubId: string) {
  const { data, error } = await supabase.from('branches').select('id, name').eq('club_id', clubId)
  if (error) throw error
  return data ?? []
}

async function fetchPricingRules(clubId: string, fieldId: string) {
  const { data, error } = await supabase
    .from('pricing_rules')
    .select('id, field_id, day_of_week, date_specific, start_time, end_time, price_per_hour, priority')
    .eq('club_id', clubId)
    .eq('field_id', fieldId)
    .order('date_specific', { ascending: true, nullsFirst: false })
    .order('day_of_week')
  if (error) throw error
  return (data ?? []).map<PricingRuleRow>((r) => ({
    id: r.id,
    fieldId: r.field_id,
    dayOfWeek: r.day_of_week,
    dateSpecific: r.date_specific,
    startTime: r.start_time,
    endTime: r.end_time,
    pricePerHour: Number(r.price_per_hour),
    priority: r.priority,
  }))
}

async function fetchAllOperatingHours(clubId: string) {
  const { data, error } = await supabase
    .from('field_operating_hours')
    .select('field_id, branch_id, day_of_week, open_time, close_time')
    .eq('club_id', clubId)
  if (error) throw error
  return data ?? []
}

async function fetchTodayBookingCounts(clubId: string) {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('bookings')
    .select('field_id, start_at, status')
    .eq('club_id', clubId)
    .gte('start_at', `${today}T00:00:00`)
    .lte('start_at', `${today}T23:59:59`)
    .neq('status', 'cancelled')
  if (error) throw error
  return data ?? []
}

async function fetchActiveBlocksNow(clubId: string) {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('field_blocks')
    .select('field_id, start_at, end_at')
    .eq('club_id', clubId)
    .lte('start_at', now)
    .gte('end_at', now)
  if (error) throw error
  return data ?? []
}

async function fetchOperatingHours(fieldId: string) {
  const { data, error } = await supabase
    .from('field_operating_hours')
    .select('id, field_id, branch_id, day_of_week, open_time, close_time')
    .eq('field_id', fieldId)
    .order('day_of_week')
  if (error) throw error
  return (data ?? []).map<OperatingHoursRow>((r) => ({
    id: r.id,
    fieldId: r.field_id,
    branchId: r.branch_id,
    dayOfWeek: r.day_of_week,
    openTime: r.open_time,
    closeTime: r.close_time,
  }))
}

function FieldCurrentPriceCell({ fieldId, date }: { fieldId: string; date: string }) {
  const { t } = useTranslation()
  const nowTime = new Date().toTimeString().slice(0, 5)
  const { data: price, isLoading } = useResolvedFieldPrice(fieldId, date, `${nowTime}:00`, `${nowTime}:00`)
  if (isLoading) return <span className="text-text-secondary">...</span>
  if (price == null) return <span className="text-status-danger">{t('clubs.fieldsManagement.noPrice')}</span>
  return <span className="font-medium tabular-nums">{t('clubs.fieldsManagement.pricePerHour', { price: price.toFixed(0) })}</span>
}

export function FieldsManagement() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [fieldName, setFieldName] = useState('')
  const [fieldSport, setFieldSport] = useState('football')
  const [fieldBranchId, setFieldBranchId] = useState('')
  const [manageField, setManageField] = useState<FieldRow | null>(null)
  const [manageTab, setManageTab] = useState<'details' | 'hours' | 'pricing'>('details')
  const [manageError, setManageError] = useState<string | null>(null)

  const { data: fields = [], isLoading } = useQuery({
    queryKey: ['fields', currentClubId],
    queryFn: () => fetchFields(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: branches = [] } = useQuery({
    queryKey: ['branches-for-fields', currentClubId],
    queryFn: () => fetchBranches(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: allHoursRows = [] } = useQuery({
    queryKey: ['field-operating-hours-all', currentClubId],
    queryFn: () => fetchAllOperatingHours(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: todayBookings = [] } = useQuery({
    queryKey: ['fields-today-bookings', currentClubId],
    queryFn: () => fetchTodayBookingCounts(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: activeBlocks = [] } = useQuery({
    queryKey: ['fields-active-blocks', currentClubId],
    queryFn: () => fetchActiveBlocksNow(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: pricingRules = [] } = useQuery({
    queryKey: ['pricing-rules', manageField?.id],
    queryFn: () => fetchPricingRules(currentClubId!, manageField!.id),
    enabled: !!manageField && !!currentClubId,
  })

  const { data: operatingHours = [] } = useQuery({
    queryKey: ['operating-hours', manageField?.id],
    queryFn: () => fetchOperatingHours(manageField!.id),
    enabled: !!manageField,
  })

  const createFieldMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('manage_field', {
        p_field_id: null,
        p_club_id: currentClubId as string,
        p_branch_id: fieldBranchId,
        p_name: fieldName,
        p_sport: fieldSport,
        p_status: 'active',
        p_reason: 'Field created',
      })
      if (error) throw error
    },
    onSuccess: () => {
      setCreateDialogOpen(false)
      setFieldName('')
      void queryClient.invalidateQueries({ queryKey: ['fields', currentClubId] })
    },
  })

  const updateFieldMutation = useMutation({
    mutationFn: async () => {
      if (!manageField) throw new Error('no field selected')
      const { error } = await supabase.rpc('manage_field', {
        p_field_id: manageField.id,
        p_club_id: currentClubId as string,
        p_branch_id: manageField.branchId,
        p_name: manageField.name,
        p_sport: manageField.sport,
        p_status: manageField.status,
        p_reason: manageField.status === 'inactive' ? 'Field deactivated' : 'Field master data updated',
      })
      if (error) throw error
    },
    onSuccess: () => {
      setManageError(null)
      void queryClient.invalidateQueries({ queryKey: ['fields', currentClubId] })
    },
    onError: (error) => setManageError(error instanceof Error ? error.message : String(error)),
  })

  function handleCreateField(e: FormEvent) {
    e.preventDefault()
    createFieldMutation.mutate()
  }

  const today = new Date().toISOString().slice(0, 10)
  const dayOfWeek = new Date().getDay()

  const fieldColumns: DataTableColumn<FieldRow>[] = [
    {
      key: 'name',
      header: t('clubs.fieldsManagement.columns.field'),
      render: (f) => (
        <button
          className="text-accent-foreground hover:underline"
          onClick={() => {
            setManageField(f)
            setManageTab('details')
          }}
        >
          {f.name}
        </button>
      ),
    },
    { key: 'sport', header: t('clubs.fieldsManagement.columns.sport'), render: (f) => f.sport },
    {
      key: 'hours',
      header: t('clubs.fieldsManagement.columns.hoursToday'),
      render: (f) => {
        const hours = resolveHoursForDay(allHoursRows, f.id, dayOfWeek)
        if (hours.isUnrestricted) return <span className="text-text-secondary">{t('clubs.fieldsManagement.openAllDay')}</span>
        if (hours.isClosed) return <span className="text-status-danger">{t('clubs.fieldsManagement.closedToday')}</span>
        return <span className="tabular-nums">{hours.openTime?.slice(0, 5)}–{hours.closeTime?.slice(0, 5)}</span>
      },
    },
    {
      key: 'price',
      header: t('clubs.fieldsManagement.columns.currentPrice'),
      render: (f) => <FieldCurrentPriceCell fieldId={f.id} date={today} />,
    },
    {
      key: 'today',
      header: t('clubs.fieldsManagement.columns.todayBookings'),
      render: (f) => <span className="tabular-nums">{todayBookings.filter((b) => b.field_id === f.id).length}</span>,
    },
    {
      key: 'blocked',
      header: t('clubs.fieldsManagement.columns.currentStatus'),
      render: (f) => {
        const isBlocked = activeBlocks.some((b) => b.field_id === f.id)
        if (isBlocked) return <StatusBadge tone="danger" label={t('clubs.fieldsManagement.temporarilyClosed')} />
        if (f.status !== 'active') return <StatusBadge tone="neutral" label={t('clubs.fieldsManagement.inactive')} />
        return <StatusBadge tone="success" label={t('clubs.fieldsManagement.available')} />
      },
    },
  ]

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t('clubs.fieldsManagement.cardTitle')}</CardTitle>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">{t('clubs.fieldsManagement.addField')}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('clubs.fieldsManagement.addFieldTitle')}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreateField} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('clubs.fieldsManagement.nameLabel')}</label>
                <Input required value={fieldName} onChange={(e) => setFieldName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('clubs.fieldsManagement.sportLabel')}</label>
                <Input required value={fieldSport} onChange={(e) => setFieldSport(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('clubs.fieldsManagement.branchLabel')}</label>
                <Select value={fieldBranchId} onValueChange={setFieldBranchId}>
                  <SelectTrigger><SelectValue placeholder={t('clubs.fieldsManagement.chooseBranch')} /></SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={createFieldMutation.isPending || !fieldBranchId}>
                {createFieldMutation.isPending ? t('clubs.fieldsManagement.adding') : t('clubs.fieldsManagement.add')}
              </Button>
              <p className="text-xs text-text-secondary">
                {t('clubs.fieldsManagement.addFieldHint')}
              </p>
            </form>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={fieldColumns}
          rows={fields}
          rowKey={(f) => f.id}
          isLoading={isLoading}
          emptyTitle={t('clubs.fieldsManagement.emptyTitle')}
          emptyDescription={t('clubs.fieldsManagement.emptyDescription')}
        />
      </CardContent>

      <Dialog open={!!manageField} onOpenChange={(open) => !open && setManageField(null)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('clubs.fieldsManagement.manageDialogTitle', { name: manageField?.name })}</DialogTitle>
          </DialogHeader>

          <div className="flex gap-1 border-b border-border">
            <button
              className={`px-3 py-2 text-sm font-medium ${manageTab === 'details' ? 'border-b-2 border-accent text-text-primary' : 'text-text-secondary'}`}
              onClick={() => setManageTab('details')}
            >
              {t('clubs.fieldsManagement.tabDetails')}
            </button>
            <button
              className={`px-3 py-2 text-sm font-medium ${manageTab === 'hours' ? 'border-b-2 border-accent text-text-primary' : 'text-text-secondary'}`}
              onClick={() => setManageTab('hours')}
            >
              {t('clubs.fieldsManagement.tabHours')}
            </button>
            <button
              className={`px-3 py-2 text-sm font-medium ${manageTab === 'pricing' ? 'border-b-2 border-accent text-text-primary' : 'text-text-secondary'}`}
              onClick={() => setManageTab('pricing')}
            >
              {t('clubs.fieldsManagement.tabPricing')}
            </button>
          </div>

          {manageTab === 'details' && manageField && (
            <div className="flex flex-col gap-3 pt-2">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('clubs.fieldsManagement.nameLabel')}</label>
                <Input value={manageField.name} onChange={(e) => setManageField({ ...manageField, name: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('clubs.fieldsManagement.sportLabel')}</label>
                <Input value={manageField.sport} onChange={(e) => setManageField({ ...manageField, sport: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('clubs.fieldsManagement.statusLabel')}</label>
                <Select value={manageField.status} onValueChange={(value) => setManageField({ ...manageField, status: value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">{t('clubs.fieldsManagement.available')}</SelectItem>
                    <SelectItem value="maintenance">{t('clubs.fieldsManagement.maintenance')}</SelectItem>
                    <SelectItem value="inactive">{t('clubs.fieldsManagement.inactive')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-text-secondary">{t('clubs.fieldsManagement.branchImmutableHint')}</p>
              {manageError && <p role="alert" className="text-sm text-status-danger">{manageError}</p>}
              <Button disabled={!manageField.name.trim() || !manageField.sport.trim() || updateFieldMutation.isPending} onClick={() => updateFieldMutation.mutate()}>
                {updateFieldMutation.isPending ? t('clubs.branchesCard.saving') : t('clubs.branchesCard.save')}
              </Button>
            </div>
          )}

          {manageTab === 'hours' && manageField && (
            <div className="pt-2">
              <OperatingHoursEditor
                fieldId={manageField.id}
                branchId={manageField.branchId}
                clubId={currentClubId!}
                hasAnyConfigured={operatingHours.length > 0}
                operatingHours={operatingHours}
              />
            </div>
          )}

          {manageTab === 'pricing' && manageField && (
            <div className="pt-2">
              <PricingEditor fieldId={manageField.id} pricingRules={pricingRules} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
