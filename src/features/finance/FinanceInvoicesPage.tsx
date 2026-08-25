import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { BillingPage } from '@/features/billing/BillingPage'
import { ReportOfficialReceiptsPage } from '@/features/reports/ReportOfficialReceiptsPage'

// Finance IA consolidation directive sections 13-18: "Invoices &
// Receipts" -- invoice list/detail/PDF already live in BillingPage
// (same file as Payments & Collections, since the underlying page
// genuinely covers both concerns -- directive section 36 forbids
// splitting one source of truth into fake-separate tables). Official
// Collection Receipts get their own sub-view here per directive section
// 17 ("Official Receipts... under Finance -> Invoices & Receipts,
// Subview/filter"), reusing the existing, unmodified report screen --
// its own receipt-rules (server-side hard block, duplicate prevention,
// reversal audit trail) are untouched (directive section 18).
type SubTab = 'invoices' | 'official-receipts'

export function FinanceInvoicesPage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const [subTab, setSubTab] = useState<SubTab>(
    searchParams.get('invoice') ? 'invoices' : searchParams.get('tab') === 'official-receipts' ? 'official-receipts' : 'invoices',
  )

  // Reports + Invoices + Universal Entity Drill-Down audit: same fix as
  // FinancePaymentsPage -- ?invoice= (BillingPage's deep-link param)
  // must always resolve to the 'invoices' sub-tab, including when it
  // appears while this page is already mounted on 'official-receipts'.
  useEffect(() => {
    if (searchParams.get('invoice')) setSubTab('invoices')
  }, [searchParams])

  const tabs: { key: SubTab; labelKey: string }[] = [
    { key: 'invoices', labelKey: 'finance.invoices.tabInvoices' },
    { key: 'official-receipts', labelKey: 'finance.invoices.tabOfficialReceipts' },
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

      {subTab === 'invoices' && <BillingPage />}
      {subTab === 'official-receipts' && <ReportOfficialReceiptsPage />}
    </div>
  )
}
