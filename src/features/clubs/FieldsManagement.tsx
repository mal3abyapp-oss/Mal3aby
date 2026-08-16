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
import { type FieldRow, type PricingRuleRow, type OperatingHoursRow } from '@/lib/domain/fields'
import { OperatingHoursEditor } from './OperatingHoursEditor'
import { PricingEditor } from './PricingEditor'

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

export function FieldsManagement() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [fieldName, setFieldName] = useState('')
  const [fieldSport, setFieldSport] = useState('football')
  const [fieldBranchId, setFieldBranchId] = useState('')
  const [manageField, setManageField] = useState<FieldRow | null>(null)
  const [manageTab, setManageTab] = useState<'hours' | 'pricing'>('hours')

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
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
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
              <PricingEditor fieldId={manageField.id} clubId={currentClubId!} pricingRules={pricingRules} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
