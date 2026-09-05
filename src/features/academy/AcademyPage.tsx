import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MembershipsSection } from '@/features/academy/MembershipsSection'
import { AttendanceSection } from '@/features/academy/AttendanceSection'
import { PlayersSection } from '@/features/academy/PlayersSection'
import { CoachTodayView } from '@/features/academy/CoachTodayView'
import { AcademyOverview } from '@/features/academy/AcademyOverview'

// P0 fix (2026-09-05): this used to route purely on
// `roleKey === 'coach'`, the same wrong pattern TodayPage.tsx had
// (see that file's fix comment) and explicitly forbidden by
// Employee360Page.tsx's own precedent ("never a role-name check").
// A custom role built with coach-equivalent permissions (can mark
// attendance / view sessions, but cannot manage enrollment/programs/
// groups) was previously misrouted to the full manager tabs it has no
// permission to act on. Mirrors navigation.ts's NAV_DOMAIN_PERMISSIONS
// grouping: coach-view = holds session/attendance keys AND holds none
// of the enrollment/program/group management keys.
const COACH_DELIVERY_KEYS = ['session.view', 'attendance.view', 'attendance.mark']
const ACADEMY_MANAGEMENT_KEYS = ['enrollment.view', 'enrollment.create', 'academy.group.manage', 'academy.program.manage']

export function isCoachOnlyView(permissionKeys: readonly string[] | undefined): boolean {
  if (!permissionKeys || permissionKeys.length === 0) return false
  const hasDeliveryAccess = COACH_DELIVERY_KEYS.some((key) => permissionKeys.includes(key))
  const hasManagementAccess = ACADEMY_MANAGEMENT_KEYS.some((key) => permissionKeys.includes(key))
  return hasDeliveryAccess && !hasManagementAccess
}

export function AcademyPage() {
  const { t } = useTranslation()
  const { currentMembership } = useAuth()
  // Acceptance-sweep fix (2026-08-30): Player360Page's "Subscribe to
  // membership" button navigates here with ?subscribePlayer=<id>,
  // expecting to land on the Players tab so PlayersSection's own
  // param-driven auto-open (see PlayersSection.tsx) can find and select
  // that player. activeTab always defaulted to 'overview' regardless of
  // the URL, so PlayersSection was never even mounted -- confirmed
  // live: the button silently dropped staff back on the plain Overview
  // tab with no player selected.
  const [searchParams] = useSearchParams()
  const [activeTab, setActiveTab] = useState<'overview' | 'players' | 'memberships' | 'attendance'>(
    searchParams.has('subscribePlayer') ? 'players' : 'overview',
  )

  // Built-in coach role keeps exactly its existing behavior (still
  // roleKey-gated first, so system-role coaches are unaffected);
  // additionally, any custom role whose real permission set is
  // coach-equivalent now also gets the focused delivery view instead
  // of the full manager tabs it can't act on.
  if (currentMembership?.roleKey === 'coach' || isCoachOnlyView(currentMembership?.permissionKeys)) {
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
