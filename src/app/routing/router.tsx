import { createBrowserRouter, Navigate } from 'react-router-dom'
import { PublicLayout } from '@/app/layouts/PublicLayout'
import { AppLayout } from '@/app/layouts/AppLayout'
import { PlatformLayout } from '@/app/layouts/PlatformLayout'
import { PortalLayout } from '@/app/layouts/PortalLayout'
import { RequireAuth, RequirePlatformOwner, RequirePortalAuth } from '@/app/routing/RequireAuth'

import { HomePage } from '@/features/public-site/HomePage'
import { PricingPage } from '@/features/public-site/PricingPage'
import { ContactPage } from '@/features/public-site/ContactPage'
import { TermsPage } from '@/features/public-site/TermsPage'
import { PrivacyPage } from '@/features/public-site/PrivacyPage'

import { LoginPage } from '@/features/auth/LoginPage'
import { SignupPage } from '@/features/auth/SignupPage'
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage'
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage'

import { OnboardingPage } from '@/features/onboarding/OnboardingPage'
import { VerifyInvoicePage } from '@/features/verify/VerifyInvoicePage'

import { TodayPage } from '@/features/dashboard/TodayPage'
import { MorePage } from '@/features/dashboard/MorePage'
import { BookingsPage } from '@/features/bookings/BookingsPage'
import { AcademyPage } from '@/features/academy/AcademyPage'
import { CustomersPage } from '@/features/customers/CustomersPage'
import { BillingPage } from '@/features/billing/BillingPage'
import { CashShiftPage } from '@/features/billing/CashShiftPage'
import { SubscriptionPage } from '@/features/billing/SubscriptionPage'
import { OutstandingPage } from '@/features/billing/OutstandingPage'
import { ReportsPage } from '@/features/reports/ReportsPage'
import { StaffPage } from '@/features/staff/StaffPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { BranchesFieldsPage } from '@/features/clubs/BranchesFieldsPage'
import { AuditLogPage } from '@/features/settings/AuditLogPage'
import { WhatsAppPage } from '@/features/whatsapp/WhatsAppPage'
import { ScanPage } from '@/features/scanner/ScanPage'

import { PortalRoot } from '@/features/portal/PortalRoot'
import { PortalAcademyPage } from '@/features/portal/PortalAcademyPage'
import { PortalQrPage } from '@/features/portal/PortalQrPage'
import { PortalPaymentsPage } from '@/features/portal/PortalPaymentsPage'
import { PortalProfilePage } from '@/features/portal/PortalProfilePage'

import { PlatformOverviewPage } from '@/features/platform/PlatformOverviewPage'
import { PlatformClubsPage } from '@/features/platform/PlatformClubsPage'
import { PlatformClubDetailPage } from '@/features/platform/PlatformClubDetailPage'
import { PlatformOwnersPage } from '@/features/platform/PlatformOwnersPage'
import { PlatformPlansPage } from '@/features/platform/PlatformPlansPage'
import { PlatformTrialsPage } from '@/features/platform/PlatformTrialsPage'
import { PlatformLeadsPage } from '@/features/platform/PlatformLeadsPage'
import { PlatformReportsPage } from '@/features/platform/PlatformReportsPage'
import { PlatformAlertsPage } from '@/features/platform/PlatformAlertsPage'
import { PlatformAuditPage } from '@/features/platform/PlatformAuditPage'
import { PlatformSettingsPage } from '@/features/platform/PlatformSettingsPage'

