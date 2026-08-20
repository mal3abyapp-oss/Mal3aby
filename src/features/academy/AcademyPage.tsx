import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MembershipsSection } from '@/features/academy/MembershipsSection'
import { AttendanceSection } from '@/features/academy/AttendanceSection'
import { PlayersSection } from '@/features/academy/PlayersSection'
import { CoachTodayView } from '@/features/academy/CoachTodayView'
import { AcademyOverview } from '@/features/academy/AcademyOverview'

export function AcademyPage() {
  const { t } = useTranslation()
  const { currentMembership } = useAuth()
  const [activeTab, setActiveTab] = useState<'overview' | 'players' | 'memberships' | 'attendance'>('overview')

  if (currentMembership?.roleKey === 'coach') {
    return <CoachTodayView />
  }

  return (
    <div>
      <PageHeader title={t('academy.title')} description={t('academy.description')} />

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList>
          <TabsTrigger value="overview">{t('academy.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="players">{t('academy.tabs.players')}</TabsTrigger>
          <TabsTrigger value="memberships">{t('academy.tabs.memberships')}</TabsTrigger>
          <TabsTrigger value="attendance">{t('academy.tabs.attendance')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <AcademyOverview onNavigateTab={(tab) => setActiveTab(tab)} />
        </TabsContent>

        <TabsContent value="players">
          <PlayersSection />
        </TabsContent>

        <TabsContent value="memberships">
          {/* IA restructuring (Phase 5): ActivationPolicySetting used to
              be mounted here AND inside SettingsPage -- the exact same
              component, two places (confirmed duplicate in
              MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md). Settings is now
              the single home for that control; a link out replaces the
              duplicate mount so the policy stays discoverable from the
              subscribe workflow without re-rendering it here. */}
          <p className="mt-4 text-sm text-text-secondary">
            {t('academy.enrollments.activationPolicyManagedFrom')}{' '}
            <Link to="/app/settings" className="text-accent-foreground hover:underline">
              {t('academy.enrollments.settingsPage')}
            </Link>
            .
          </p>
          <MembershipsSection />
        </TabsContent>

        <TabsContent value="attendance">
          <AttendanceSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}
