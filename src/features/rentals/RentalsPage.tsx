import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RentalsOverview } from './RentalsOverview'
import { SpacesSection } from './SpacesSection'
import { ContractsSection } from './ContractsSection'
import { DuesSection } from './DuesSection'

// Rentals -- staff module for leasing club-owned spaces (gym, wedding
// hall, shop unit, ... or any custom-named type). Same PageHeader + Tabs
// shell as MembershipsPage. Money never lives here: installments become
// ordinary invoices collected in Finance, so every finance surface and
// report picks rentals up through the shared invoice/payment ledger.

type RentalsTab = 'overview' | 'spaces' | 'contracts' | 'dues'

export function RentalsPage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<RentalsTab>('overview')

  return (
    <div>
      <PageHeader title={t('rentals.title')} description={t('rentals.description')} />

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as RentalsTab)}>
        <TabsList>
          <TabsTrigger value="overview">{t('rentals.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="spaces">{t('rentals.tabs.spaces')}</TabsTrigger>
          <TabsTrigger value="contracts">{t('rentals.tabs.contracts')}</TabsTrigger>
          <TabsTrigger value="dues">{t('rentals.tabs.dues')}</TabsTrigger>
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
      </Tabs>
    </div>
  )
}
