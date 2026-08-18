import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
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
import { CustomerDetailDialog } from './CustomerDetailDialog'
import { translateSupabaseError } from '@/lib/errors'

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

  // Gate 11 (2026-08-16): outstanding balance is a shared KPI -- it must be
  // computed in exactly one place (Doc 3's single-source-of-truth rule).
  // This used to be reimplemented here via a manual invoices+payment_allocations
  // join that never accounted for refunds (a refund on an already-paid invoice
  // re-opens the debt), silently understating what customers actually owed.
  // OutstandingPage.tsx already reads the correct `outstanding_invoices` view,
  // which nets out completed refunds -- read the same view here instead of
  // recomputing the concept independently.
  const customerIds = (data ?? []).map((row) => row.id)
  const outstandingByCustomer = new Map<string, number>()
  if (customerIds.length > 0) {
    const { data: outstandingRows } = await supabase
      .from('outstanding_invoices')
      .select('customer_id, outstanding')
      .in('customer_id', customerIds)
    for (const row of outstandingRows ?? []) {
      if (!row.customer_id) continue
      const amount = Number(row.outstanding)
      if (amount > 0) {
        outstandingByCustomer.set(row.customer_id, (outstandingByCustomer.get(row.customer_id) ?? 0) + amount)
      }
    }
  }

  return (data ?? []).map<CustomerRow>((row) => ({
    id: row.id,
    fullName: row.full_name,
    mobileDisplay: row.mobile_display,
    email: row.email,
    whatsapp: row.whatsapp,
    outstanding: outstandingByCustomer.get(row.id) ?? 0,
  }))
}

function normalizeMobile(input: string): string {
  return input.replace(/\D/g, '').replace(/^0+/, '')
}

export function CustomersPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  // Master IA/UX audit (Reports decomposition phase): reports must not
  // be dead ends -- a "top spenders" list row now links here with
  // ?q=<name> so the customer is pre-searched instead of landing on an
  // empty list the manager has to re-search by hand.
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '')
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
  const [viewingCustomer, setViewingCustomer] = useState<CustomerRow | null>(null)

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
    onError: (error) =>
      setFormError(translateSupabaseError(error, editingCustomer ? t('customers.saveEditError') : t('customers.addError'))),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    saveMutation.mutate()
  }

  const columns: DataTableColumn<CustomerRow>[] = [
    {
      key: 'name',
      header: t('common.name'),
      render: (c) => (
        <button className="text-accent-foreground hover:underline" onClick={() => setViewingCustomer(c)}>
          {c.fullName}
        </button>
      ),
    },
    { key: 'mobile', header: t('common.phone'), render: (c) => c.mobileDisplay ?? '—' },
    { key: 'email', header: t('common.email'), render: (c) => c.email ?? '—' },
    {
      key: 'outstanding',
      header: t('customers.outstanding'),
      render: (c) => (c.outstanding && c.outstanding > 0 ? <span className="font-medium text-status-danger tabular-nums">{c.outstanding.toFixed(0)} {t('common.currency')}</span> : <span className="text-status-success">—</span>),
    },
    {
      key: 'actions',
      header: '',
      render: (c) => (
        <button className="text-xs text-text-secondary hover:text-accent-foreground hover:underline" onClick={() => openEditDialog(c)}>
          {t('common.edit')}
        </button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title={t('customers.page.title')}
        description={t('customers.page.description')}
        actions={
          <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingCustomer(null) }}>
            <DialogTrigger asChild>
              <Button onClick={openCreateDialog}>{t('customers.addCustomer')}</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingCustomer ? t('customers.editCustomer') : t('customers.addCustomer')}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">{t('customers.fullName')}</label>
                  <Input required value={fullName} onChange={(e) => setFullName(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">{t('common.phone')}</label>
                  <Input value={mobile} onChange={(e) => setMobile(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">{t('customers.emailOptional')}</label>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                {formError && (
                  <p role="alert" className="text-sm text-status-danger">
                    {formError}
                  </p>
                )}
                <Button type="submit" disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? t('common.saving') : editingCustomer ? t('customers.saveChanges') : t('common.add')}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="mb-4">
        <Input
          placeholder={t('customers.searchPlaceholder')}
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
        emptyTitle={t('customers.emptyTitle')}
        emptyDescription={t('customers.emptyDescription')}
      />

      <CustomerDetailDialog
        customerId={viewingCustomer?.id ?? null}
        customerName={viewingCustomer?.fullName ?? ''}
        onOpenChange={(open) => !open && setViewingCustomer(null)}
      />
    </div>
  )
}
