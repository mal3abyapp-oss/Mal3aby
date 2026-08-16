import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
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
import type { CustomerRow } from '@/lib/domain/people'

// Phase 4: search, create, edit customers. Guardian linking (from the
// player side) lives in AcademyPage's Player Profile per SCREEN_MAP.md
// (Player Profile route = academy, not customers).
async function fetchCustomers(clubId: string, search: string) {
  let query = supabase
    .from('customers')
    .select('id, full_name, mobile_display, email, whatsapp')
    .eq('club_id', clubId)
    .order('full_name')
    .limit(50)

  if (search.trim()) {
    query = query.or(`full_name.ilike.%${search}%,mobile_display.ilike.%${search}%`)
  }

  const { data, error } = await query
  if (error) throw error

  return (data ?? []).map<CustomerRow>((row) => ({
    id: row.id,
    fullName: row.full_name,
    mobileDisplay: row.mobile_display,
    email: row.email,
    whatsapp: row.whatsapp,
  }))
}

function normalizeMobile(input: string): string {
  return input.replace(/\D/g, '').replace(/^0+/, '')
}

export function CustomersPage() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [fullName, setFullName] = useState('')
  const [mobile, setMobile] = useState('')
  const [email, setEmail] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  // V1 Implementation Gap Audit (2026-08-16): this file's own original
  // comment said "Phase 4: search, create, edit customers" but edit was
  // never actually built -- a typo in a customer's name/phone had no
  // correction path through the product. editingCustomer !== null reuses
  // the same dialog/form as create, pre-filled, submitting an update
  // instead of an insert.
  const [editingCustomer, setEditingCustomer] = useState<CustomerRow | null>(null)

  const { data: customers = [], isLoading } = useQuery({
    queryKey: ['customers', currentClubId, search],
    queryFn: () => fetchCustomers(currentClubId!, search),
    enabled: !!currentClubId,
  })

  function openCreateDialog() {
    setEditingCustomer(null)
    setFullName('')
    setMobile('')
    setEmail('')
    setFormError(null)
    setDialogOpen(true)
  }

  function openEditDialog(c: CustomerRow) {
    setEditingCustomer(c)
    setFullName(c.fullName)
    setMobile(c.mobileDisplay ?? '')
    setEmail(c.email ?? '')
    setFormError(null)
    setDialogOpen(true)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        full_name: fullName,
        mobile_display: mobile || null,
        normalized_mobile: mobile ? normalizeMobile(mobile) : null,
        email: email || null,
      }
      if (editingCustomer) {
        const { error } = await supabase.from('customers').update(payload).eq('id', editingCustomer.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('customers').insert({ club_id: currentClubId as string, ...payload })
        if (error) throw error
      }
    },
    onSuccess: () => {
      setDialogOpen(false)
      setEditingCustomer(null)
      setFullName('')
      setMobile('')
      setEmail('')
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['customers', currentClubId] })
    },
    onError: () => setFormError(editingCustomer ? 'تعذّر حفظ التعديلات، حاول مرة أخرى.' : 'تعذّرت الإضافة، حاول مرة أخرى.'),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    saveMutation.mutate()
  }

  const columns: DataTableColumn<CustomerRow>[] = [
    {
      key: 'name',
      header: 'الاسم',
      render: (c) => (
        <button className="text-accent-foreground hover:underline" onClick={() => openEditDialog(c)}>
          {c.fullName}
        </button>
      ),
    },
    { key: 'mobile', header: 'الهاتف', render: (c) => c.mobileDisplay ?? '—' },
    { key: 'email', header: 'البريد الإلكتروني', render: (c) => c.email ?? '—' },
  ]

  return (
    <div>
      <PageHeader
        title="العملاء"
        description="البحث عن العملاء وإضافتهم"
        actions={
          <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingCustomer(null) }}>
            <DialogTrigger asChild>
              <Button onClick={openCreateDialog}>إضافة عميل</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingCustomer ? 'تعديل بيانات العميل' : 'إضافة عميل'}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">الاسم الكامل</label>
                  <Input required value={fullName} onChange={(e) => setFullName(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">رقم الهاتف</label>
                  <Input value={mobile} onChange={(e) => setMobile(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">البريد الإلكتروني (اختياري)</label>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                {formError && (
                  <p role="alert" className="text-sm text-status-danger">
                    {formError}
                  </p>
                )}
                <Button type="submit" disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? 'جارٍ الحفظ...' : editingCustomer ? 'حفظ التعديلات' : 'إضافة'}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="mb-4">
        <Input
          placeholder="بحث بالاسم أو رقم الهاتف"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
      </div>

      <DataTable
        columns={columns}
        rows={customers}
        rowKey={(c) => c.id}
        isLoading={isLoading}
        emptyTitle="لا يوجد عملاء"
        emptyDescription="أضف أول عميل لبدء إدارة قاعدة عملاء النادي"
      />
    </div>
  )
}
