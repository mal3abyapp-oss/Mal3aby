import { PlaceholderPage } from '@/components/ui/placeholder-page'

// Subscriptions/Payments/Renewals list views duplicate data already
// reachable via Overview + per-club detail + Reports in this pass;
// Settings has no platform-level settings beyond platform_settings
// (trial/grace defaults), not yet exposed as its own screen. Kept as
// placeholders — not part of the Exit Gate's required assertions.
export function PlatformSubscriptionsPage() {
  return <PlaceholderPage title="الاشتراكات" phase="Phase 3c" />
}
export function PlatformPaymentsPage() {
  return <PlaceholderPage title="المدفوعات" phase="Phase 3c" />
}
export function PlatformRenewalsPage() {
  return <PlaceholderPage title="التجديدات" phase="Phase 3c" />
}
export function PlatformSettingsPage() {
  return <PlaceholderPage title="الإعدادات" phase="Phase 3c" />
}
