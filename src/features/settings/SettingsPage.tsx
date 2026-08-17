import { Link } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ClubSettingsCard } from '@/features/clubs/ClubSettingsCard'
import { BranchesCard } from '@/features/clubs/BranchesCard'
import { PlatformSubscriptionCard } from '@/features/clubs/PlatformSubscriptionCard'
import { EntitlementsCard } from '@/features/clubs/EntitlementsCard'
import { FieldsManagement } from '@/features/clubs/FieldsManagement'
import { ActivationPolicySetting } from '@/features/academy/EnrollmentSection'
import { PaymentMethodsCard } from '@/features/billing/PaymentMethodsCard'
import { WhatsAppConnectionCard } from './WhatsAppConnectionCard'
import { AuditLogSection } from './AuditLogPage'

// P1-7 (critical usability fix pass, 2026-08-16): Settings was a
// dumping ground -- /app/settings rendered only the Audit Log Viewer,
// while club/branch/fields/subscription settings lived scattered across
// /app/club with no discoverable structure. Rebuilt as a real settings
// hub with clear sections matching what the schema/business rules
// actually support -- no placeholder or unsupported settings exposed.
export function SettingsPage() {
  const { currentMembership } = useAuth()
  const isOwnerOrManager = currentMembership?.roleKey === 'club_owner' || currentMembership?.roleKey === 'club_manager'

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="الإعدادات" description="إعدادات النادي والفروع والأكاديمية والصلاحيات" />

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">النادي</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <ClubSettingsCard />
          <BranchesCard />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">إعدادات الحجوزات</h2>
        <FieldsManagement />
      </section>

      {isOwnerOrManager && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-text-secondary">إعدادات الأكاديمية</h2>
          <Card>
            <CardHeader><CardTitle className="text-base">سياسة تفعيل الاشتراك</CardTitle></CardHeader>
            <CardContent>
              <ActivationPolicySetting />
            </CardContent>
          </Card>
        </section>
      )}

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">الموظفون والصلاحيات</h2>
        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <p className="text-sm text-text-secondary">إدارة الموظفين وأدوارهم ونطاق الفروع تتم من صفحة الموظفين المخصصة.</p>
            <Button asChild size="sm" variant="outline">
              <Link to="/app/staff">فتح صفحة الموظفين</Link>
            </Button>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">المدفوعات</h2>
        <PaymentMethodsCard />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">الإشعارات</h2>
        <WhatsAppConnectionCard />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">اشتراك المنصة</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <PlatformSubscriptionCard />
          <EntitlementsCard />
        </div>
      </section>

      {isOwnerOrManager && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-text-secondary">الأمان وسجل التدقيق</h2>
          <AuditLogSection />
        </section>
      )}
    </div>
  )
}
