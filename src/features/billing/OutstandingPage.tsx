import { useState } from 'react'
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
type FilterKey = 'all' | 'due_today' | 'overdue'

async function fetchOutstanding(clubId: string) {
  const { data, error } = await supabase
    .from('outstanding_invoices')
    .select('*')
    .eq('club_id', clubId)
    .order('due_date', { ascending: true, nullsFirst: false })
  if (error) throw error
  return (data ?? []).map<InvoiceRow>((row) => ({
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
}

function toCsv(rows: InvoiceRow[]): string {
  const header = ['رقم الفاتورة', 'العميل', 'الإجمالي', 'المستحق', 'تاريخ الاستحقاق', 'أيام التأخير']
  const lines = rows.map((r) =>
    [r.invoiceNumber, r.customerName, r.total, r.outstanding ?? '', r.dueDate ?? '', r.daysOverdue ?? '']
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(','),
  )
  return [header.join(','), ...lines].join('\n')
}

export function OutstandingPage() {
  const { currentClubId } = useAuth()
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
    const csv = toCsv(filtered)
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
    { key: 'number', header: 'رقم الفاتورة', render: (r) => r.invoiceNumber },
    { key: 'customer', header: 'العميل', render: (r) => r.customerName },
    { key: 'total', header: 'الإجمالي', render: (r) => <MoneyDisplay amount={r.total} size="sm" /> },
    { key: 'outstanding', header: 'المستحق', render: (r) => <MoneyDisplay amount={r.outstanding ?? 0} size="sm" tone="danger" /> },
    { key: 'due', header: 'الاستحقاق', render: (r) => (r.dueDate ? new Date(r.dueDate).toLocaleDateString('ar-EG') : '—') },
    {
      key: 'status',
      header: 'الحالة',
      render: (r) =>
        (r.daysOverdue ?? 0) > 0 ? (
          <StatusBadge tone="danger" label={`متأخر ${r.daysOverdue} يوم`} />
        ) : (
          <StatusBadge tone="warning" label="مستحق" />
        ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="المستحقات"
        description="الفواتير غير المسددة بالكامل"
        actions={
          <Button variant="outline" onClick={handleExport} disabled={filtered.length === 0}>
            تصدير CSV
          </Button>
        }
      />

      <div className="mb-4 w-48">
        <Select value={filter} onValueChange={(v) => setFilter(v as FilterKey)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">الكل</SelectItem>
            <SelectItem value="due_today">مستحق اليوم</SelectItem>
            <SelectItem value="overdue">متأخر</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(r) => r.id}
        isLoading={isLoading}
        emptyTitle="لا توجد مستحقات"
        emptyDescription="جميع الفواتير مسددة بالكامل"
      />
    </div>
  )
}
