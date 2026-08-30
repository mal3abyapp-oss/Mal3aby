import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { StatCard } from '@/components/ui/stat-card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatMoney } from '@/lib/domain/billing'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'
import { Receipt, Plus, Tags, Printer } from 'lucide-react'
import { ExpenseVoucherDialog, type ExpenseVoucherData } from './ExpenseVoucherDialog'

// EXPENSES FEATURE (2026-08-30): replaces the old permanent stub
// (see git history for FinanceExpensesPage.tsx's prior "not built yet"
// state, and 20260830010000_expenses_feature.sql for the full backend
// this now wires to). Follows CashShiftPage.tsx's own established
// shape exactly (record form -> filters -> DataTable -> row actions),
// since Expenses is the same class of screen: a real money-tracking
// ledger with a write flow and a filterable history, not a passive
// report.
type PaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'wallet' | 'other'
const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'card', 'bank_transfer', 'wallet', 'other']

interface BranchRow { id: string; name: string }
interface CategoryRow { id: string; nameAr: string; nameEn: string | null; status: string }
interface ExpenseRow {
  id: string
  branchId: string
  branchName: string
  categoryId: string | null
  categoryName: string
  amount: number
  paymentMethod: PaymentMethod
  description: string
  reference: string | null
  paidTo: string | null
  expenseDate: string
  status: 'recorded' | 'voided'
  voidReason: string | null
  recordedByName: string | null
  voidedByName: string | null
  voidedAt: string | null
  cashShiftReference: string | null
}

async function fetchBranches(clubId: string): Promise<BranchRow[]> {
  const { data, error } = await supabase.from('branches').select('id, name').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

async function fetchCategories(clubId: string, includeArchived: boolean): Promise<CategoryRow[]> {
  const { data, error } = await supabase.rpc('list_expense_categories', { p_club_id: clubId, p_include_archived: includeArchived })
  if (error) throw error
  return (data ?? []).map((r) => ({ id: r.id, nameAr: r.name_ar, nameEn: r.name_en, status: r.status }))
}

async function fetchExpenses(clubId: string, startDate: string, endDate: string): Promise<ExpenseRow[]> {
  const { data, error } = await supabase.rpc('list_expenses', { p_club_id: clubId, p_start_date: startDate, p_end_date: endDate })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    branchId: r.branch_id,
    branchName: r.branch_name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    amount: Number(r.amount),
    paymentMethod: r.payment_method as PaymentMethod,
    description: r.description,
    reference: r.reference,
    paidTo: r.paid_to,
    expenseDate: r.expense_date,
    status: r.status as 'recorded' | 'voided',
    voidReason: r.void_reason,
    recordedByName: r.recorded_by_name,
    voidedByName: r.voided_by_name,
    voidedAt: r.voided_at,
    cashShiftReference: r.cash_shift_reference,
  }))
}

async function fetchExpenseReport(clubId: string, startDate: string, endDate: string) {
  const { data, error } = await supabase.rpc('get_expense_report', { p_club_id: clubId, p_start_date: startDate, p_end_date: endDate })
  if (error) throw error
  return data as unknown as { total_expenses: number; expense_count: number }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}
function thirtyDaysAgoIso() {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().slice(0, 10)
}

