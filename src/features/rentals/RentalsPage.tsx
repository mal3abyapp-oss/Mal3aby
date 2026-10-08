import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Settings } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RentalsOverview } from './RentalsOverview'
import { SpacesSection } from './SpacesSection'
import { ContractsSection } from './ContractsSection'
import { DuesSection } from './DuesSection'
import { BookingRequestsSection } from './BookingRequestsSection'
import { RentalSettingsDialog } from './RentalSettingsDialog'
import { ContractDetailDialog } from './ContractDetailDialog'
import { useBookingRequests, useInvalidateRentals, useRentalPermissions } from './hooks'

// Rentals -- staff module for leasing club-owned spaces (gym, wedding
// hall, shop unit, ... or any custom-named type). Same PageHeader + Tabs
// shell as MembershipsPage. Money never lives here: installments become
// ordinary invoices collected in Finance, so every finance surface and
// report picks rentals up through the shared invoice/payment ledger.

type RentalsTab = 'overview' | 'spaces' | 'contracts' | 'dues' | 'requests'
const TABS: RentalsTab[] = ['overview', 'spaces', 'contracts', 'dues', 'requests']

export function RentalsPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as RentalsTab | null
  const [activeTab, setActiveTab] = useState<RentalsTab>(tabParam && TABS.includes(tabParam) ? tabParam : 'overview')
  // Follow ?tab= when it changes while the page is mounted (e.g. a
  // dashboard link to the requests tab).
  useEffect(() => {
    if (tabParam && TABS.includes(tabParam)) setActiveTab(tabParam)
  }, [tabParam])
  const { data: pendingRequests = [] } = useBookingRequests('pending')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { canManageContracts } = useRentalPermissions()
  const invalidate = useInvalidateRentals()
  // ?contract=<id> (from Global Search) opens that lease directly.
  const linkedContractId = searchParams.get('contract')

  return (
    <div>
      <PageHeader
        title={t('rentals.title')}
        description={t('rentals.description')}
        actions={canManageContracts ? (
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}><Settings />{t('rentals.settings.open')}</Button>
        ) : undefined}
      />
      {settingsOpen && <RentalSettingsDialog onClose={() => setSettingsOpen(false)} />}
      {linkedContractId && (
        <ContractDetailDialog
          key={linkedContractId}
          contractId={linkedContractId}
          onClose={() => setSearchParams((p) => { p.delete('contract'); return p }, { replace: true })}
          onChanged={invalidate}
        />
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as RentalsTab)}>
        <TabsList>
          <TabsTrigger value="overview">{t('rentals.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="spaces">{t('rentals.tabs.spaces')}</TabsTrigger>
          <TabsTrigger value="contracts">{t('rentals.tabs.contracts')}</TabsTrigger>
          <TabsTrigger value="dues">{t('rentals.tabs.dues')}</TabsTrigger>
          <TabsTrigger value="requests">
            {t('rentals.tabs.requests')}
            {pendingRequests.length > 0 && (
              <span className="ms-1 rounded-full bg-status-warning px-1.5 text-xs text-white">{pendingRequests.length}</span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <RentalsOverview onNavigateTab={(tab) => setActiveTab(tab)} />
        </TabsContent>
        <TabsContent value="spaces">
          <SpacesSection />
        </TabsContent>
        <TabsContent value="contracts">
          <ContractsSection />
        </TabsContent>
        <TabsContent value="dues">
          <DuesSection />
        </TabsContent>
        <TabsContent value="requests">
          <BookingRequestsSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}
