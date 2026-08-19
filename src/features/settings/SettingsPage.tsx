import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ClubSettingsCard } from '@/features/clubs/ClubSettingsCard'
import { PublicBookingLinkCard } from '@/features/clubs/PublicBookingLinkCard'
import { PlatformSubscriptionCard } from '@/features/clubs/PlatformSubscriptionCard'
import { EntitlementsCard } from '@/features/clubs/EntitlementsCard'
import { ActivationPolicySetting } from '@/features/academy/EnrollmentSection'
import { PaymentMethodsCard } from '@/features/billing/PaymentMethodsCard'
import { PaymentGatewaysCard } from '@/features/billing/PaymentGatewaysCard'

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
  const { currentMembership } = useAuth()
  const isOwnerOrManager = currentMembership?.roleKey === 'club_owner' || currentMembership?.roleKey === 'club_manager'

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('settings.title')} description={t('settings.description')} />

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">{t('settings.clubSection')}</h2>
        <ClubSettingsCard />
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
        <div className="grid gap-4 lg:grid-cols-2">
          <PaymentMethodsCard />
          <PaymentGatewaysCard />
        </div>
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
    </div>
  )
}