export function FinanceExpensesPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { locale } = useDirection()
  const queryClient = useQueryClient()

  const [startDate, setStartDate] = useState(thirtyDaysAgoIso())
  const [endDate, setEndDate] = useState(todayIso())
  const [branchFilter, setBranchFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'recorded' | 'voided' | ''>('recorded')

  const [showForm, setShowForm] = useState(false)
  const [formBranchId, setFormBranchId] = useState('')
  const [formCategoryId, setFormCategoryId] = useState('')
  const [formAmount, setFormAmount] = useState('')
  const [formMethod, setFormMethod] = useState<PaymentMethod>('cash')
  const [formDescription, setFormDescription] = useState('')
  const [formPaidTo, setFormPaidTo] = useState('')
  const [formReference, setFormReference] = useState('')
  const [formDate, setFormDate] = useState(todayIso())
  const [formError, setFormError] = useState<string | null>(null)

  const [showCategoryForm, setShowCategoryForm] = useState(false)
  const [newCategoryAr, setNewCategoryAr] = useState('')
  const [newCategoryEn, setNewCategoryEn] = useState('')
  const [categoryError, setCategoryError] = useState<string | null>(null)

  const [voidingId, setVoidingId] = useState<string | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [voucherExpenseId, setVoucherExpenseId] = useState<string | null>(null)

  const { data: branches = [] } = useQuery({
    queryKey: ['branches-for-expenses', currentClubId],
    queryFn: () => fetchBranches(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: categories = [] } = useQuery({
    queryKey: ['expense-categories', currentClubId],
    queryFn: () => fetchCategories(currentClubId!, false),
    enabled: !!currentClubId,
  })

  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ['expenses', currentClubId, startDate, endDate],
    queryFn: () => fetchExpenses(currentClubId!, startDate, endDate),
    enabled: !!currentClubId,
  })

  const { data: report } = useQuery({
    queryKey: ['expense-report', currentClubId, startDate, endDate],
    queryFn: () => fetchExpenseReport(currentClubId!, startDate, endDate),
    enabled: !!currentClubId,
  })

  const recordMutation = useMutation({
    mutationFn: async () => {
      const amount = Number(formAmount)
      if (!formBranchId) throw new Error(t('finance.expenses.errors.selectBranch'))
      if (!Number.isFinite(amount) || amount <= 0) throw new Error(t('finance.expenses.errors.invalidAmount'))
      if (!formDescription.trim()) throw new Error(t('finance.expenses.errors.descriptionRequired'))
      const { error } = await supabase.rpc('record_expense', {
        p_club_id: currentClubId!,
        p_branch_id: formBranchId,
        p_amount: amount,
        p_payment_method: formMethod,
        p_description: formDescription.trim(),
        p_category_id: formCategoryId || undefined,
        p_reference: formReference.trim() || undefined,
        p_paid_to: formPaidTo.trim() || undefined,
        p_expense_date: formDate,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setFormAmount(''); setFormDescription(''); setFormPaidTo(''); setFormReference('')
      setFormCategoryId(''); setShowForm(false); setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['expenses', currentClubId] })
      void queryClient.invalidateQueries({ queryKey: ['expense-report', currentClubId] })
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, t('finance.expenses.errors.genericError'))),
  })

  const createCategoryMutation = useMutation({
    mutationFn: async () => {
      if (!newCategoryAr.trim()) throw new Error(t('finance.expenses.errors.categoryNameRequired'))
      const { error } = await supabase.rpc('create_expense_category', {
        p_club_id: currentClubId!,
        p_name_ar: newCategoryAr.trim(),
        p_name_en: newCategoryEn.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setNewCategoryAr(''); setNewCategoryEn(''); setShowCategoryForm(false); setCategoryError(null)
      void queryClient.invalidateQueries({ queryKey: ['expense-categories', currentClubId] })
    },
    onError: (err) => setCategoryError(err instanceof Error ? err.message : translateSupabaseError(err, t('finance.expenses.errors.genericError'))),
  })

  const voidMutation = useMutation({
    mutationFn: async () => {
      if (!voidingId) return
      if (!voidReason.trim()) throw new Error(t('finance.expenses.errors.voidReasonRequired'))
      const { error } = await supabase.rpc('void_expense', { p_expense_id: voidingId, p_reason: voidReason.trim() })
      if (error) throw error
    },
    onSuccess: () => {
      setVoidingId(null); setVoidReason(''); setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['expenses', currentClubId] })
      void queryClient.invalidateQueries({ queryKey: ['expense-report', currentClubId] })
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, t('finance.expenses.errors.genericError'))),
  })

  const filteredExpenses = expenses.filter((e) =>
    (!branchFilter || e.branchId === branchFilter)
    && (!categoryFilter || e.categoryId === categoryFilter)
    && (!statusFilter || e.status === statusFilter),
  )

  const columns: DataTableColumn<ExpenseRow>[] = [
    { key: 'date', header: t('finance.expenses.columns.date'), render: (e) => new Date(e.expenseDate).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
    { key: 'description', header: t('finance.expenses.columns.description'), render: (e) => e.description },
    { key: 'category', header: t('finance.expenses.columns.category'), render: (e) => e.categoryName || t('finance.expenses.uncategorized') },
    { key: 'branch', header: t('finance.expenses.columns.branch'), render: (e) => e.branchName },
    { key: 'paidTo', header: t('finance.expenses.columns.paidTo'), render: (e) => e.paidTo || '—' },
    { key: 'method', header: t('finance.expenses.columns.method'), render: (e) => t(`billing.paymentMethods.underlyingMethodLabels.${e.paymentMethod}`) },
    { key: 'amount', header: t('finance.expenses.columns.amount'), render: (e) => <span className="tabular-nums">{formatMoney(e.amount, 'EGP', locale)}</span> },
    {
      key: 'status',
      header: t('finance.expenses.columns.status'),
      render: (e) => e.status === 'voided'
        ? <StatusBadge tone="neutral" label={t('finance.expenses.statusVoided')} />
        : <StatusBadge tone="success" label={t('finance.expenses.statusRecorded')} />,
    },
    {
      key: 'actions',
      header: '',
      render: (e) => (
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setVoucherExpenseId(e.id)} aria-label={t('finance.expenses.voucher.print')}>
            <Printer className="size-4" aria-hidden="true" />
          </Button>
          {e.status === 'recorded' ? (
            <Button size="sm" variant="ghost" className="text-status-danger" onClick={() => { setVoidingId(e.id); setVoidReason(''); setFormError(null) }}>
              {t('finance.expenses.void')}
            </Button>
          ) : (
            <span className="text-xs text-text-secondary" title={e.voidReason ?? ''}>{e.voidReason}</span>
          )}
        </div>
      ),
    },
  ]

  const voucherExpense = expenses.find((e) => e.id === voucherExpenseId) ?? null
  const voucherData: ExpenseVoucherData | null = voucherExpense ? {
    id: voucherExpense.id,
    branchName: voucherExpense.branchName,
    categoryName: voucherExpense.categoryId ? voucherExpense.categoryName : null,
    amount: voucherExpense.amount,
    paymentMethod: voucherExpense.paymentMethod,
    description: voucherExpense.description,
    reference: voucherExpense.reference,
    paidTo: voucherExpense.paidTo,
    expenseDate: voucherExpense.expenseDate,
    status: voucherExpense.status,
    recordedByName: voucherExpense.recordedByName,
    voidedByName: voucherExpense.voidedByName,
    voidedAt: voucherExpense.voidedAt,
    voidReason: voucherExpense.voidReason,
    cashShiftReference: voucherExpense.cashShiftReference,
  } : null

  return (
    <div>
      <PageHeader
        title={t('finance.expenses.title')}
        description={t('finance.expenses.description')}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => { setShowCategoryForm((v) => !v); setCategoryError(null) }}>
              <Tags className="me-1 size-4" /> {t('finance.expenses.manageCategories')}
            </Button>
            <Button onClick={() => { setShowForm((v) => !v); setFormError(null) }}>
              <Plus className="me-1 size-4" /> {t('finance.expenses.recordExpense')}
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <StatCard label={t('finance.expenses.totalInRange')} value={formatMoney(report?.total_expenses ?? 0, 'EGP', locale)} icon={Receipt} />
        <StatCard label={t('finance.expenses.countInRange')} value={String(report?.expense_count ?? 0)} icon={Receipt} />
      </div>

      {formError && (
        <div className="mb-4 rounded-md border border-status-danger/40 bg-status-danger/5 p-3 text-sm text-status-danger">{formError}</div>
      )}

      {showCategoryForm && (
        <Card className="mb-4">
          <CardHeader><CardTitle className="text-base">{t('finance.expenses.manageCategories')}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <StatusBadge key={c.id} tone="neutral" label={locale === 'en' && c.nameEn ? c.nameEn : c.nameAr} />
              ))}
              {categories.length === 0 && <p className="text-sm text-text-secondary">{t('finance.expenses.noCategoriesYet')}</p>}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-text-secondary">{t('finance.expenses.categoryNameAr')}</label>
                <Input value={newCategoryAr} onChange={(e) => setNewCategoryAr(e.target.value)} className="w-48" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-text-secondary">{t('finance.expenses.categoryNameEn')}</label>
                <Input value={newCategoryEn} onChange={(e) => setNewCategoryEn(e.target.value)} className="w-48" />
              </div>
              <Button size="sm" disabled={createCategoryMutation.isPending} onClick={() => createCategoryMutation.mutate()}>
                {t('finance.expenses.addCategory')}
              </Button>
            </div>
            {categoryError && <p role="alert" className="text-sm text-status-danger">{categoryError}</p>}
          </CardContent>
        </Card>
      )}

      {showForm && (
        <Card className="mb-6">
          <CardHeader><CardTitle className="text-base">{t('finance.expenses.recordExpense')}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">{t('finance.expenses.form.branch')}</label>
                <Select value={formBranchId} onValueChange={setFormBranchId}>
                  <SelectTrigger><SelectValue placeholder={t('finance.expenses.form.branchPlaceholder')} /></SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">{t('finance.expenses.form.category')}</label>
                <Select value={formCategoryId || 'none'} onValueChange={(v) => setFormCategoryId(v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('finance.expenses.uncategorized')}</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{locale === 'en' && c.nameEn ? c.nameEn : c.nameAr}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">{t('finance.expenses.form.amount')}</label>
                <Input type="number" min={0} step="0.01" value={formAmount} onChange={(e) => setFormAmount(e.target.value)} placeholder="0.00" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">{t('finance.expenses.form.method')}</label>
                <Select value={formMethod} onValueChange={(v) => setFormMethod(v as PaymentMethod)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((m) => (
                      <SelectItem key={m} value={m}>{t(`billing.paymentMethods.underlyingMethodLabels.${m}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">{t('finance.expenses.form.date')}</label>
                <Input type="date" max={todayIso()} value={formDate} onChange={(e) => setFormDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">{t('finance.expenses.form.paidTo')}</label>
                <Input value={formPaidTo} onChange={(e) => setFormPaidTo(e.target.value)} placeholder={t('finance.expenses.form.paidToPlaceholder')} />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">{t('finance.expenses.form.reference')}</label>
                <Input value={formReference} onChange={(e) => setFormReference(e.target.value)} placeholder={t('finance.expenses.form.referencePlaceholder')} />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">{t('finance.expenses.form.description')}</label>
              <Input value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder={t('finance.expenses.form.descriptionPlaceholder')} />
            </div>
            {formMethod === 'cash' && (
              <p className="text-xs text-text-secondary">{t('finance.expenses.form.cashHint')}</p>
            )}
            <div className="flex gap-2">
              <Button disabled={recordMutation.isPending} onClick={() => recordMutation.mutate()}>
                {recordMutation.isPending ? t('common.saving') : t('finance.expenses.form.submit')}
              </Button>
              <Button variant="outline" onClick={() => { setShowForm(false); setFormError(null) }}>{t('common.cancel')}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {voidingId && (
        <div className="mb-4 flex flex-col gap-2 rounded-lg border border-border p-3 md:flex-row md:items-end">
          <div className="flex flex-1 flex-col gap-1">
            <label className="text-sm font-medium">{t('finance.expenses.voidReasonLabel')}</label>
            <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder={t('finance.expenses.voidReasonPlaceholder')} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="border-status-danger text-status-danger hover:bg-status-danger/10" disabled={voidMutation.isPending} onClick={() => voidMutation.mutate()}>
              {t('finance.expenses.confirmVoid')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setVoidingId(null); setVoidReason(''); setFormError(null) }}>{t('common.cancel')}</Button>
          </div>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">{t('finance.expenses.historyHeading')}</CardTitle></CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('finance.expenses.filters.from')}</label>
              <Input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} className="w-40" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('finance.expenses.filters.to')}</label>
              <Input type="date" value={endDate} min={startDate} max={todayIso()} onChange={(e) => setEndDate(e.target.value)} className="w-40" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('finance.expenses.filters.branch')}</label>
              <Select value={branchFilter || 'all'} onValueChange={(v) => setBranchFilter(v === 'all' ? '' : v)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('finance.expenses.filters.allBranches')}</SelectItem>
                  {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('finance.expenses.filters.category')}</label>
              <Select value={categoryFilter || 'all'} onValueChange={(v) => setCategoryFilter(v === 'all' ? '' : v)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('finance.expenses.filters.allCategories')}</SelectItem>
                  {categories.map((c) => <SelectItem key={c.id} value={c.id}>{locale === 'en' && c.nameEn ? c.nameEn : c.nameAr}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('finance.expenses.filters.status')}</label>
              <Select value={statusFilter || 'all'} onValueChange={(v) => setStatusFilter(v === 'all' ? '' : (v as 'recorded' | 'voided'))}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('finance.expenses.filters.allStatuses')}</SelectItem>
                  <SelectItem value="recorded">{t('finance.expenses.statusRecorded')}</SelectItem>
                  <SelectItem value="voided">{t('finance.expenses.statusVoided')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DataTable
            columns={columns}
            rows={filteredExpenses}
            rowKey={(e) => e.id}
            isLoading={isLoading}
            emptyTitle={t('finance.expenses.emptyTitle')}
          />
        </CardContent>
      </Card>

      {voucherData && (
        <ExpenseVoucherDialog expense={voucherData} onClose={() => setVoucherExpenseId(null)} />
      )}
    </div>
  )
}
