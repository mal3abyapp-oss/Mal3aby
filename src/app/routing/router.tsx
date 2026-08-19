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
import { SecureBookingPage } from '@/features/verify/SecureBookingPage'
import { PublicClubBookingPage } from '@/features/public-booking/PublicClubBookingPage'

import { TodayPage } from '@/features/dashboard/TodayPage'
import { MorePage } from '@/features/dashboard/MorePage'
import { BookingsPage } from '@/features/bookings/BookingsPage'
import { AcademyPage } from '@/features/academy/AcademyPage'
import { CustomersPage } from '@/features/customers/CustomersPage'
import { BillingPage } from '@/features/billing/BillingPage'
import { CashShiftPage } from '@/features/billing/CashShiftPage'
import { SubscriptionPage } from '@/features/billing/SubscriptionPage'
import { OutstandingPage } from '@/features/billing/OutstandingPage'
import { PendingPaymentsPage } from '@/features/billing/PendingPaymentsPage'
import { ReportsOverviewPage } from '@/features/reports/ReportsOverviewPage'
import { ReportBookingsPage } from '@/features/reports/ReportBookingsPage'
import { ReportOccupancyPage } from '@/features/reports/ReportOccupancyPage'
import { ReportRevenuePage } from '@/features/reports/ReportRevenuePage'
import { ReportCollectionsPage } from '@/features/reports/ReportCollectionsPage'
import { ReportPaymentMethodsPage } from '@/features/reports/ReportPaymentMethodsPage'
import { ReportExceptionsPage } from '@/features/reports/ReportExceptionsPage'
import { ReportOfficialReceiptsPage } from '@/features/reports/ReportOfficialReceiptsPage'
import { ReportAcademyPage } from '@/features/reports/ReportAcademyPage'
import { ReportCustomersPage } from '@/features/reports/ReportCustomersPage'
import { StaffPage } from '@/features/staff/StaffPage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { BranchesFieldsPage } from '@/features/clubs/BranchesFieldsPage'
import { AuditLogPage } from '@/features/settings/AuditLogPage'
import { WhatsAppPage } from '@/features/whatsapp/WhatsAppPage'
import { ScanPage } from '@/features/scanner/ScanPage'

import { PortalRoot } from '@/features/portal/PortalRoot'
import { PortalBookingsPage } from '@/features/portal/PortalBookingsPage'
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
    // Secure Booking Page (directive Sections 28-32): the PRIMARY
    // customer-facing WhatsApp UX -- Club, Field, Sport, Date, Time,
    // booking reference, status, payment summary, and the attendance
    // QR (full-screen option), all from one opaque token. Supersedes
    // the old BookingQrVerifyPage (attendance-QR status card only).
    // No auth guard, reachable by anyone holding the WhatsApp link.
    // Standalone, same pattern as /verify/:token. Distinct route (not
    // /verify/:token) so an invoice token and a booking-QR token are
    // never accidentally interchangeable at the routing layer even
    // though both are opaque hex strings.
    path: '/qr/:token',
    element: <SecureBookingPage />,
  },
  {
    // Public Club Booking System (directive Sections 42-53): every
    // club's public, shareable booking page -- no auth guard, mobile-
    // first, reachable by anyone holding the link/QR/printed poster.
    // Standalone, same pattern as /qr/:token and /verify/:token.
    path: '/c/:slug',
    element: <PublicClubBookingPage />,
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
          { path: 'pending-payments', element: <PendingPaymentsPage /> },
          // Master IA/UX audit (Reports decomposition phase): the old
          // single /app/reports route rendered a 1127-line file with
          // 9 tabs sharing one Tabs.Root -- visual grouping (a prior
          // IA pass) was correctly identified as NOT real
          // decomposition. Split into real routed screens, one per
          // report, each independently bundled/testable/linkable.
          // /app/reports itself is now the Overview/landing screen,
          // not a tab among equals.
          { path: 'reports', element: <ReportsOverviewPage /> },
          { path: 'reports/bookings', element: <ReportBookingsPage /> },
          { path: 'reports/occupancy', element: <ReportOccupancyPage /> },
          { path: 'reports/revenue', element: <ReportRevenuePage /> },
          { path: 'reports/collections', element: <ReportCollectionsPage /> },
          { path: 'reports/payment-methods', element: <ReportPaymentMethodsPage /> },
          { path: 'reports/exceptions', element: <ReportExceptionsPage /> },
          { path: 'reports/official-receipts', element: <ReportOfficialReceiptsPage /> },
          { path: 'reports/academy', element: <ReportAcademyPage /> },
          { path: 'reports/customers', element: <ReportCustomersPage /> },
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
          // IA restructuring (Phase 10): "حجوزاتي" only ever rendered
          // inline at the claim-gated index route (via PortalRoot) --
          // confirmed in the audit as a real gap: no direct, bookmarkable
          // /portal/bookings URL existed even though the sidebar nav item
          // pointed conceptually at "my bookings" as its own section, not
          // just "whatever the index happens to show". Deep links from
          // QR/payments cross-links (added this phase) need a stable
          // target independent of the claim-gate logic living in
          // PortalRoot -- this route bypasses that gate entirely since
          // reaching it at all requires RequirePortalAuth, which already
          // implies a linked customer record exists.
          { path: 'bookings', element: <PortalBookingsPage /> },
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
