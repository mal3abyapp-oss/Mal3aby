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
import { DAY_NAMES_AR, type FieldRow, type PricingRuleRow } from '@/lib/domain/fields'

// Phase 5 frontend deliverable: field management, hours editor (kept
// minimal), blocks (kept minimal), pricing rule editor — mounted into
// ClubPage since no dedicated /app/fields route exists in SCREEN_MAP.md
// (fields/hours/pricing appear only as a permission-table route group,
// not a top-level route).
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

export function FieldsManagement() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [fieldName, setFieldName] = useState('')
  const [fieldSport, setFieldSport] = useState('football')
  const [fieldBranchId, setFieldBranchId] = useState('')
  const [selectedField, setSelectedField] = useState<FieldRow | null>(null)
  const [ruleDayOfWeek, setRuleDayOfWeek] = useState('0')
  const [ruleStart, setRuleStart] = useState('00:00')
  const [ruleEnd, setRuleEnd] = useState('23:59')
  const [rulePrice, setRulePrice] = useState('')

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
    queryKey: ['pricing-rules', selectedField?.id],
    queryFn: () => fetchPricingRules(currentClubId!, selectedField!.id),
    enabled: !!selectedField && !!currentClubId,
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
      if (!selectedField) throw new Error('no field selected')
      const { error } = await supabase.from('pricing_rules').insert({
        club_id: currentClubId as string,
        field_id: selectedField.id,
        day_of_week: Number(ruleDayOfWeek),
        start_time: ruleStart,
        end_time: ruleEnd,
        price_per_hour: Number(rulePrice),
        priority: 1,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setRulePrice('')
      void queryClient.invalidateQueries({ queryKey: ['pricing-rules', selectedField?.id] })
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
        <button className="text-accent-foreground hover:underline" onClick={() => setSelectedField(f)}>
          {f.name}
        </button>
      ),
    },
    { key: 'sport', header: 'الرياضة', render: (f) => f.sport },
    { key: 'status', header: 'الحالة', render: (f) => (f.status === 'active' ? 'نشط' : f.status) },
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

      <Dialog open={!!selectedField} onOpenChange={(open) => !open && setSelectedField(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>قواعد تسعير {selectedField?.name}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {pricingRules.length === 0 ? (
              <p className="text-sm text-text-secondary">لا توجد قواعد تسعير بعد.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {pricingRules.map((r) => (
                  <li key={r.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                    <span>
                      {r.dateSpecific ?? (r.dayOfWeek !== null ? DAY_NAMES_AR[r.dayOfWeek] : '—')} {r.startTime}–{r.endTime}
                    </span>
                    <span className="font-medium">{r.pricePerHour} EGP/ساعة</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <label className="text-sm font-medium text-text-secondary">إضافة قاعدة تسعير</label>
              <Select value={ruleDayOfWeek} onValueChange={setRuleDayOfWeek}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DAY_NAMES_AR.map((name, i) => (
                    <SelectItem key={i} value={String(i)}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2">
                <Input type="time" value={ruleStart} onChange={(e) => setRuleStart(e.target.value)} />
                <Input type="time" value={ruleEnd} onChange={(e) => setRuleEnd(e.target.value)} />
              </div>
              <Input
                type="number"
                placeholder="السعر بالساعة"
                value={rulePrice}
                onChange={(e) => setRulePrice(e.target.value)}
              />
              <Button size="sm" disabled={!rulePrice || addPricingRuleMutation.isPending} onClick={() => addPricingRuleMutation.mutate()}>
                إضافة
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
