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

import { TodayPage } from '@/features/dashboard/TodayPage'
import { MorePage } from '@/features/dashboard/MorePage'
import { BookingsPage } from '@/features/bookings/BookingsPage'
import { AcademyPage } from '@/features/academy/AcademyPage'
import { CustomersPage } from '@/features/customers/CustomersPage'
import { BillingPage } from '@/features/billing/BillingPage'
import { SubscriptionPage } from '@/features/billing/SubscriptionPage'
import { OutstandingPage } from '@/features/billing/OutstandingPage'
import { ReportsPage } from '@/features/reports/ReportsPage'
import { StaffPage } from '@/features/staff/StaffPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { ScanPage } from '@/features/scanner/ScanPage'

import { PortalRoot } from '@/features/portal/PortalRoot'
import { PortalAcademyPage } from '@/features/portal/PortalAcademyPage'
import { PortalQrPage } from '@/features/portal/PortalQrPage'
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
import {
  PlatformSubscriptionsPage,
  PlatformPaymentsPage,
  PlatformRenewalsPage,
  PlatformSettingsPage,
} from '@/features/platform/pages'

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
          { path: 'subscription', element: <SubscriptionPage /> },
          { path: 'outstanding', element: <OutstandingPage /> },
          { path: 'reports', element: <ReportsPage /> },
          // P1-7: /app/club's content moved into the new Settings hub
          // (club identity, branches, and fields/hours/pricing all live
          // under /app/settings now) -- kept as a redirect for any stale
          // links/bookmarks rather than a dead route.
          { path: 'club', element: <Navigate to="/app/settings" replace /> },
          { path: 'staff', element: <StaffPage /> },
          // P1-7 (critical usability fix pass, 2026-08-16): "الإعدادات"
          // previously routed straight to the Audit Log Viewer alone,
          // with club/branch/fields/subscription settings scattered
          // elsewhere with no discoverable structure. Now a real
          // settings hub (SettingsPage) with clear sections: club,
          // branches, booking settings (fields/hours/pricing), academy
          // settings, a link out to staff, platform subscription, and
          // (owner/manager only) the audit log.
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
          { path: 'subscriptions', element: <PlatformSubscriptionsPage /> },
          { path: 'plans', element: <PlatformPlansPage /> },
          { path: 'payments', element: <PlatformPaymentsPage /> },
          { path: 'renewals', element: <PlatformRenewalsPage /> },
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
