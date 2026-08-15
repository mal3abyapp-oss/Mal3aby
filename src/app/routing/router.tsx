import { createBrowserRouter } from 'react-router-dom'
import { PublicLayout } from '@/app/layouts/PublicLayout'
import { AppLayout } from '@/app/layouts/AppLayout'
import { PlatformLayout } from '@/app/layouts/PlatformLayout'
import { RequireAuth, RequirePlatformOwner } from '@/app/routing/RequireAuth'

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
import { BookingsPage } from '@/features/bookings/BookingsPage'
import { AcademyPage } from '@/features/academy/AcademyPage'
import { CustomersPage } from '@/features/customers/CustomersPage'
import { BillingPage } from '@/features/billing/BillingPage'
import { SubscriptionPage } from '@/features/billing/SubscriptionPage'
import { OutstandingPage } from '@/features/billing/OutstandingPage'
import { ReportsPage } from '@/features/reports/ReportsPage'
import { ClubPage } from '@/features/clubs/ClubPage'
import { StaffPage } from '@/features/staff/StaffPage'
import { AuditLogPage } from '@/features/settings/AuditLogPage'
import { ScanPage } from '@/features/scanner/ScanPage'

import { PlatformOverviewPage } from '@/features/platform/PlatformOverviewPage'
import { PlatformClubsPage } from '@/features/platform/PlatformClubsPage'
import { PlatformClubDetailPage } from '@/features/platform/PlatformClubDetailPage'
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
          { path: 'club', element: <ClubPage /> },
          { path: 'staff', element: <StaffPage /> },
          // "الإعدادات" per docs/SCREEN_MAP.md's own screen table (row:
          // "Audit Log Viewer | settings | ... Owner, Manager") -- the
          // club-side Settings nav entry's real V1 content was always the
          // Audit Log Viewer, not a separate general-settings screen (no
          // such screen appears anywhere else in the spec). SettingsPage's
          // placeholder claiming "Phase 5" would build a different screen
          // was stale -- removed in favor of routing directly here.
          { path: 'settings', element: <AuditLogPage /> },
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
