import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import { PublicLayout } from '@/app/layouts/PublicLayout'
import { AppLayout } from '@/app/layouts/AppLayout'
import { PlatformLayout } from '@/app/layouts/PlatformLayout'
import { PortalLayout } from '@/app/layouts/PortalLayout'
import { RequireAuth, RequireGuest, RequireNavDomain, RequirePlatformOwner, RequirePortalAuth, RequirePortalCustomer, RequireShopModule, RequireAcademyModule, RequireFieldsModule, RequireClubMembershipModule } from '@/app/routing/RequireAuth'
import { RedirectWithSearch } from '@/app/routing/RedirectWithSearch'
import { RouteLoadingFallback } from '@/app/routing/RouteLoadingFallback'

// Controlled-scale readiness SP-004: the production bundle was a single
// ~2MB (535kB gzip) JS chunk -- every role's entire feature set (Finance,
// Reports, Academy, Staff 360, Platform Owner, Settings...) downloaded and
// parsed on first load regardless of which one role/page a given visit
// actually needs. Route-level code splitting via React.lazy() below turns
// each feature page into its own chunk, fetched only when its route is
// actually visited. The small, always-needed public/marketing/auth pages
// stay eagerly imported (below) since splitting a handful of tiny
// components buys nothing and would only add request round-trips to the
// very first thing every visitor sees. Every layout that renders one of
// these lazy routes already wraps its <Outlet /> in a <Suspense> boundary
// (see AppLayout.tsx, PortalLayout.tsx, PlatformLayout.tsx) with a small,
// non-decorative loading fallback (RouteLoadingFallback.tsx).
const OnboardingPage = lazy(() => import('@/features/onboarding/OnboardingPage').then((m) => ({ default: m.OnboardingPage })))
const VerifyInvoicePage = lazy(() => import('@/features/verify/VerifyInvoicePage').then((m) => ({ default: m.VerifyInvoicePage })))
const SecureBookingPage = lazy(() => import('@/features/verify/SecureBookingPage').then((m) => ({ default: m.SecureBookingPage })))
const PublicClubBookingPage = lazy(() => import('@/features/public-booking/PublicClubBookingPage').then((m) => ({ default: m.PublicClubBookingPage })))
const ActivateAccountPage = lazy(() => import('@/features/portal/ActivateAccountPage').then((m) => ({ default: m.ActivateAccountPage })))

