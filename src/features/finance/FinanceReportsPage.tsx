import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Wallet, HandCoins, Banknote, ReceiptText, ShieldCheck, Scale, UserX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ReportRevenueContent } from '@/features/reports/ReportRevenuePage'
import { ReportCollectionsContent } from '@/features/reports/ReportCollectionsPage'
import { ReportPaymentMethodsContent } from '@/features/reports/ReportPaymentMethodsPage'
import { ReportExceptionsContent } from '@/features/reports/ReportExceptionsPage'
import { ReportOfficialReceiptsContent } from '@/features/reports/ReportOfficialReceiptsPage'
import { ReportReconciliationContent } from '@/features/reports/ReportReconciliationPage'
import { ReportEmployeeLiabilityContent } from '@/features/reports/ReportEmployeeLiabilityPage'

// Finance IA consolidation directive sections 27-28: "Financial Reports"
// -- only the financial subset of the Reports module (Revenue,
// Collections, Payment Methods, Exceptions, Official Receipts,
// Reconciliation, Employee Liability), grouped as cards/tabs, not 7
// separate sidebar routes. Operational reports (Bookings, Occupancy,
// Academy, Customers) stay under the existing /app/reports -- directive
// section 27 explicitly: "do not move non-financial reports". Every
// report keeps its own unmodified content component (directive section
// 29: "UI total must equal DB aggregation" -- unchanged fetch/render
// logic means this holds automatically, already true of the originals).
type ReportKey = 'revenue' | 'collections' | 'payment-methods' | 'exceptions' | 'official-receipts' | 'reconciliation' | 'employee-liability'

const REPORT_TABS: { key: ReportKey; labelKey: string; icon: LucideIcon }[] = [
  { key: 'revenue', labelKey: 'finance.reportsPage.revenue', icon: Wallet },
  { key: 'collections', labelKey: 'finance.reportsPage.collections', icon: HandCoins },
  { key: 'payment-methods', labelKey: 'finance.reportsPage.paymentMethods', icon: Banknote },
  { key: 'exceptions', labelKey: 'finance.reportsPage.exceptions', icon: ReceiptText },
  { key: 'official-receipts', labelKey: 'finance.reportsPage.officialReceipts', icon: ShieldCheck },
  { key: 'reconciliation', labelKey: 'finance.reportsPage.reconciliation', icon: Scale },
  { key: 'employee-liability', labelKey: 'finance.reportsPage.employeeLiability', icon: UserX },
]

export function FinanceReportsPage() {
  const { t } = useTranslation()
  const [reportKey, setReportKey] = useState<ReportKey>('revenue')

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1 overflow-x-auto rounded-lg bg-muted p-1">
        {REPORT_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setReportKey(tab.key)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all',
              reportKey === tab.key ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <tab.icon className="size-4" />
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {reportKey === 'revenue' && <ReportRevenueContent />}
      {reportKey === 'collections' && <ReportCollectionsContent />}
      {reportKey === 'payment-methods' && <ReportPaymentMethodsContent />}
      {reportKey === 'exceptions' && <ReportExceptionsContent />}
      {reportKey === 'official-receipts' && <ReportOfficialReceiptsContent />}
      {reportKey === 'reconciliation' && <ReportReconciliationContent />}
      {reportKey === 'employee-liability' && <ReportEmployeeLiabilityContent />}
    </div>
  )
}
