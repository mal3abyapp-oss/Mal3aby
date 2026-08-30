import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MembershipsOverview } from '@/features/memberships/MembershipsOverview'
import { PlansSection } from '@/features/memberships/PlansSection'
import { MembersSection } from '@/features/memberships/MembersSection'
import { ExpiringSoonSection } from '@/features/memberships/ExpiringSoonSection'
import { MembershipReportSection } from '@/features/memberships/MembershipReportSection'

// Club Memberships -- staff module. Tabbed page mirroring
// AcademyPage.tsx's own PageHeader + Tabs structure exactly.
//
// FINAL REPORTING COVERAGE CLOSURE (2026-08-30): added the "Report"
// tab -- the one confirmed material reporting gap from the prior
// comprehensive reports acceptance pass (get_club_membership_report()
// existed server-side with zero UI consumers). New tab here rather
// than a new top-level route, matching this page's own existing IA
// (Overview/Plans/Members/Expiring already live as tabs of one page).

type MembershipsTab = 'overview' | 'plans' | 'members' | 'expiring' | 'report'

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
          <TabsTrigger value="report">{t('clubMemberships.tabs.report')}</TabsTrigger>
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

        <TabsContent value="report">
          <MembershipReportSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}