const TodayPage = lazy(() => import('@/features/dashboard/TodayPage').then((m) => ({ default: m.TodayPage })))
const MorePage = lazy(() => import('@/features/dashboard/MorePage').then((m) => ({ default: m.MorePage })))
const BookingsPage = lazy(() => import('@/features/bookings/BookingsPage').then((m) => ({ default: m.BookingsPage })))
const AcademyPage = lazy(() => import('@/features/academy/AcademyPage').then((m) => ({ default: m.AcademyPage })))
const MembershipsPage = lazy(() => import('@/features/memberships/MembershipsPage').then((m) => ({ default: m.MembershipsPage })))
const Player360Page = lazy(() => import('@/features/academy/Player360Page').then((m) => ({ default: m.Player360Page })))
const CustomersPage = lazy(() => import('@/features/customers/CustomersPage').then((m) => ({ default: m.CustomersPage })))
const Customer360Page = lazy(() => import('@/features/customers/Customer360Page').then((m) => ({ default: m.Customer360Page })))
const CustomerDuplicatesPage = lazy(() => import('@/features/customers/CustomerDuplicatesPage').then((m) => ({ default: m.CustomerDuplicatesPage })))
const SubscriptionPage = lazy(() => import('@/features/billing/SubscriptionPage').then((m) => ({ default: m.SubscriptionPage })))
const ShopLayout = lazy(() => import('@/features/shop/ShopLayout').then((m) => ({ default: m.ShopLayout })))
const ShopDashboardPage = lazy(() => import('@/features/shop/ShopDashboardPage').then((m) => ({ default: m.ShopDashboardPage })))
const ShopPOSPage = lazy(() => import('@/features/shop/ShopPOSPage').then((m) => ({ default: m.ShopPOSPage })))
const ShopProductsPage = lazy(() => import('@/features/shop/ShopProductsPage').then((m) => ({ default: m.ShopProductsPage })))
const ShopInventoryPage = lazy(() => import('@/features/shop/ShopInventoryPage').then((m) => ({ default: m.ShopInventoryPage })))
const ShopStockCountPage = lazy(() => import('@/features/shop/ShopStockCountPage').then((m) => ({ default: m.ShopStockCountPage })))
const ShopSalesPage = lazy(() => import('@/features/shop/ShopSalesPage').then((m) => ({ default: m.ShopSalesPage })))
const ShopSettingsPage = lazy(() => import('@/features/shop/ShopSettingsPage').then((m) => ({ default: m.ShopSettingsPage })))
// COMMERCE PRO C7: ReportShopPage.tsx (top-products/inventory-summary
// only) replaced as the /app/reports/shop route target by
// ShopReportsPage.tsx, the full 16-report suite hub (Section 5, Phase
// C7) -- same route, same nav entry point, richer content. The old
// component file is left in place (still imports cleanly, no dead
// import elsewhere) rather than deleted, in case a narrower rollback
// is ever needed; it is simply no longer wired into the router.
const ShopReportsPage = lazy(() => import('@/features/shop/ShopReportsPage').then((m) => ({ default: m.ShopReportsPage })))
const FinanceLayout = lazy(() => import('@/features/finance/FinanceLayout').then((m) => ({ default: m.FinanceLayout })))
const FinanceOverviewPage = lazy(() => import('@/features/finance/FinanceOverviewPage').then((m) => ({ default: m.FinanceOverviewPage })))
const FinancePaymentsPage = lazy(() => import('@/features/finance/FinancePaymentsPage').then((m) => ({ default: m.FinancePaymentsPage })))
const FinanceInvoicesPage = lazy(() => import('@/features/finance/FinanceInvoicesPage').then((m) => ({ default: m.FinanceInvoicesPage })))
const FinanceCashPage = lazy(() => import('@/features/finance/FinanceCashPage').then((m) => ({ default: m.FinanceCashPage })))
const FinanceExpensesPage = lazy(() => import('@/features/finance/FinanceExpensesPage').then((m) => ({ default: m.FinanceExpensesPage })))
const FinanceReportsPage = lazy(() => import('@/features/finance/FinanceReportsPage').then((m) => ({ default: m.FinanceReportsPage })))
const GatewayReturnPage = lazy(() => import('@/features/finance/GatewayReturnPage').then((m) => ({ default: m.GatewayReturnPage })))
const ReportsOverviewPage = lazy(() => import('@/features/reports/ReportsOverviewPage').then((m) => ({ default: m.ReportsOverviewPage })))
const ReportBookingsPage = lazy(() => import('@/features/reports/ReportBookingsPage').then((m) => ({ default: m.ReportBookingsPage })))
const ReportOccupancyPage = lazy(() => import('@/features/reports/ReportOccupancyPage').then((m) => ({ default: m.ReportOccupancyPage })))
const ReportRevenuePage = lazy(() => import('@/features/reports/ReportRevenuePage').then((m) => ({ default: m.ReportRevenuePage })))
const ReportCollectionsPage = lazy(() => import('@/features/reports/ReportCollectionsPage').then((m) => ({ default: m.ReportCollectionsPage })))
const ReportPaymentMethodsPage = lazy(() => import('@/features/reports/ReportPaymentMethodsPage').then((m) => ({ default: m.ReportPaymentMethodsPage })))
const ReportExceptionsPage = lazy(() => import('@/features/reports/ReportExceptionsPage').then((m) => ({ default: m.ReportExceptionsPage })))
const ReportOfficialReceiptsPage = lazy(() => import('@/features/reports/ReportOfficialReceiptsPage').then((m) => ({ default: m.ReportOfficialReceiptsPage })))
const ReportReconciliationPage = lazy(() => import('@/features/reports/ReportReconciliationPage').then((m) => ({ default: m.ReportReconciliationPage })))
const ReportGatewayHealthPage = lazy(() => import('@/features/reports/ReportGatewayHealthPage').then((m) => ({ default: m.ReportGatewayHealthPage })))
const ReportEmployeeLiabilityPage = lazy(() => import('@/features/reports/ReportEmployeeLiabilityPage').then((m) => ({ default: m.ReportEmployeeLiabilityPage })))
const ReportAcademyPage = lazy(() => import('@/features/reports/ReportAcademyPage').then((m) => ({ default: m.ReportAcademyPage })))
const ReportCustomersPage = lazy(() => import('@/features/reports/ReportCustomersPage').then((m) => ({ default: m.ReportCustomersPage })))
const StaffPage = lazy(() => import('@/features/staff/StaffPage').then((m) => ({ default: m.StaffPage })))
const Employee360Page = lazy(() => import('@/features/staff/Employee360Page').then((m) => ({ default: m.Employee360Page })))
const RolesPage = lazy(() => import('@/features/staff/RolesPage').then((m) => ({ default: m.RolesPage })))
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const BranchesFieldsPage = lazy(() => import('@/features/clubs/BranchesFieldsPage').then((m) => ({ default: m.BranchesFieldsPage })))
const AuditLogPage = lazy(() => import('@/features/settings/AuditLogPage').then((m) => ({ default: m.AuditLogPage })))
const WhatsAppPage = lazy(() => import('@/features/whatsapp/WhatsAppPage').then((m) => ({ default: m.WhatsAppPage })))
const ScanPage = lazy(() => import('@/features/scanner/ScanPage').then((m) => ({ default: m.ScanPage })))
// "شرح الأداة" help/how-to-use guide (2026-08-29 request): written
// walkthrough + real screenshots per module, see HelpGuidePage's own
// header comment.
const HelpGuidePage = lazy(() => import('@/features/help/HelpGuidePage').then((m) => ({ default: m.HelpGuidePage })))

