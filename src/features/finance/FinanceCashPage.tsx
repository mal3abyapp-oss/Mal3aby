import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { CashShiftPage } from '@/features/billing/CashShiftPage'
import { ReportReconciliationContent } from '@/features/reports/ReportReconciliationPage'
import { ReportEmployeeLiabilityContent } from '@/features/reports/ReportEmployeeLiabilityPage'

// Finance IA consolidation directive sections 19-24: "Cash Shifts &
// Treasury" -- open/close shift, shift history, and treasury/liability
// concerns in one place. CashShiftPage already covers open/close/history
// and even inline shortage/overage settlement (directive section 24:
// "don't hide it in a random place") -- Reconciliation and Employee
// Liability reports are added as sub-views so the cross-check reports
// that exist purely to audit cash-shift data live next to the screen
// that produces it (directive section 19's explicit grouping), reusing
// their unmodified content components (directive section 36).
type SubTab = 'shifts' | 'reconciliation' | 'liability'

export function FinanceCashPage() {
  const { t } = useTranslation()
  const [subTab, setSubTab] = useState<SubTab>('shifts')

  const tabs: { key: SubTab; labelKey: string }[] = [
    { key: 'shifts', labelKey: 'finance.cash.tabShifts' },
    { key: 'reconciliation', labelKey: 'finance.cash.tabReconciliation' },
    { key: 'liability', labelKey: 'finance.cash.tabLiability' },
  ]

  return (
    <div>
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg bg-muted p-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setSubTab(tab.key)}
            className={cn(
              'shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all',
              subTab === tab.key ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {subTab === 'shifts' && <CashShiftPage />}
      {subTab === 'reconciliation' && <ReportReconciliationContent />}
      {subTab === 'liability' && <ReportEmployeeLiabilityContent />}
    </div>
  )
}
