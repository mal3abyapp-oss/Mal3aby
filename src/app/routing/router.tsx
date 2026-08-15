import { createBrowserRouter } from 'react-router-dom'
import { PublicLayout } from '@/app/layouts/PublicLayout'
import { AppLayout } from '@/app/layouts/AppLayout'
import { PlatformLayout } from '@/app/layouts/PlatformLayout'

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
import { SettingsPage } from '@/features/settings/SettingsPage'
import { AuditLogPage } from '@/features/settings/AuditLogPage'
import { ScanPage } from '@/features/scanner/ScanPage'

import {
  PlatformOverviewPage,
  PlatformClubsPage,
  PlatformSubscriptionsPage,
  PlatformPlansPage,
  PlatformPaymentsPage,
  PlatformRenewalsPage,
  PlatformTrialsPage,
  PlatformLeadsPage,
  PlatformReportsPage,
  PlatformAlertsPage,
  PlatformAuditPage,
  PlatformSettingsPage,
} from '@/features/platform/pages'

// Route guards (auth required / permission checks) land in Phase 2/3d —
// see docs/SCREEN_MAP.md#route-guards and
// docs/IMPLEMENTATION_PLAN.md Phase 1's Functional Gate: "no route guards
// yet." This file is the route *shape*, matching the confirmed route map.
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
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/audit', element: <AuditLogPage /> },
    ],
  },
  {
    path: '/platform',
    element: <PlatformLayout />,
    children: [
      { index: true, element: <PlatformOverviewPage /> },
      { path: 'clubs', element: <PlatformClubsPage /> },
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
])
