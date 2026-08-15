import { PlaceholderPage } from '@/components/ui/placeholder-page'

// Subscriptions/Payments/Renewals list views duplicate data already
// reachable via Overview + per-club detail + Reports in V1; Settings has
// no platform-level settings beyond platform_settings (trial/grace
// defaults), not exposed as its own screen. All four are an intentional
// V1 scope decision, not unfinished work — confirmed during the Final
// Release Gate (2026-08-15) that no phase was ever going to build a
// distinct screen here (see docs/SCREEN_MAP.md's own screen table).
export function PlatformSubscriptionsPage() {
  return (
    <PlaceholderPage
      title="الاشتراكات"
      note="البيانات متاحة عبر النظرة العامة وتفاصيل النادي والتقارير — لا توجد شاشة منفصلة في هذا الإصدار"
    />
  )
}
export function PlatformPaymentsPage() {
  return (
    <PlaceholderPage
      title="المدفوعات"
      note="البيانات متاحة عبر تفاصيل النادي والتقارير — لا توجد شاشة منفصلة في هذا الإصدار"
    />
  )
}
export function PlatformRenewalsPage() {
  return (
    <PlaceholderPage
      title="التجديدات"
      note="البيانات متاحة عبر التنبيهات والتقارير — لا توجد شاشة منفصلة في هذا الإصدار"
    />
  )
}
export function PlatformSettingsPage() {
  return (
    <PlaceholderPage
      title="الإعدادات"
      note="لا توجد إعدادات على مستوى المنصة بخلاف مدة التجربة وفترة السماح الافتراضية، وغير مُتاحة كشاشة مستقلة في هذا الإصدار"
    />
  )
}
