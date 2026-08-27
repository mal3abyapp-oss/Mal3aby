import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ClubSettingsCard } from '@/features/clubs/ClubSettingsCard'
import { ClubContactCard } from '@/features/clubs/ClubContactCard'
import { BookingPolicyCard } from '@/features/clubs/BookingPolicyCard'
import { PublicBookingLinkCard } from '@/features/clubs/PublicBookingLinkCard'
import { PlatformSubscriptionCard } from '@/features/clubs/PlatformSubscriptionCard'
import { EntitlementsCard } from '@/features/clubs/EntitlementsCard'
import { ActivationPolicySetting } from '@/features/academy/EnrollmentSection'
import { PaymentMethodsCard } from '@/features/billing/PaymentMethodsCard'
import { PaymentGatewayConnectionsCard } from '@/features/billing/PaymentGatewayConnectionsCard'
import { ChangePasswordCard } from '@/features/account/ChangePasswordCard'
import { GovernmentComplianceCard } from '@/features/clubs/GovernmentComplianceCard'
import { BUILD_SHA, BUILD_TIME } from '@/lib/version'

// P1-7 (critical usability fix pass, 2026-08-16): Settings was a
// dumping ground -- /app/settings rendered only the Audit Log Viewer,
// while club/branch/fields/subscription settings lived scattered across
// /app/club with no discoverable structure. Rebuilt as a real settings
// hub with clear sections matching what the schema/business rules
// actually support -- no placeholder or unsupported settings exposed.
//
// IA restructuring (Phase 5): narrowed further. Confirmed in
// MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md that this page had grown
// into 8 sections covering identity, physical infrastructure, staff,
// payments, WhatsApp, platform billing, and security -- most of which
// are not "settings" in any coherent sense, just administrative screens
// that hadn't been given a real home yet. Moved out:
//   - Branches + Fields/hours/pricing -> /app/fields (own operational
//     domain, not settings -- see BranchesFieldsPage.tsx)
//   - Staff stub card -> removed entirely (redundant: Staff already has
//     its own sidebar item, this card only ever linked to it)
//   - Audit log -> /app/audit-log (a monitoring/security concern, not
//     settings)
//
// IA restructuring (Phase 8): WhatsApp (WhatsAppConnectionCard /
// MessagingSafetyCard) moved out to its own top-level module
// (/app/whatsapp, 4 tabs) per the directive's explicit instruction --
// a link replaces the two cards, same de-duplication pattern used for
// ActivationPolicySetting in Phase 5.
//
// What remains is true club-identity/business configuration: club
// identity, academy activation policy, payment method/gateway config,
// and platform-subscription status.
export function SettingsPage() {
  const { t } = useTranslation()
  const { currentMembership, session } = useAuth()
  // STAFF ACCESS CONTROL & CUSTOM ROLES (2026-08-25): was a hardcoded
  // roleKey check (club_owner/club_manager only) -- a custom role can
  // now reach this screen via the nav's real club.update permission
  // check without ever matching either roleKey, which used to leave
  // this section's edit controls silently disabled with no visible
  // reason. Keyed on the same permission that actually gates the
  // underlying club.update RPC/RLS now, matching how the nav domain
  // itself is derived (see navigation.ts).
  const isOwnerOrManager = currentMembership?.permissionKeys.includes('club.update') ?? false

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('settings.title')} description={t('settings.description')} />

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">{t('settings.clubSection')}</h2>
        <ClubSettingsCard />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">{t('settings.contactSection')}</h2>
        <ClubContactCard />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">{t('settings.bookingPolicySection')}</h2>
        <BookingPolicyCard />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">{t('settings.publicBookingSection')}</h2>
        <PublicBookingLinkCard />
      </section>

      {isOwnerOrManager && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-text-secondary">{t('settings.academySection')}</h2>
          <Card>
            <CardHeader><CardTitle className="text-base">{t('settings.activationPolicyTitle')}</CardTitle></CardHeader>
            <CardContent>
              <ActivationPolicySetting />
            </CardContent>
          </Card>
        </section>
      )}

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">{t('settings.paymentsSection')}</h2>
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <div className="min-w-0"><PaymentMethodsCard /></div>
          <div className="min-w-0"><PaymentGatewayConnectionsCard /></div>
        </div>
      </section>

      {/* Government / Ministry Collection Compliance directive, section
          8: a real, always-visible settings surface -- never hidden
          after onboarding. Shown to every club (not just ones that
          answered YES at onboarding) since a club can become
          government-affiliated later without re-onboarding. */}
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">{t('settings.financeComplianceSection')}</h2>
        <GovernmentComplianceCard />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">{t('settings.notificationsSection')}</h2>
        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <p className="text-sm text-text-secondary">{t('settings.whatsappManagedNote')}</p>
            <Button asChild size="sm" variant="outline">
              <Link to="/app/whatsapp">{t('settings.openWhatsappPage')}</Link>
            </Button>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-secondary">{t('settings.platformSubscriptionSection')}</h2>
          <Button asChild size="sm" variant="ghost">
            <Link to="/app/subscription">{t('settings.viewFullDetails')}</Link>
          </Button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <PlatformSubscriptionCard />
          <EntitlementsCard />
        </div>
      </section>

      {/* Platform Owner & Password Security directive: self-service
          password change lives here in the account-level Security
          section -- reuses the shared ChangePasswordCard, the same
          component PortalProfilePage.tsx mounts for customers. */}
      {session?.user.email && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-text-secondary">{t('account.securitySection')}</h2>
          <ChangePasswordCard userEmail={session.user.email} />
        </section>
      )}

      {/* VERSION VISIBILITY (item D, 2026-08-27 auth/cache bugfix
          directive): a quiet, low-key build identifier so a deployed
          build can actually be confirmed against git HEAD -- no secret
          exposed, just the commit this dist/ was built from. */}
      <p className="text-center text-xs text-text-secondary/60">
        {t('settings.buildVersion', { sha: BUILD_SHA, time: new Date(BUILD_TIME).toLocaleString() })}
      </p>
    </div>
  )
}