// Route guards: RequireAuth gates /app (any active membership),
// RequirePlatformOwner gates /platform (a platform_owner-role membership).
// Client-side only — the real boundary is always server-side RLS
// (docs/SECURITY_ANTI_FRAUD.md). See docs/SCREEN_MAP.md#route-guards.
export const router = createBrowserRouter([
  {
    element: <PublicLayout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/pricing', element: <PricingPage /> },
      { path: '/contact', element: <ContactPage /> },
      { path: '/terms', element: <TermsPage /> },
      { path: '/privacy', element: <PrivacyPage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password', element: <ResetPasswordPage /> },
    ],
  },
  {
    path: '/onboarding',
    element: <OnboardingPage />,
  },
  {
    // Task #86: public invoice verification -- no auth guard, reachable
    // by anyone holding the printed invoice/receipt QR. Standalone (no
    // PublicLayout marketing chrome), same pattern as /onboarding.
    path: '/verify/:token',
    element: <VerifyInvoicePage />,
  },
  {
    element: <RequireAuth />,
    children: [
      {
        path: '/scan',
        element: <ScanPage />,
      },
      {
        path: '/app',
        element: <AppLayout />,
        children: [
          { index: true, element: <TodayPage /> },
          { path: 'bookings', element: <BookingsPage /> },
          { path: 'academy', element: <AcademyPage /> },
          { path: 'customers', element: <CustomersPage /> },
          { path: 'billing', element: <BillingPage /> },
          { path: 'cash-shift', element: <CashShiftPage /> },
          { path: 'subscription', element: <SubscriptionPage /> },
          { path: 'outstanding', element: <OutstandingPage /> },
          { path: 'reports', element: <ReportsPage /> },
          // P1-7: /app/club's content moved into the new Settings hub
          // originally, then further split in the IA restructuring
          // (Phase 5) -- kept as a redirect for any stale links/
          // bookmarks rather than a dead route.
          { path: 'club', element: <Navigate to="/app/settings" replace /> },
          { path: 'staff', element: <StaffPage /> },
          // IA restructuring (Phase 5): branches + fields/hours/pricing
          // extracted out of Settings into their own domain -- confirmed
          // in MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md as real
          // operational infrastructure management, not settings.
          { path: 'fields', element: <BranchesFieldsPage /> },
          // IA restructuring (Phase 5): audit log extracted out of
          // Settings into its own route -- a monitoring/security
          // concern, not settings. AuditLogPage already existed as a
          // standalone wrapper but had no registered route (confirmed
          // dead code in the audit) -- this is that route.
          { path: 'audit-log', element: <AuditLogPage /> },
          // IA restructuring (Phase 8): WhatsApp promoted to an
          // independent top-level module per the directive's explicit
          // instruction -- 4 tabs (Overview/Activity/Connection/
          // Settings), no longer buried inside Settings' "الإشعارات".
          { path: 'whatsapp', element: <WhatsAppPage /> },
          // P1-7 (critical usability fix pass, 2026-08-16), narrowed in
          // IA restructuring Phase 5: "الإعدادات" now covers only true
          // club-identity/configuration settings -- club identity,
          // academy activation policy, payment method configuration,
          // and a platform-subscription summary. Branches/fields, staff
          // management, WhatsApp, and the audit log all moved to their
          // own destinations (see MAL3ABY_INFORMATION_ARCHITECTURE.md
          // §2's Settings reallocation table).
          { path: 'settings', element: <SettingsPage /> },
          { path: 'more', element: <MorePage /> },
        ],
      },
    ],
  },
  {
    element: <RequirePortalAuth />,
    children: [
      {
        path: '/portal',
        element: <PortalLayout />,
        children: [
          { index: true, element: <PortalRoot /> },
          { path: 'academy', element: <PortalAcademyPage /> },
          { path: 'payments', element: <PortalPaymentsPage /> },
          { path: 'qr', element: <PortalQrPage /> },
          { path: 'profile', element: <PortalProfilePage /> },
        ],
      },
    ],
  },
  {
    element: <RequirePlatformOwner />,
    children: [
      {
        path: '/platform',
        element: <PlatformLayout />,
        children: [
          { index: true, element: <PlatformOverviewPage /> },
          { path: 'clubs', element: <PlatformClubsPage /> },
          { path: 'clubs/:clubId', element: <PlatformClubDetailPage /> },
          { path: 'owners', element: <PlatformOwnersPage /> },
          // IA restructuring (Phase 4): these 3 were permanent
          // placeholder dead-ends (see removed pages.tsx exports) --
          // their promised content already lives on real screens.
          // Redirected instead of rendering an inert page, same
          // pattern as the pre-existing /app/club -> /app/settings
          // redirect above. Sidebar items pointing here are removed
          // (PlatformLayout.tsx) -- these routes exist only to catch
          // stale bookmarks/deep links per the "preserve deep links"
          // migration rule.
          { path: 'subscriptions', element: <Navigate to="/platform/clubs" replace /> },
          { path: 'plans', element: <PlatformPlansPage /> },
          { path: 'payments', element: <Navigate to="/platform/reports" replace /> },
          { path: 'renewals', element: <Navigate to="/platform/alerts" replace /> },
          { path: 'trials', element: <PlatformTrialsPage /> },
          { path: 'leads', element: <PlatformLeadsPage /> },
          { path: 'reports', element: <PlatformReportsPage /> },
          { path: 'alerts', element: <PlatformAlertsPage /> },
          { path: 'audit', element: <PlatformAuditPage /> },
          { path: 'settings', element: <PlatformSettingsPage /> },
        ],
      },
    ],
  },
])
