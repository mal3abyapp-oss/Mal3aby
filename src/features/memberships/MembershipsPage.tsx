import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MembershipsOverview } from '@/features/memberships/MembershipsOverview'
import { PlansSection } from '@/features/memberships/PlansSection'
import { MembersSection } from '@/features/memberships/MembersSection'
import { ExpiringSoonSection } from '@/features/memberships/ExpiringSoonSection'

// Club Memberships -- staff module. Tabbed page mirroring
// AcademyPage.tsx's own PageHeader + Tabs structure exactly.

type MembershipsTab = 'overview' | 'plans' | 'members' | 'expiring'

export function MembershipsPage() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<MembershipsTab>('overview')

  return (
    <div>
      <PageHeader title={t('clubMemberships.title')} description={t('clubMemberships.description')} />

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as MembershipsTab)}>
        <TabsList>
          <TabsTrigger value="overview">{t('clubMemberships.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="plans">{t('clubMemberships.tabs.plans')}</TabsTrigger>
          <TabsTrigger value="members">{t('clubMemberships.tabs.members')}</TabsTrigger>
          <TabsTrigger value="expiring">{t('clubMemberships.tabs.expiring')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <MembershipsOverview onNavigateTab={(tab) => setActiveTab(tab)} />
        </TabsContent>

        <TabsContent value="plans">
          <PlansSection />
        </TabsContent>

        <TabsContent value="members">
          <MembersSection />
        </TabsContent>

        <TabsContent value="expiring">
          <ExpiringSoonSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}