const PortalRoot = lazy(() => import('@/features/portal/PortalRoot').then((m) => ({ default: m.PortalRoot })))
const PortalBookingsPage = lazy(() => import('@/features/portal/PortalBookingsPage').then((m) => ({ default: m.PortalBookingsPage })))
const PortalAcademyPage = lazy(() => import('@/features/portal/PortalAcademyPage').then((m) => ({ default: m.PortalAcademyPage })))
const PortalMembershipsPage = lazy(() => import('@/features/portal/PortalMembershipsPage').then((m) => ({ default: m.PortalMembershipsPage })))
const PortalQrPage = lazy(() => import('@/features/portal/PortalQrPage').then((m) => ({ default: m.PortalQrPage })))
const PortalPaymentsPage = lazy(() => import('@/features/portal/PortalPaymentsPage').then((m) => ({ default: m.PortalPaymentsPage })))
const PortalProfilePage = lazy(() => import('@/features/portal/PortalProfilePage').then((m) => ({ default: m.PortalProfilePage })))

const PlatformOverviewPage = lazy(() => import('@/features/platform/PlatformOverviewPage').then((m) => ({ default: m.PlatformOverviewPage })))
const PlatformClubsPage = lazy(() => import('@/features/platform/PlatformClubsPage').then((m) => ({ default: m.PlatformClubsPage })))
const PlatformClubDetailPage = lazy(() => import('@/features/platform/PlatformClubDetailPage').then((m) => ({ default: m.PlatformClubDetailPage })))
const PlatformOwnersPage = lazy(() => import('@/features/platform/PlatformOwnersPage').then((m) => ({ default: m.PlatformOwnersPage })))
const PlatformPlansPage = lazy(() => import('@/features/platform/PlatformPlansPage').then((m) => ({ default: m.PlatformPlansPage })))
const PlatformTrialsPage = lazy(() => import('@/features/platform/PlatformTrialsPage').then((m) => ({ default: m.PlatformTrialsPage })))
const PlatformLeadsPage = lazy(() => import('@/features/platform/PlatformLeadsPage').then((m) => ({ default: m.PlatformLeadsPage })))
const PlatformReportsPage = lazy(() => import('@/features/platform/PlatformReportsPage').then((m) => ({ default: m.PlatformReportsPage })))
const PlatformAlertsPage = lazy(() => import('@/features/platform/PlatformAlertsPage').then((m) => ({ default: m.PlatformAlertsPage })))
const PlatformAuditPage = lazy(() => import('@/features/platform/PlatformAuditPage').then((m) => ({ default: m.PlatformAuditPage })))
const PlatformSettingsPage = lazy(() => import('@/features/platform/PlatformSettingsPage').then((m) => ({ default: m.PlatformSettingsPage })))
// PLATFORM STAFF + PLATFORM ROLES & PERMISSIONS (2026-08-26)
const PlatformStaffPage = lazy(() => import('@/features/platform/PlatformStaffPage').then((m) => ({ default: m.PlatformStaffPage })))
const PlatformRolesPage = lazy(() => import('@/features/platform/PlatformRolesPage').then((m) => ({ default: m.PlatformRolesPage })))
// PLATFORM OWNER AUTONOMOUS COMPLETION -- Phase E (2026-08-29)
const PlatformSupportHistoryPage = lazy(() => import('@/features/platform/PlatformSupportHistoryPage').then((m) => ({ default: m.PlatformSupportHistoryPage })))

