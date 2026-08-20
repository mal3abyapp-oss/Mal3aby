import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { BillingPage } from '@/features/billing/BillingPage'
import { OutstandingPage } from '@/features/billing/OutstandingPage'
import { PendingPaymentsPage } from '@/features/billing/PendingPaymentsPage'

// Finance IA consolidation directive sections 7-12: "Payments &
// Collections" is the merged home for payments/collections/outstanding/
// pending proofs -- directive explicitly forbids rebuilding these as a
// second payment system, so each sub-view below is the EXISTING,
// unmodified page component. This is a thin sub-tab switch, not a
// rewrite: BillingPage already contains the full payment list + detail
// + collection + refund flow (directive section 9's "unified Payments
// list" requirement), OutstandingPage is its filtered/exportable
// projection, PendingPaymentsPage is the proof-review queue (directive
// section 11).
//
// ?status=outstanding|unpaid|partially_paid|refunded and
// ?tab=pending-proofs (used by FinanceOverviewPage's drill-down cards)
// select which sub-view opens; BillingPage itself already reads
// ?invoice= for deep-linking into one invoice (directive section 32 --
// preserved unchanged).
type SubTab = 'all' | 'outstanding' | 'pending-proofs'

export function FinancePaymentsPage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const initialTab: SubTab =
    searchParams.get('tab') === 'pending-proofs'
      ? 'pending-proofs'
      : searchParams.get('status')
        ? 'outstanding'
        : 'all'
  const [subTab, setSubTab] = useState<SubTab>(initialTab)

  const tabs: { key: SubTab; labelKey: string }[] = [
    { key: 'all', labelKey: 'finance.payments.tabAll' },
    { key: 'outstanding', labelKey: 'finance.payments.tabOutstanding' },
    { key: 'pending-proofs', labelKey: 'finance.payments.tabPendingProofs' },
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

      {subTab === 'all' && <BillingPage />}
      {subTab === 'outstanding' && <OutstandingPage />}
      {subTab === 'pending-proofs' && <PendingPaymentsPage />}
    </div>
  )
}
