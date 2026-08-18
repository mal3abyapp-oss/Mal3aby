import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { MoneyDisplay } from '@/components/ui/money-display'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { InvoiceRow } from '@/lib/domain/billing'

// /app/outstanding — read-only projection over outstanding_invoices,
// filters applied client-side against the same fetched rows (view is
// already club/branch-scoped by RLS). CSV export is client-side generation
// from the exact rows shown, no library, same scoping as the on-screen
// view by construction (it's the same query result, not a separate export
// path that could diverge).
//
// Owner-level review finding (P1, real financial-status contradiction):
// outstanding_invoices' own view definition is `WHERE status = 'issued'`
// ONLY -- it deliberately has no `outstanding > 0` filter, because other
// consumers (e.g. BookingDetailSheet) use it as a general per-invoice
// payment-summary lookup, not exclusively an unpaid-invoices list. This
// page never added that filter itself despite being titled "المستحقات"
// (Outstanding/Dues) with its own on-screen description "الفواتير غير
// المسددة بالكامل" (invoices not fully settled) -- found live showing
// numerous invoices with outstanding = 0.00 EGP still labeled "مستحق".
// Fixed at the fetch boundary (not the shared view, which other screens
// correctly rely on for its broader scope) so a fully-paid invoice can
// never appear on the one screen whose entire purpose is showing what's
// still owed.
type FilterKey = 'all' | 'due_today' | 'overdue'

async function fetchOutstanding(clubId: string) {
  const { data, error } = await supabase
    .from('outstanding_invoices')
    .select('*')
    .eq('club_id', clubId)
    .order('due_date', { ascending: true, nullsFirst: false })
  if (error) throw error
  return (data ?? [])
    .map<InvoiceRow>((row) => ({
      id: row.id ?? '',
      invoiceNumber: row.invoice_number ?? '',
      customerId: row.customer_id ?? '',
      customerName: row.customer_name ?? '—',
      status: row.status ?? '',
      total: Number(row.total),
      outstanding: row.outstanding !== null ? Number(row.outstanding) : null,
      dueDate: row.due_date,
      daysOverdue: row.days_overdue,
    }))
    .filter((row) => (row.outstanding ?? 0) > 0)
}

function toCsv(rows: InvoiceRow[], header: string[]): string {
  const lines = rows.map((r) =>
    [r.invoiceNumber, r.customerName, r.total, r.outstanding ?? '', r.dueDate ?? '', r.daysOverdue ?? '']
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(','),
  )
  return [header.join(','), ...lines].join('\n')
}

export function OutstandingPage() {
  const { currentClubId } = useAuth()
  const { t } = useTranslation()
  const [filter, setFilter] = useState<FilterKey>('all')

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['outstanding-invoices', currentClubId],
    queryFn: () => fetchOutstanding(currentClubId!),
    enabled: !!currentClubId,
  })

  const today = new Date().toISOString().slice(0, 10)
  const filtered = invoices.filter((inv) => {
    if (filter === 'due_today') return inv.dueDate === today
    if (filter === 'overdue') return (inv.daysOverdue ?? 0) > 0
    return true
  })

  function handleExport() {
    const csv = toCsv(filtered, [
      t('billing.outstandingPage.csvHeader.invoiceNumber'),
      t('billing.outstandingPage.csvHeader.customer'),
      t('billing.outstandingPage.csvHeader.total'),
      t('billing.outstandingPage.csvHeader.outstanding'),
      t('billing.outstandingPage.csvHeader.dueDate'),
      t('billing.outstandingPage.csvHeader.daysOverdue'),
    ])
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `outstanding-${today}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const columns: DataTableColumn<InvoiceRow>[] = [
    { key: 'number', header: t('billing.outstandingPage.table.invoiceNumber'), render: (r) => r.invoiceNumber },
    { key: 'customer', header: t('billing.outstandingPage.table.customer'), render: (r) => r.customerName },
    { key: 'total', header: t('billing.outstandingPage.table.total'), render: (r) => <MoneyDisplay amount={r.total} size="sm" /> },
    { key: 'outstanding', header: t('billing.outstandingPage.table.outstanding'), render: (r) => <MoneyDisplay amount={r.outstanding ?? 0} size="sm" tone="danger" /> },
    { key: 'due', header: t('billing.outstandingPage.table.due'), render: (r) => (r.dueDate ? new Date(r.dueDate).toLocaleDateString('ar-EG') : '—') },
    {
      key: 'status',
      header: t('billing.outstandingPage.table.status'),
      render: (r) =>
        (r.daysOverdue ?? 0) > 0 ? (
          <StatusBadge tone="danger" label={t('billing.outstandingPage.overdueDays', { days: r.daysOverdue })} />
        ) : (
          <StatusBadge tone="warning" label={t('billing.outstandingPage.due')} />
        ),
    },
  ]

  return (
    <div>
      <PageHeader
        title={t('billing.outstandingPage.title')}
        description={t('billing.outstandingPage.description')}
        actions={
          <Button variant="outline" onClick={handleExport} disabled={filtered.length === 0}>
            {t('billing.outstandingPage.exportCsv')}
          </Button>
        }
      />

      <div className="mb-4 w-48">
        <Select value={filter} onValueChange={(v) => setFilter(v as FilterKey)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('billing.outstandingPage.filterAll')}</SelectItem>
            <SelectItem value="due_today">{t('billing.outstandingPage.filterDueToday')}</SelectItem>
            <SelectItem value="overdue">{t('billing.outstandingPage.filterOverdue')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(r) => r.id}
        isLoading={isLoading}
        emptyTitle={t('billing.outstandingPage.emptyTitle')}
        emptyDescription={t('billing.outstandingPage.emptyDescription')}
      />
    </div>
  )
}