// Small, always-needed public/marketing/auth pages -- eagerly imported.
// Splitting these would add request round-trips to the very first thing
// every visitor sees for negligible bundle-size benefit.
import { HomePage } from '@/features/public-site/HomePage'
import { PricingPage } from '@/features/public-site/PricingPage'
import { ContactPage } from '@/features/public-site/ContactPage'
import { TermsPage } from '@/features/public-site/TermsPage'
import { PrivacyPage } from '@/features/public-site/PrivacyPage'

import { LoginPage } from '@/features/auth/LoginPage'
import { SignupPage } from '@/features/auth/SignupPage'
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage'
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage'
import { PortalLoginPage } from '@/features/auth/PortalLoginPage'

// Route guards: RequireAuth gates /app (any active membership),
// RequirePlatformOwner gates /platform (a platform_owner-role membership).
// Client-side only — the real boundary is always server-side RLS
// (docs/SECURITY_ANTI_FRAUD.md). See docs/SCREEN_MAP.md#route-guards.
export const router = createBrowserRouter([
  {
    element: <PublicLayout />,
    children: [
      // "/", "/login", "/signup" are guest-only in intent: an already
      // authenticated visitor landing here (a bookmark, a re-typed URL,
      // a stale open tab) must be routed to their real destination, not
      // shown marketing/auth chrome that reads as "you're logged out"
      // -- see RequireGuest's own header comment for the live bug this
      // closes. "/forgot-password"/"/reset-password" are deliberately
      // NOT wrapped: a logged-in user legitimately resetting their own
      // password must still be able to reach that flow.
      {
        element: <RequireGuest />,
        children: [
          { path: '/', element: <HomePage /> },
          { path: '/login', element: <LoginPage /> },
          { path: '/signup', element: <SignupPage /> },
          { path: '/portal/login', element: <PortalLoginPage /> },
        ],
      },
      { path: '/pricing', element: <PricingPage /> },
      { path: '/contact', element: <ContactPage /> },
      { path: '/terms', element: <TermsPage /> },
      { path: '/privacy', element: <PrivacyPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password', element: <ResetPasswordPage /> },
    ],
  },
  {
    path: '/onboarding',
    element: <Suspense fallback={<RouteLoadingFallback />}><OnboardingPage /></Suspense>,
  },
  {
    // Task #86: public invoice verification -- no auth guard, reachable
    // by anyone holding the printed invoice/receipt QR. Standalone (no
    // PublicLayout marketing chrome), same pattern as /onboarding.
    path: '/verify/:token',
    element: <Suspense fallback={<RouteLoadingFallback />}><VerifyInvoicePage /></Suspense>,
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
    element: <Suspense fallback={<RouteLoadingFallback />}><SecureBookingPage /></Suspense>,
  },
  {
    // Public Club Booking System (directive Sections 42-53): every
    // club's public, shareable booking page -- no auth guard, mobile-
    // first, reachable by anyone holding the link/QR/printed poster.
    // Standalone, same pattern as /qr/:token and /verify/:token.
    path: '/c/:slug',
    element: <Suspense fallback={<RouteLoadingFallback />}><PublicClubBookingPage /></Suspense>,
  },
  {
    // CUSTOMER ACCOUNT / CLUB PORTAL -- ZERO-COST ACTIVATION: the
    // secure account-activation entrypoint from a WhatsApp booking
    // message's CTA. No auth guard, standalone, same pattern as
    // /qr/:token and /verify/:token -- a distinct route so an
    // activation token is never accidentally interchangeable with a
    // booking-QR or invoice-verify token at the routing layer.
    path: '/activate/:token',
    element: <Suspense fallback={<RouteLoadingFallback />}><ActivateAccountPage /></Suspense>,
  },
  {
    element: <RequireAuth />,
    children: [
      {
        path: '/scan',
        element: <RequireNavDomain domain="scan"><Suspense fallback={<RouteLoadingFallback />}><ScanPage /></Suspense></RequireNavDomain>,
      },
      {
        path: '/app',
        element: <AppLayout />,
        children: [
          { index: true, element: <RequireNavDomain domain="today"><TodayPage /></RequireNavDomain> },
          // PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 3 (P2): same
          // RequireShopModule pattern (module-active friendly "not
          // available" state), now extended to Fields/Academy/
          // Membership routes now that Phase 1/2 gave those modules
          // real RPC-layer enforcement too.
          { path: 'bookings', element: <RequireNavDomain domain="bookings"><RequireFieldsModule><BookingsPage /></RequireFieldsModule></RequireNavDomain> },
          { path: 'academy', element: <RequireNavDomain domain="academy"><RequireAcademyModule><AcademyPage /></RequireAcademyModule></RequireNavDomain> },
          { path: 'memberships', element: <RequireNavDomain domain="memberships"><RequireClubMembershipModule><MembershipsPage /></RequireClubMembershipModule></RequireNavDomain> },
          // Academy Player/Guardian/Customer integrity closure: the
          // canonical Player 360 detail/edit page, same pattern as
          // Customer 360 (/app/customers/:customerId) and Staff 360
          // (/app/staff/:membershipId). Static "academy" route above
          // this, so the dynamic :playerId route never shadows it.
          { path: 'academy/players/:playerId', element: <RequireNavDomain domain="academy"><Player360Page /></RequireNavDomain> },
          { path: 'customers', element: <RequireNavDomain domain="customers"><CustomersPage /></RequireNavDomain> },
          // Static route must come before the :customerId dynamic
          // route below, or "duplicates" would itself be matched and
          // passed to Customer360Page as a (nonexistent) customer id.
          { path: 'customers/duplicates', element: <RequireNavDomain domain="customers"><CustomerDuplicatesPage /></RequireNavDomain> },
          // Customer 360 directive: "ONE CUSTOMER, ONE SOURCE OF
          // TRUTH" -- the single identity page every cross-module
          // "open customer" link (booking, academy, finance, whatsapp)
          // now points at, replacing CustomerDetailDialog's scattered
          // read-only summary.
          { path: 'customers/:customerId', element: <RequireNavDomain domain="customers"><Customer360Page /></RequireNavDomain> },
          // Finance IA consolidation directive: every money-related
          // screen now lives under /app/finance as one coherent module
          // (sections 1-84) -- FinanceLayout renders the shared sub-nav,
          // each child is a tab. /app/finance itself is the Overview
          // landing tab (matches the pre-existing /app/reports pattern:
          // ReportsOverviewPage is the index, not a tab among equals).
          {
            path: 'finance',
            element: <RequireNavDomain domain="finance"><FinanceLayout /></RequireNavDomain>,
            children: [
              { index: true, element: <FinanceOverviewPage /> },
              { path: 'payments', element: <FinancePaymentsPage /> },
              { path: 'invoices', element: <FinanceInvoicesPage /> },
              { path: 'cash', element: <FinanceCashPage /> },
              { path: 'expenses', element: <FinanceExpensesPage /> },
              { path: 'reports', element: <FinanceReportsPage /> },
              // MULTI-GATEWAY PAYMENTS (Phase 2, item 1/3/5): the
              // hosted-checkout redirect LANDING route --
              // stripe-create-checkout-session's success_url/cancel_url
              // both point here. Deliberately a FinanceLayout child
              // (not a standalone top-level route) so it inherits the
              // authenticated app shell/session -- the customer or
              // staff member completing checkout already has a Mal3aby
              // session (this project's checkout flow starts from an
              // authenticated invoice view, not an anonymous public
              // link). Contains NO write path to payments/
              // payment_gateway_transactions -- see the component's own
              // header comment.
              { path: 'gateway-return', element: <GatewayReturnPage /> },
            ],
          },
          // Directive section 31/32: old flat finance routes redirect
          // into the new Finance module -- query params (e.g.
          // ?invoice=<id> from Academy's "Collect Payment Now" link,
          // BookingDetailSheet/CustomerDetailDialog deep links) are
          // preserved via RedirectWithSearch so no existing bookmark or
          // in-app link breaks (directive section 32: "test invoice
          // deep link, booking payment link, customer payment link").
          // COMMERCIAL MODULE (2026-08-26) -- ShopLayout renders the
          // shared sub-nav + RequireShopModule (module-active gate,
          // separate from the shop.view permission gate applied here at
          // the domain level, matching every other item's pattern).
          {
            path: 'shop',
            element: <RequireNavDomain domain="shop"><ShopLayout /></RequireNavDomain>,
            children: [
              { index: true, element: <ShopPOSPage /> },
              // COMMERCE PRO C6: additional page, not the new index --
              // /app/shop's index stays ShopPOSPage (highest-frequency
              // cashier action). See ShopDashboardPage.tsx's own header
              // comment for the full reasoning.
              { path: 'dashboard', element: <ShopDashboardPage /> },
              { path: 'products', element: <ShopProductsPage /> },
              { path: 'inventory', element: <ShopInventoryPage /> },
              { path: 'stock-count', element: <ShopStockCountPage /> },
              { path: 'sales', element: <ShopSalesPage /> },
              { path: 'settings', element: <ShopSettingsPage /> },
            ],
          },
          { path: 'billing', element: <RedirectWithSearch to="/app/finance/payments" /> },
          { path: 'cash-shift', element: <RedirectWithSearch to="/app/finance/cash" /> },
          { path: 'outstanding', element: <RedirectWithSearch to="/app/finance/payments" /> },
          { path: 'pending-payments', element: <RedirectWithSearch to="/app/finance/payments" /> },
          // Club's own platform-SaaS-subscription status -- unrelated to
          // customer money, kept as its own route (directive doesn't
          // fold platform billing into the customer-money Finance
          // module); linked from Finance Overview and Settings.
          { path: 'subscription', element: <RequireNavDomain domain="settings"><SubscriptionPage /></RequireNavDomain> },
          // Master IA/UX audit (Reports decomposition phase): the old
          // single /app/reports route rendered a 1127-line file with
          // 9 tabs sharing one Tabs.Root -- visual grouping (a prior
          // IA pass) was correctly identified as NOT real
          // decomposition. Split into real routed screens, one per
          // report, each independently bundled/testable/linkable.
          // /app/reports itself is now the Overview/landing screen,
          // not a tab among equals.
          { path: 'reports', element: <RequireNavDomain domain="reports"><ReportsOverviewPage /></RequireNavDomain> },
          { path: 'reports/bookings', element: <RequireNavDomain domain="reports"><ReportBookingsPage /></RequireNavDomain> },
          { path: 'reports/occupancy', element: <RequireNavDomain domain="reports"><ReportOccupancyPage /></RequireNavDomain> },
          { path: 'reports/revenue', element: <RequireNavDomain domain="reports"><ReportRevenuePage /></RequireNavDomain> },
          { path: 'reports/collections', element: <RequireNavDomain domain="reports"><ReportCollectionsPage /></RequireNavDomain> },
          { path: 'reports/payment-methods', element: <RequireNavDomain domain="reports"><ReportPaymentMethodsPage /></RequireNavDomain> },
          { path: 'reports/exceptions', element: <RequireNavDomain domain="reports"><ReportExceptionsPage /></RequireNavDomain> },
          { path: 'reports/official-receipts', element: <RequireNavDomain domain="reports"><ReportOfficialReceiptsPage /></RequireNavDomain> },
          { path: 'reports/reconciliation', element: <RequireNavDomain domain="reports"><ReportReconciliationPage /></RequireNavDomain> },
          { path: 'reports/gateway-health', element: <RequireNavDomain domain="reports"><ReportGatewayHealthPage /></RequireNavDomain> },
          { path: 'reports/employee-liability', element: <RequireNavDomain domain="reports"><ReportEmployeeLiabilityPage /></RequireNavDomain> },
          { path: 'reports/academy', element: <RequireNavDomain domain="reports"><ReportAcademyPage /></RequireNavDomain> },
          { path: 'reports/customers', element: <RequireNavDomain domain="reports"><ReportCustomersPage /></RequireNavDomain> },
          // COMMERCIAL MODULE ARCHITECTURE (2026-08-26) -- gated on
          // BOTH 'reports' (report.view) and shop being a real module
          // (RequireShopModule) -- a club without Shop entitled/active
          // should not see a Shop report at all, matching the
          // directive's own "not merely add features" scoping.
          { path: 'reports/shop', element: <RequireNavDomain domain="reports"><RequireShopModule><ShopReportsPage /></RequireShopModule></RequireNavDomain> },
          // P1-7: /app/club's content moved into the new Settings hub
          // originally, then further split in the IA restructuring
          // (Phase 5) -- kept as a redirect for any stale links/
          // bookmarks rather than a dead route.
          { path: 'club', element: <Navigate to="/app/settings" replace /> },
          { path: 'staff', element: <RequireNavDomain domain="staff"><StaffPage /></RequireNavDomain> },
          // STAFF ACCESS CONTROL & CUSTOM ROLES (2026-08-25): static
          // "staff/roles" route, same reason it sits above the dynamic
          // :membershipId route below -- must not be shadowed by it.
          // roles.view is checked again inside RolesPage's own RPCs
          // (list_club_roles/get_club_role_permissions) -- this
          // RequireNavDomain is UX-only, same disclosure as every guard
          // in this file.
          { path: 'staff/roles', element: <RequireNavDomain domain="staff"><RolesPage /></RequireNavDomain> },
          // Staff 360 directive: one Employee 360 profile route, same
          // pattern as Customer 360 -- static "staff" list route above
          // this, so the dynamic :membershipId route below never
          // shadows it.
          { path: 'staff/:membershipId', element: <RequireNavDomain domain="staff"><Employee360Page /></RequireNavDomain> },
          // IA restructuring (Phase 5): branches + fields/hours/pricing
          // extracted out of Settings into their own domain -- confirmed
          // in MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md as real
          // operational infrastructure management, not settings.
          { path: 'fields', element: <RequireNavDomain domain="settings"><BranchesFieldsPage /></RequireNavDomain> },
          // IA restructuring (Phase 5): audit log extracted out of
          // Settings into its own route -- a monitoring/security
          // concern, not settings. AuditLogPage already existed as a
          // standalone wrapper but had no registered route (confirmed
          // dead code in the audit) -- this is that route.
          { path: 'audit-log', element: <RequireNavDomain domain="settings"><AuditLogPage /></RequireNavDomain> },
          // IA restructuring (Phase 8): WhatsApp promoted to an
          // independent top-level module per the directive's explicit
          // instruction -- 4 tabs (Overview/Activity/Connection/
          // Settings), no longer buried inside Settings' "الإشعارات".
          { path: 'whatsapp', element: <RequireNavDomain domain="whatsapp"><WhatsAppPage /></RequireNavDomain> },
          // P1-7 (critical usability fix pass, 2026-08-16), narrowed in
          // IA restructuring Phase 5: "الإعدادات" now covers only true
          // club-identity/configuration settings -- club identity,
          // academy activation policy, payment method configuration,
          // and a platform-subscription summary. Branches/fields, staff
          // management, WhatsApp, and the audit log all moved to their
          // own destinations (see MAL3ABY_INFORMATION_ARCHITECTURE.md
          // §2's Settings reallocation table).
          { path: 'settings', element: <RequireNavDomain domain="settings"><SettingsPage /></RequireNavDomain> },
          // Help guide: no domain gate (reference content, not a data
          // screen) -- same "today" treatment canSeeNavDomain() already
          // gives every authenticated member regardless of role.
          { path: 'help', element: <RequireNavDomain domain="today"><HelpGuidePage /></RequireNavDomain> },
          { path: 'more', element: <RequireNavDomain domain="today"><MorePage /></RequireNavDomain> },
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
          // PERSONA COUNCIL AUDIT (2026-08-25) -- Customer persona P0 fix:
          // every child route (index included) is now wrapped in
          // RequirePortalCustomer, closing the "claim-gate bypass" -- a
          // real, live-reproduced account with a session but no linked
          // customer record used to get a DIFFERENT, misleading "empty"
          // screen on each sub-route instead of the claim prompt, with no
          // path back to it. The prior comment on the sibling routes here
          // (removed) claimed reaching them "already implies a linked
          // customer record exists" -- that was false; RequirePortalAuth
          // only checks session existence. IA restructuring (Phase 10)'s
          // original reasoning for a direct, bookmarkable /portal/bookings
          // URL still holds -- this just closes the gap that reasoning
          // introduced.
          { index: true, element: <RequirePortalCustomer><PortalRoot /></RequirePortalCustomer> },
          { path: 'bookings', element: <RequirePortalCustomer><PortalBookingsPage /></RequirePortalCustomer> },
          { path: 'academy', element: <RequirePortalCustomer><PortalAcademyPage /></RequirePortalCustomer> },
          { path: 'memberships', element: <RequirePortalCustomer><PortalMembershipsPage /></RequirePortalCustomer> },
          { path: 'payments', element: <RequirePortalCustomer><PortalPaymentsPage /></RequirePortalCustomer> },
          { path: 'qr', element: <RequirePortalCustomer><PortalQrPage /></RequirePortalCustomer> },
          { path: 'profile', element: <RequirePortalCustomer><PortalProfilePage /></RequirePortalCustomer> },
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
          { path: 'support-history', element: <PlatformSupportHistoryPage /> },
          { path: 'staff', element: <PlatformStaffPage /> },
          { path: 'roles', element: <PlatformRolesPage /> },
          { path: 'settings', element: <PlatformSettingsPage /> },
        ],
      },
    ],
  },
])
