import { useState, type FormEvent } from 'react'
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
import { DAY_NAMES_AR, type FieldRow, type PricingRuleRow, type OperatingHoursRow } from '@/lib/domain/fields'

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

// A rule is "effective now" if today's weekday/date matches it and the
// current time falls in its window -- shown so a manager isn't left
// guessing which of several overlapping rules actually governs the
// current price, matching the audit's "explain which rule is effective"
// requirement.
function isEffectiveNow(rule: PricingRuleRow): boolean {
  const now = new Date()
  const nowTime = now.toTimeString().slice(0, 5)
  const today = now.toISOString().slice(0, 10)
  const dayMatches = rule.dateSpecific ? rule.dateSpecific === today : rule.dayOfWeek === now.getDay()
  return dayMatches && rule.startTime <= nowTime && rule.endTime >= nowTime
}

export function FieldsManagement() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [fieldName, setFieldName] = useState('')
  const [fieldSport, setFieldSport] = useState('football')
  const [fieldBranchId, setFieldBranchId] = useState('')
  const [manageField, setManageField] = useState<FieldRow | null>(null)
  const [manageTab, setManageTab] = useState<'hours' | 'pricing'>('hours')

  const [ruleDayOfWeek, setRuleDayOfWeek] = useState('0')
  const [ruleDateSpecific, setRuleDateSpecific] = useState('')
  const [ruleStart, setRuleStart] = useState('00:00')
  const [ruleEnd, setRuleEnd] = useState('23:59')
  const [rulePrice, setRulePrice] = useState('')
  const [rulePriority, setRulePriority] = useState('1')

  const [hoursDayOfWeek, setHoursDayOfWeek] = useState('0')
  const [hoursOpen, setHoursOpen] = useState('08:00')
  const [hoursClose, setHoursClose] = useState('23:00')

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
      const { error } = await supabase.from('fields').insert({
        club_id: currentClubId as string,
        branch_id: fieldBranchId,
        name: fieldName,
        sport: fieldSport,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setCreateDialogOpen(false)
      setFieldName('')
      void queryClient.invalidateQueries({ queryKey: ['fields', currentClubId] })
    },
  })

  const addPricingRuleMutation = useMutation({
    mutationFn: async () => {
      if (!manageField) throw new Error('no field selected')
      const { error } = await supabase.from('pricing_rules').insert({
        club_id: currentClubId as string,
        field_id: manageField.id,
        day_of_week: ruleDateSpecific ? null : Number(ruleDayOfWeek),
        date_specific: ruleDateSpecific || null,
        start_time: ruleStart,
        end_time: ruleEnd,
        price_per_hour: Number(rulePrice),
        priority: Number(rulePriority) || 1,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setRulePrice('')
      setRuleDateSpecific('')
      void queryClient.invalidateQueries({ queryKey: ['pricing-rules', manageField?.id] })
    },
  })

  const deletePricingRuleMutation = useMutation({
    mutationFn: async (ruleId: string) => {
      const { error } = await supabase.from('pricing_rules').delete().eq('id', ruleId)
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pricing-rules', manageField?.id] })
    },
  })

  const upsertHoursMutation = useMutation({
    mutationFn: async () => {
      if (!manageField) throw new Error('no field selected')
      const existing = operatingHours.find((h) => h.dayOfWeek === Number(hoursDayOfWeek))
      if (existing) {
        const { error } = await supabase
          .from('field_operating_hours')
          .update({ open_time: hoursOpen, close_time: hoursClose })
          .eq('id', existing.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('field_operating_hours').insert({
          club_id: currentClubId as string,
          branch_id: manageField.branchId,
          field_id: manageField.id,
          day_of_week: Number(hoursDayOfWeek),
          open_time: hoursOpen,
          close_time: hoursClose,
        })
        if (error) throw error
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['operating-hours', manageField?.id] })
    },
  })

  const removeHoursMutation = useMutation({
    mutationFn: async (hoursId: string) => {
      const { error } = await supabase.from('field_operating_hours').delete().eq('id', hoursId)
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['operating-hours', manageField?.id] })
    },
  })

  function handleCreateField(e: FormEvent) {
    e.preventDefault()
    createFieldMutation.mutate()
  }

  const fieldColumns: DataTableColumn<FieldRow>[] = [
    {
      key: 'name',
      header: 'الملعب',
      render: (f) => (
        <button
          className="text-accent-foreground hover:underline"
          onClick={() => {
            setManageField(f)
            setManageTab('hours')
          }}
        >
          {f.name}
        </button>
      ),
    },
    { key: 'sport', header: 'الرياضة', render: (f) => f.sport },
    { key: 'status', header: 'الحالة', render: (f) => (f.status === 'active' ? 'نشط' : f.status) },
    {
      key: 'config',
      header: 'الإعداد',
      render: (f) =>
        f.id === manageField?.id ? null : (
          <span className="text-xs text-text-secondary">اضغط على الاسم لإدارة المواعيد والأسعار</span>
        ),
    },
  ]

  const configuredDays = new Set(operatingHours.map((h) => h.dayOfWeek))

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">الملاعب والتسعير</CardTitle>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">إضافة ملعب</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>إضافة ملعب</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreateField} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">الاسم</label>
                <Input required value={fieldName} onChange={(e) => setFieldName(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">الرياضة</label>
                <Input required value={fieldSport} onChange={(e) => setFieldSport(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">الفرع</label>
                <Select value={fieldBranchId} onValueChange={setFieldBranchId}>
                  <SelectTrigger><SelectValue placeholder="اختر فرعًا" /></SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={createFieldMutation.isPending || !fieldBranchId}>
                {createFieldMutation.isPending ? 'جارٍ الإضافة...' : 'إضافة'}
              </Button>
              <p className="text-xs text-text-secondary">
                بعد الإضافة، افتح الملعب لإعداد مواعيد العمل والأسعار قبل أن يصبح قابلاً للحجز فعليًا.
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
          emptyTitle="لا توجد ملاعب"
          emptyDescription="أضف أول ملعب لبدء إدارة الحجوزات"
        />
      </CardContent>

      <Dialog open={!!manageField} onOpenChange={(open) => !open && setManageField(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>إعداد {manageField?.name}</DialogTitle>
          </DialogHeader>

          <div className="flex gap-1 border-b border-border">
            <button
              className={`px-3 py-2 text-sm font-medium ${manageTab === 'hours' ? 'border-b-2 border-accent text-text-primary' : 'text-text-secondary'}`}
              onClick={() => setManageTab('hours')}
            >
              مواعيد العمل
            </button>
            <button
              className={`px-3 py-2 text-sm font-medium ${manageTab === 'pricing' ? 'border-b-2 border-accent text-text-primary' : 'text-text-secondary'}`}
              onClick={() => setManageTab('pricing')}
            >
              الأسعار
            </button>
          </div>

          {manageTab === 'hours' && (
            <div className="flex flex-col gap-4 pt-2">
              {operatingHours.length === 0 ? (
                <p className="text-sm text-status-warning">
                  لم يتم تحديد مواعيد عمل بعد — الملعب متاح للحجز على مدار اليوم بدون قيود. حدد المواعيد أدناه لتقييد الحجز بساعات العمل الفعلية.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {DAY_NAMES_AR.map((name, i) => {
                    const row = operatingHours.find((h) => h.dayOfWeek === i)
                    return (
                      <li key={i} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                        <span>{name}</span>
                        {row ? (
                          <div className="flex items-center gap-2">
                            <span className="font-medium tabular-nums">{row.openTime}–{row.closeTime}</span>
                            <button
                              className="text-status-danger hover:underline"
                              onClick={() => removeHoursMutation.mutate(row.id)}
                              disabled={removeHoursMutation.isPending}
                            >
                              إزالة
                            </button>
                          </div>
                        ) : (
                          <span className="text-text-secondary">
                            {configuredDays.size > 0 ? 'مغلق' : 'بدون قيد'}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              <div className="flex flex-col gap-2 border-t border-border pt-4">
                <label className="text-sm font-medium text-text-secondary">تحديد/تعديل موعد يوم</label>
                <Select value={hoursDayOfWeek} onValueChange={setHoursDayOfWeek}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DAY_NAMES_AR.map((name, i) => (
                      <SelectItem key={i} value={String(i)}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex gap-2">
                  <div className="flex flex-1 flex-col gap-1">
                    <label className="text-xs text-text-secondary">وقت الفتح</label>
                    <Input type="time" value={hoursOpen} onChange={(e) => setHoursOpen(e.target.value)} />
                  </div>
                  <div className="flex flex-1 flex-col gap-1">
                    <label className="text-xs text-text-secondary">وقت الإغلاق</label>
                    <Input type="time" value={hoursClose} onChange={(e) => setHoursClose(e.target.value)} />
                  </div>
                </div>
                <Button
                  size="sm"
                  disabled={upsertHoursMutation.isPending || hoursOpen >= hoursClose}
                  onClick={() => upsertHoursMutation.mutate()}
                >
                  {upsertHoursMutation.isPending ? 'جارٍ الحفظ...' : 'حفظ الموعد'}
                </Button>
                {hoursOpen >= hoursClose && (
                  <p role="alert" className="text-xs text-status-danger">وقت الفتح يجب أن يكون قبل وقت الإغلاق</p>
                )}
              </div>
            </div>
          )}

          {manageTab === 'pricing' && (
            <div className="flex flex-col gap-4 pt-2">
              {pricingRules.length === 0 ? (
                <p className="text-sm text-status-warning">
                  لا توجد قواعد تسعير — لن يمكن إتمام أي حجز على هذا الملعب حتى تتم إضافة سعر واحد على الأقل.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {pricingRules.map((r) => (
                    <li key={r.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                      <div className="flex flex-col">
                        <span>
                          {r.dateSpecific ?? (r.dayOfWeek !== null ? DAY_NAMES_AR[r.dayOfWeek] : '—')} {r.startTime}–{r.endTime}
                          {r.dateSpecific && <span className="ms-1 text-xs text-status-warning">(تاريخ محدد)</span>}
                        </span>
                        <span className="text-xs text-text-secondary">أولوية {r.priority}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {isEffectiveNow(r) && (
                          <span className="rounded-full bg-status-success/10 px-2 py-0.5 text-xs font-medium text-status-success">
                            سارٍ الآن
                          </span>
                        )}
                        <span className="font-medium tabular-nums">{r.pricePerHour} EGP/ساعة</span>
                        <button
                          className="text-status-danger hover:underline"
                          onClick={() => deletePricingRuleMutation.mutate(r.id)}
                          disabled={deletePricingRuleMutation.isPending}
                        >
                          حذف
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex flex-col gap-2 border-t border-border pt-4">
                <label className="text-sm font-medium text-text-secondary">إضافة قاعدة تسعير</label>
                <Select value={ruleDayOfWeek} onValueChange={setRuleDayOfWeek} disabled={!!ruleDateSpecific}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DAY_NAMES_AR.map((name, i) => (
                      <SelectItem key={i} value={String(i)}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-text-secondary">أو تاريخ محدد (مناسبة/عطلة) — يتجاوز يوم الأسبوع أعلاه</label>
                  <Input type="date" value={ruleDateSpecific} onChange={(e) => setRuleDateSpecific(e.target.value)} />
                </div>
                <div className="flex gap-2">
                  <Input type="time" value={ruleStart} onChange={(e) => setRuleStart(e.target.value)} />
                  <Input type="time" value={ruleEnd} onChange={(e) => setRuleEnd(e.target.value)} />
                </div>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="السعر بالساعة"
                  value={rulePrice}
                  onChange={(e) => setRulePrice(e.target.value)}
                />
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-text-secondary">الأولوية (رقم أعلى = يفوز عند التداخل)</label>
                  <Input type="number" min="1" value={rulePriority} onChange={(e) => setRulePriority(e.target.value)} />
                </div>
                <Button
                  size="sm"
                  disabled={!rulePrice || Number(rulePrice) <= 0 || ruleStart >= ruleEnd || addPricingRuleMutation.isPending}
                  onClick={() => addPricingRuleMutation.mutate()}
                >
                  {addPricingRuleMutation.isPending ? 'جارٍ الإضافة...' : 'إضافة'}
                </Button>
                {ruleStart >= ruleEnd && (
                  <p role="alert" className="text-xs text-status-danger">وقت البداية يجب أن يكون قبل وقت النهاية</p>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
