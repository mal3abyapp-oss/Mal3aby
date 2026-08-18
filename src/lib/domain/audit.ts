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

// English mirror of ACTION_LABELS above -- same keys, same order, kept as
// a plain lookup object (not i18n resource JSON) because these are a
// fixed, small enum of audit_logs.action machine values, matching how
// this file is already structured.
export const ACTION_LABELS_EN: Record<string, string> = {
  // Club-tier (originally in AuditLogPage.tsx, Gate 13 #60)
  'booking.create': 'Create booking',
  'booking.check_in': 'Check in booking',
  'booking.discount.apply': 'Apply booking discount',
  'booking.auto_confirmed_on_full_payment': 'Auto-confirm booking on full payment',
  cancel_booking: 'Cancel booking',
  'field_block.create': 'Block field time slot',
  'invoice.issue': 'Issue invoice',
  void_invoice: 'Void invoice',
  'payment.record': 'Record payment',
  create_refund: 'Refund payment',
  'payment.refund': 'Refund payment',
  'payment.reconciliation_confirmed': 'Confirm payment reconciliation',
  'manual_payment_claim.verify': 'Review manual payment claim',
  'subscription.activate': 'Activate academy subscription',
  'subscription.cancel': 'Cancel academy subscription',
  'subscription.freeze': 'Freeze academy subscription',
  'subscription.unfreeze': 'Unfreeze academy subscription',
  'customer.photo.approve': 'Approve photo change',
  'customer.photo.reject': 'Reject photo change',
  'customer.self_service_claim': 'Auto-link customer account',
  'cash_shift.open': 'Open cash shift',
  'cash_shift.close': 'Close cash shift',
  'whatsapp.connect_requested': 'Request WhatsApp connection',
  'whatsapp.disconnect_requested': 'Request WhatsApp disconnection',
  'whatsapp.safety_settings_changed': 'Change WhatsApp sending controls',
  'notification.consent_changed': 'Change notification consent',

  // Platform-tier (found raw/unmapped in PlatformAuditPage and
  // PlatformClubDetailPage's audit tab -- the actual real gap this
  // consolidation fixes)
  platform_suspend_club: 'Suspend club',
  platform_reactivate_club: 'Reactivate club',
  extend_grace_period: 'Extend grace period',
  unpublish_plan: 'Unpublish plan',
}

export const ENTITY_LABELS_EN: Record<string, string> = {
  booking: 'Booking',
  bookings: 'Booking',
  invoice: 'Invoice',
  invoices: 'Invoice',
  payment: 'Payment',
  payment_reconciliations: 'Payment reconciliation',
  manual_payment_claim: 'Manual payment claim',
  refund: 'Refund',
  refunds: 'Refund',
  field_block: 'Field block',
  subscription: 'Academy subscription',
  customer: 'Customer',
  player: 'Player',
  cash_shift: 'Cash shift',
  whatsapp_accounts: 'WhatsApp account',
  messaging_safety_settings: 'WhatsApp sending controls',
  notification_consent: 'Notification consent',
  // Platform-tier
  clubs: 'Club',
  platform_subscriptions: 'Platform subscription',
  platform_plans: 'Plan',
}

/** Looks up a label, falling back to the raw value if genuinely unmapped -- never throws, matches the existing safe-fallback convention used throughout the app's other label maps. Defaults to 'ar' so any caller that hasn't been updated yet keeps its previous behavior. */
export function actionLabel(action: string, locale: 'ar' | 'en' = 'ar'): string {
  const table = locale === 'en' ? ACTION_LABELS_EN : ACTION_LABELS
  return table[action] ?? action
}

export function entityLabel(entityType: string, locale: 'ar' | 'en' = 'ar'): string {
  const table = locale === 'en' ? ENTITY_LABELS_EN : ENTITY_LABELS
  return table[entityType] ?? entityType
}
