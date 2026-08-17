// Shared audit-log label maps -- IA restructuring (Phase 3, shared
// navigation foundation): the club-side AuditLogPage already had a
// good ACTION_LABELS/ENTITY_LABELS mapping (Gate 13 #60), but it only
// covered club-tier actions -- the Platform Owner tier's audit screens
// (PlatformAuditPage, PlatformClubDetailPage's audit tab) rendered
// r.action/r.entity_type completely raw (confirmed live via
// MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md's Platform Owner findings:
// "raw action and entity_type values rendered directly"). Centralizing
// here (not duplicating a second map in platform/labels.ts) so both
// tiers share exactly one vocabulary for the same audit_logs.action
// values -- a "استرجاع دفعة" (refund) reads the same word whether a
// club owner or the platform owner is looking at it.
//
// Enumerated from every real write_audit_log()/perform write_audit_log
// call site across every migration (grepped, not guessed) plus the
// live database's actual distinct action/entity_type values (24
// actions, 19 entity_type spellings including some inconsistent
// singular/plural pairs like 'booking'/'bookings' and
// 'invoice'/'invoices' -- both spellings mapped to the same label
// rather than normalizing the underlying data, which is out of scope
// for an IA pass).

export const ACTION_LABELS: Record<string, string> = {
  // Club-tier (originally in AuditLogPage.tsx, Gate 13 #60)
  'booking.create': 'إنشاء حجز',
  'booking.check_in': 'تسجيل حضور حجز',
  'booking.discount.apply': 'تطبيق خصم على حجز',
  'booking.auto_confirmed_on_full_payment': 'تأكيد حجز تلقائيًا عند اكتمال الدفع',
  cancel_booking: 'إلغاء حجز',
  'field_block.create': 'حجب فترة على ملعب',
  'invoice.issue': 'إصدار فاتورة',
  void_invoice: 'إلغاء فاتورة',
  'payment.record': 'تسجيل دفعة',
  create_refund: 'استرجاع دفعة',
  'payment.refund': 'استرجاع دفعة',
  'payment.reconciliation_confirmed': 'تأكيد تسوية دفعات',
  'manual_payment_claim.verify': 'مراجعة طلب دفع يدوي',
  'subscription.activate': 'تفعيل اشتراك أكاديمية',
  'subscription.cancel': 'إلغاء اشتراك أكاديمية',
  'subscription.freeze': 'تجميد اشتراك أكاديمية',
  'subscription.unfreeze': 'إلغاء تجميد اشتراك أكاديمية',
  'customer.photo.approve': 'الموافقة على تغيير صورة',
  'customer.photo.reject': 'رفض تغيير صورة',
  'customer.self_service_claim': 'ربط حساب عميل تلقائيًا',
  'cash_shift.open': 'فتح وردية نقدية',
  'cash_shift.close': 'إغلاق وردية نقدية',
  'whatsapp.connect_requested': 'طلب ربط واتساب',
  'whatsapp.disconnect_requested': 'طلب قطع اتصال واتساب',
  'whatsapp.safety_settings_changed': 'تعديل ضوابط إرسال واتساب',
  'notification.consent_changed': 'تعديل موافقة الإشعارات',

  // Platform-tier (found raw/unmapped in PlatformAuditPage and
  // PlatformClubDetailPage's audit tab -- the actual real gap this
  // consolidation fixes)
  platform_suspend_club: 'إيقاف نادٍ',
  platform_reactivate_club: 'إعادة تفعيل نادٍ',
  extend_grace_period: 'تمديد فترة السماح',
  unpublish_plan: 'إلغاء نشر خطة',
}

export const ENTITY_LABELS: Record<string, string> = {
  booking: 'حجز',
  bookings: 'حجز',
  invoice: 'فاتورة',
  invoices: 'فاتورة',
  payment: 'دفعة',
  payment_reconciliations: 'تسوية دفعات',
  manual_payment_claim: 'طلب دفع يدوي',
  refund: 'استرجاع',
  refunds: 'استرجاع',
  field_block: 'حجب ملعب',
  subscription: 'اشتراك أكاديمية',
  customer: 'عميل',
  player: 'لاعب',
  cash_shift: 'وردية نقدية',
  whatsapp_accounts: 'حساب واتساب',
  messaging_safety_settings: 'ضوابط إرسال واتساب',
  notification_consent: 'موافقة إشعارات',
  // Platform-tier
  clubs: 'نادٍ',
  platform_subscriptions: 'اشتراك المنصة',
  platform_plans: 'خطة',
}

/** Looks up a label, falling back to the raw value if genuinely unmapped -- never throws, matches the existing safe-fallback convention used throughout the app's other label maps. */
export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
}

export function entityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? entityType
}
