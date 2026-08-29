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
  change_platform_plan: 'تغيير خطة النادي',

  // PERSONA COUNCIL AUDIT (2026-08-25) -- Club Owner persona finding:
  // actionLabel()'s own documented fallback ("table[action] ?? action")
  // means any action missing from this map renders as a raw machine
  // string in the Arabic UI -- live-confirmed against every distinct
  // action value actually present in production audit_logs (this file's
  // own header comment says "24 actions... grepped, not guessed" at the
  // time it was written; production now has 69). Filling the gap with
  // every action found live that wasn't already mapped above.
  'academy_membership.updated': 'تعديل عضوية أكاديمية',
  'booking.hold_expired': 'انتهاء مهلة حجز مؤقت',
  'booking.reschedule': 'إعادة جدولة حجز',
  'club_booking_policy.update': 'تعديل سياسة الحجز',
  'club.public_booking_enabled.set': 'تفعيل/إيقاف الحجز العام',
  'club.public_slug.set': 'تعديل رابط الحجز العام',
  'customer.phone_changed': 'تعديل رقم هاتف عميل',
  'customer.public_booking_name_mismatch': 'تعارض اسم في حجز عام',
  'employee_cash_liability.reversed': 'إلغاء التزام نقدي على موظف',
  'employee_cash_liability.settled': 'تسوية التزام نقدي على موظف',
  'employee_cash_liability.shortage_created': 'تسجيل عجز نقدي على موظف',
  // CASH CUSTODY & SHIFT LIFECYCLE audit (2026-08-26) -- found live,
  // no label existed for this action (close_cash_shift() writes it for
  // an overage close) -- it was rendering as the raw machine string.
  'employee_cash_liability.overage_recorded': 'تسجيل زيادة نقدية لدى موظف',
  'government_compliance.enabled': 'تفعيل الالتزام الحكومي',
  'government_compliance.policy_changed': 'تعديل سياسة الالتزام الحكومي',
  'guardian_link.create': 'ربط ولي أمر بلاعب',
  'guardian_link.set_primary': 'تعيين ولي أمر أساسي',
  'invoice.restored_after_incorrect_void': 'استرجاع فاتورة بعد إلغاء خاطئ',
  'invoice.void_on_booking_cancel_retroactive_reconciliation': 'تسوية فاتورة بأثر رجعي عند إلغاء حجز',
  'invoice.voided_on_booking_cancellation': 'إلغاء فاتورة تلقائيًا عند إلغاء حجز',
  'official_collection_receipt.corrected': 'تصحيح إيصال تحصيل رسمي',
  'official_collection_receipt.created': 'إصدار إيصال تحصيل رسمي',
  'official_collection_receipt.reversed': 'عكس إيصال تحصيل رسمي',
  'payment_method.updated': 'تعديل طريقة دفع',
  'payment_proof.approve': 'الموافقة على إثبات دفع',
  'payment_proof.upload': 'رفع إثبات دفع',
  'player.create': 'إضافة لاعب',
  'player.update': 'تعديل بيانات لاعب',
  'portal.account_activated': 'تفعيل حساب بوابة العميل',
  'portal.invite_created': 'إنشاء دعوة بوابة عميل',
  'staff.branch_scope.set': 'تعديل نطاق فروع موظف',
  'staff.cash_custody.set': 'تعديل صلاحية العهدة النقدية',
  'staff.invited': 'دعوة موظف',
  'staff.reactivated': 'إعادة تفعيل موظف',
  'staff.role_changed': 'تغيير دور موظف',
  'staff.suspended': 'إيقاف موظف',
  'whatsapp_consent.declined': 'رفض موافقة واتساب',
  'whatsapp_consent.re_recorded_after_revoke': 'تسجيل موافقة واتساب مجددًا',
  'whatsapp_consent.recorded': 'تسجيل موافقة واتساب',
  'whatsapp.message.retry': 'إعادة محاولة إرسال رسالة واتساب',

  // CLUB MEMBERSHIPS domain (2026-08-26) -- action strings written by
  // sell_club_membership/renew_club_membership/freeze_club_membership/
  // resume_club_membership/cancel_club_membership and the plan CRUD RPCs.
  'club_membership_plan.created': 'إنشاء خطة عضوية',
  'club_membership_plan.updated': 'تعديل خطة عضوية',
  'club_membership_plan.archived': 'أرشفة خطة عضوية',
  'club_membership_plan.restored': 'استرجاع خطة عضوية',
  'club_membership.created': 'إنشاء عضوية نادٍ',
  'club_membership.activated': 'تفعيل عضوية نادٍ',
  'club_membership.renewed': 'تجديد عضوية نادٍ',
  'club_membership.frozen': 'تجميد عضوية نادٍ',
  'club_membership.resumed': 'استئناف عضوية نادٍ',
  'club_membership.cancelled': 'إلغاء عضوية نادٍ',

  // PLATFORM OWNER AUTONOMOUS COMPLETION -- Phase B: the Platform Owner
  // Complete Control program's own real audit trail was found live-
  // rendering these as raw strings during the authenticated visual
  // acceptance pass (module.entitled, club_payments.disabled, etc. all
  // confirmed appearing unmapped in the real Audit Log UI). Same
  // coverage-gap pattern as the PERSONA COUNCIL AUDIT sections above --
  // filling it the same way.
  'module.entitled': 'إتاحة وحدة',
  'module.unentitled': 'إلغاء إتاحة وحدة',
  'module.activated': 'تفعيل وحدة',
  'module.deactivated': 'إيقاف تفعيل وحدة',
  'club_payments.enabled': 'تفعيل المدفوعات الإلكترونية',
  'club_payments.disabled': 'إيقاف المدفوعات الإلكترونية',
  'commercial_entitlements.updated': 'تعديل الحدود التجارية',
  'club_gateway_provider_policy.updated': 'تعديل سياسة موفر دفع',

  // SAAS ACCEPTANCE REVIEW (2026-08-29) -- same recurring coverage-gap
  // pattern as every prior sweep above (this is the 5th occurrence per
  // this file's own history): live-diffed every distinct audit_logs.action
  // value against this map, found 41 more missing (Shop/POS/Inventory
  // module actions never added when that module shipped, plus several
  // Platform-tier actions -- payment gateway connections, platform staff
  // lifecycle, support sessions, custom roles, QA subscription extension).
  'academy_subscriptions.bulk_expired': 'انتهاء اشتراكات أكاديمية بالجملة',
  'branch.created': 'إنشاء فرع',
  'branch.updated': 'تعديل فرع',
  'create_platform_subscription': 'إنشاء اشتراك منصة',
  'field.created': 'إنشاء ملعب',
  'field_pricing.created': 'إنشاء قاعدة تسعير ملعب',
  'inventory.adjusted': 'تسوية مخزون',
  'inventory.received': 'استلام مخزون',
  'inventory.received_batch': 'استلام دفعة مخزون',
  'inventory.stock_count.cancelled': 'إلغاء جرد مخزون',
  'inventory.stock_count.completed': 'إتمام جرد مخزون',
  'inventory.stock_count.started': 'بدء جرد مخزون',
  'inventory.transferred': 'نقل مخزون بين مواقع',
  'payment_gateway.connected': 'ربط بوابة دفع',
  'payment_gateway.default_changed': 'تغيير بوابة الدفع الافتراضية',
  'payment_gateway.disconnected': 'فصل بوابة دفع',
  'payment_gateway.enabled': 'تفعيل بوابة دفع',
  'payment.gateway_confirmed': 'تأكيد دفعة عبر بوابة إلكترونية',
  'payment.gateway_refund': 'استرجاع دفعة عبر بوابة إلكترونية',
  'payment.gateway_rejected': 'رفض دفعة عبر بوابة إلكترونية',
  'platform_role.created': 'إنشاء دور منصة',
  'platform_role.permissions_changed': 'تعديل صلاحيات دور منصة',
  'platform_staff.disabled': 'إيقاف موظف منصة',
  'platform_staff.role_changed': 'تغيير دور موظف منصة',
  'platform_support.session_ended': 'إنهاء جلسة دعم فني',
  'platform_support.session_started': 'بدء جلسة دعم فني',
  'platform.qa_subscription_extended': 'تمديد اشتراك تجريبي (QA)',
  'product.created': 'إنشاء منتج',
  'product.updated': 'تعديل منتج',
  'product.variant_created': 'إنشاء نسخة منتج',
  'product.variant_updated': 'تعديل نسخة منتج',
  'record_platform_payment': 'تسجيل دفعة منصة',
  'return.completed': 'إتمام إرجاع',
  'role.created': 'إنشاء دور',
  'role.deleted': 'حذف دور',
  'role.updated': 'تعديل دور',
  'sale.completed': 'إتمام عملية بيع',
  'shop_category.created': 'إنشاء فئة منتجات',
  'shop_sale.held': 'تعليق عملية بيع',
  'shop_sale.resumed': 'استئناف عملية بيع معلقة',
  'shop.print_settings.update': 'تعديل إعدادات الطباعة',
  'staff.account_created_and_invited': 'إنشاء حساب موظف ودعوته',
  'staff.invite_cancelled': 'إلغاء دعوة موظف',
  'staff.invite_resent': 'إعادة إرسال دعوة موظف',
  'subscription.renew': 'تجديد اشتراك أكاديمية',
  'qa.test_action': 'إجراء اختبار (QA)',
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

  // PERSONA COUNCIL AUDIT (2026-08-25) -- same real coverage gap as
  // ACTION_LABELS: entityLabel() falls back to the raw value for
  // anything missing here. Filling the gap with every entity_type found
  // live that wasn't already mapped above.
  academy_membership: 'عضوية أكاديمية',
  club: 'نادٍ',
  club_booking_policy: 'سياسة الحجز',
  club_membership: 'عضوية نادٍ',
  club_membership_plan: 'خطة عضوية نادٍ',
  club_membership_subscription: 'عضوية نادٍ',
  employee_cash_liability: 'التزام نقدي على موظف',
  government_collection_policy: 'سياسة التحصيل الحكومي',
  guardian_links: 'ربط ولي أمر',
  notification_queue: 'قائمة إشعارات',
  official_collection_receipt: 'إيصال تحصيل رسمي',
  payment_method_config: 'طريقة دفع',
  payment_proof: 'إثبات دفع',
  players: 'لاعب',

  // PLATFORM OWNER AUTONOMOUS COMPLETION -- Phase B (2026-08-29): entity
  // types for the module-control / payment-kill-switch / limit / gateway-
  // policy actions added to ACTION_LABELS above.
  club_module: 'وحدة نادٍ',
  commercial_entitlements: 'الحدود التجارية',
  club_gateway_provider_policy: 'سياسة موفر دفع',

  // SAAS ACCEPTANCE REVIEW (2026-08-29) -- same gap as ACTION_LABELS above.
  branch: 'فرع',
  club_gateway_connection: 'اتصال بوابة دفع',
  club_role: 'دور نادٍ',
  payment_gateway_transaction: 'عملية بوابة دفع',
  platform_custom_role: 'دور منصة مخصص',
  platform_payments: 'دفعات المنصة',
  platform_staff_membership: 'عضوية موظف منصة',
  platform_support_session: 'جلسة دعم فني',
  shop_category: 'فئة منتجات',
  shop_held_sale: 'عملية بيع معلقة',
  shop_inventory_movement: 'حركة مخزون',
  shop_inventory_receipt: 'إيصال استلام مخزون',
  shop_product: 'منتج',
  shop_product_variant: 'نسخة منتج',
  shop_sale: 'عملية بيع',
  shop_sale_return: 'إرجاع منتج',
  shop_stock_count: 'جرد مخزون',
  shop_transfer: 'نقل مخزون',
  qa_test_entity: 'كيان اختبار (QA)',
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
  change_platform_plan: "Change club's plan",

  // PERSONA COUNCIL AUDIT (2026-08-25) -- same coverage gap fix as
  // ACTION_LABELS above, English mirror.
  'academy_membership.updated': 'Update academy membership',
  'booking.hold_expired': 'Temporary booking hold expired',
  'booking.reschedule': 'Reschedule booking',
  'club_booking_policy.update': 'Update booking policy',
  'club.public_booking_enabled.set': 'Toggle public booking',
  'club.public_slug.set': 'Change public booking link',
  'customer.phone_changed': 'Change customer phone',
  'customer.public_booking_name_mismatch': 'Name mismatch on public booking',
  'employee_cash_liability.reversed': 'Reverse staff cash liability',
  'employee_cash_liability.settled': 'Settle staff cash liability',
  'employee_cash_liability.shortage_created': 'Record staff cash shortage',
  'employee_cash_liability.overage_recorded': 'Record staff cash overage',
  'government_compliance.enabled': 'Enable government compliance',
  'government_compliance.policy_changed': 'Change government compliance policy',
  'guardian_link.create': 'Link guardian to player',
  'guardian_link.set_primary': 'Set primary guardian',
  'invoice.restored_after_incorrect_void': 'Restore invoice after incorrect void',
  'invoice.void_on_booking_cancel_retroactive_reconciliation': 'Retroactively reconcile invoice on booking cancellation',
  'invoice.voided_on_booking_cancellation': 'Auto-void invoice on booking cancellation',
  'official_collection_receipt.corrected': 'Correct official receipt',
  'official_collection_receipt.created': 'Issue official receipt',
  'official_collection_receipt.reversed': 'Reverse official receipt',
  'payment_method.updated': 'Update payment method',
  'payment_proof.approve': 'Approve payment proof',
  'payment_proof.upload': 'Upload payment proof',
  'player.create': 'Add player',
  'player.update': 'Update player',
  'portal.account_activated': 'Activate customer portal account',
  'portal.invite_created': 'Create portal invite',
  'staff.branch_scope.set': 'Change staff branch scope',
  'staff.cash_custody.set': 'Change cash custody permission',
  'staff.invited': 'Invite staff member',
  'staff.reactivated': 'Reactivate staff member',
  'staff.role_changed': 'Change staff role',
  'staff.suspended': 'Suspend staff member',
  'whatsapp_consent.declined': 'Decline WhatsApp consent',
  'whatsapp_consent.re_recorded_after_revoke': 'Re-record WhatsApp consent',
  'whatsapp_consent.recorded': 'Record WhatsApp consent',
  'whatsapp.message.retry': 'Retry WhatsApp message',

  // CLUB MEMBERSHIPS domain (2026-08-26), English mirror.
  'club_membership_plan.created': 'Create membership plan',
  'club_membership_plan.updated': 'Update membership plan',
  'club_membership_plan.archived': 'Archive membership plan',
  'club_membership_plan.restored': 'Restore membership plan',
  'club_membership.created': 'Create club membership',
  'club_membership.activated': 'Activate club membership',
  'club_membership.renewed': 'Renew club membership',
  'club_membership.frozen': 'Freeze club membership',
  'club_membership.resumed': 'Resume club membership',
  'club_membership.cancelled': 'Cancel club membership',

  // PLATFORM OWNER AUTONOMOUS COMPLETION -- Phase B, English mirror.
  'module.entitled': 'Entitle module',
  'module.unentitled': 'Unentitle module',
  'module.activated': 'Activate module',
  'module.deactivated': 'Deactivate module',
  'club_payments.enabled': 'Enable online payments',
  'club_payments.disabled': 'Disable online payments',
  'commercial_entitlements.updated': 'Update commercial limits',
  'club_gateway_provider_policy.updated': 'Update payment provider policy',

  // SAAS ACCEPTANCE REVIEW (2026-08-29), English mirror -- see ACTION_LABELS above.
  'academy_subscriptions.bulk_expired': 'Bulk-expire academy subscriptions',
  'branch.created': 'Create branch',
  'branch.updated': 'Update branch',
  'create_platform_subscription': 'Create platform subscription',
  'field.created': 'Create field',
  'field_pricing.created': 'Create field pricing rule',
  'inventory.adjusted': 'Adjust inventory',
  'inventory.received': 'Receive inventory',
  'inventory.received_batch': 'Receive inventory batch',
  'inventory.stock_count.cancelled': 'Cancel stock count',
  'inventory.stock_count.completed': 'Complete stock count',
  'inventory.stock_count.started': 'Start stock count',
  'inventory.transferred': 'Transfer inventory between locations',
  'payment_gateway.connected': 'Connect payment gateway',
  'payment_gateway.default_changed': 'Change default payment gateway',
  'payment_gateway.disconnected': 'Disconnect payment gateway',
  'payment_gateway.enabled': 'Enable payment gateway',
  'payment.gateway_confirmed': 'Confirm gateway payment',
  'payment.gateway_refund': 'Refund gateway payment',
  'payment.gateway_rejected': 'Reject gateway payment',
  'platform_role.created': 'Create platform role',
  'platform_role.permissions_changed': 'Change platform role permissions',
  'platform_staff.disabled': 'Disable platform staff member',
  'platform_staff.role_changed': 'Change platform staff role',
  'platform_support.session_ended': 'End support session',
  'platform_support.session_started': 'Start support session',
  'platform.qa_subscription_extended': 'Extend QA trial subscription',
  'product.created': 'Create product',
  'product.updated': 'Update product',
  'product.variant_created': 'Create product variant',
  'product.variant_updated': 'Update product variant',
  'record_platform_payment': 'Record platform payment',
  'return.completed': 'Complete return',
  'role.created': 'Create role',
  'role.deleted': 'Delete role',
  'role.updated': 'Update role',
  'sale.completed': 'Complete sale',
  'shop_category.created': 'Create product category',
  'shop_sale.held': 'Hold sale',
  'shop_sale.resumed': 'Resume held sale',
  'shop.print_settings.update': 'Update print settings',
  'staff.account_created_and_invited': 'Create and invite staff account',
  'staff.invite_cancelled': 'Cancel staff invite',
  'staff.invite_resent': 'Resend staff invite',
  'subscription.renew': 'Renew academy subscription',
  'qa.test_action': 'QA test action',
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

  // PERSONA COUNCIL AUDIT (2026-08-25) -- same coverage gap fix as
  // ENTITY_LABELS above, English mirror.
  academy_membership: 'Academy membership',
  club: 'Club',
  club_booking_policy: 'Booking policy',
  club_membership: 'Club membership',
  club_membership_plan: 'Club membership plan',
  club_membership_subscription: 'Club membership',
  employee_cash_liability: 'Staff cash liability',
  government_collection_policy: 'Government collection policy',
  guardian_links: 'Guardian link',
  notification_queue: 'Notification queue',
  official_collection_receipt: 'Official receipt',
  payment_method_config: 'Payment method',
  payment_proof: 'Payment proof',
  players: 'Player',

  // PLATFORM OWNER AUTONOMOUS COMPLETION -- Phase B, English mirror.
  club_module: 'Club module',
  commercial_entitlements: 'Commercial limits',
  club_gateway_provider_policy: 'Payment provider policy',

  // SAAS ACCEPTANCE REVIEW (2026-08-29), English mirror -- see ENTITY_LABELS above.
  branch: 'Branch',
  club_gateway_connection: 'Payment gateway connection',
  club_role: 'Club role',
  payment_gateway_transaction: 'Payment gateway transaction',
  platform_custom_role: 'Platform custom role',
  platform_payments: 'Platform payments',
  platform_staff_membership: 'Platform staff membership',
  platform_support_session: 'Support session',
  shop_category: 'Product category',
  shop_held_sale: 'Held sale',
  shop_inventory_movement: 'Inventory movement',
  shop_inventory_receipt: 'Inventory receipt',
  shop_product: 'Product',
  shop_product_variant: 'Product variant',
  shop_sale: 'Sale',
  shop_sale_return: 'Product return',
  shop_stock_count: 'Stock count',
  shop_transfer: 'Inventory transfer',
  qa_test_entity: 'QA test entity',
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
