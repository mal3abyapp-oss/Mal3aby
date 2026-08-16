// V1 Critical Fix Pass (2026-08-16) — Section 9 of the locked pricing/
// error-handling rule: never surface raw Postgres/PostgREST errors
// (exception text, SQLSTATE codes, constraint names) to an employee.
// Every RPC/table-mutation error in this app should be routed through
// this translator before being shown, so the same failure always reads
// the same human way regardless of which screen triggered it.
//
// Supabase JS surfaces RPC raise exception's text as error.message, and
// PostgREST error codes (unique_violation, exclusion violation, etc.) as
// error.code -- match on both, matching by substring since RPC authors
// phrase their raise exception text in plain English deliberately (see
// e.g. create_enrollment_with_subscription, create_booking).
interface SupabaseLikeError {
  message?: string
  code?: string
  details?: string | null
}

const MESSAGE_RULES: Array<[RegExp, string]> = [
  [/not authorized/i, 'ليس لديك صلاحية لتنفيذ هذا الإجراء.'],
  [/authentication required/i, 'يجب تسجيل الدخول أولاً.'],
  [/group is at full capacity/i, 'المجموعة وصلت إلى الحد الأقصى من اللاعبين.'],
  [/group is not accepting enrollments/i, 'هذه المجموعة لا تقبل تسجيلات جديدة حاليًا.'],
  [/already actively enrolled|enrollments_active_player_group_idx|enrollments_one_active_per_player_group/i, 'هذا اللاعب مسجّل بالفعل في هذه المجموعة.'],
  [/group not found/i, 'المجموعة غير موجودة.'],
  [/player not found/i, 'اللاعب غير موجود في هذا النادي.'],
  [/guardian not found/i, 'ولي الأمر المحدد غير موجود في هذا النادي.'],
  [/no billing guardian/i, 'يجب اختيار ولي أمر لإتمام الفوترة، أو ربط ولي أمر أساسي باللاعب أولاً.'],
  [/end date must be after start date/i, 'تاريخ الانتهاء يجب أن يكون بعد تاريخ البداية.'],
  [/club subscription does not allow new commitments/i, 'اشتراك النادي في المنصة لا يسمح حاليًا بإنشاء التزامات جديدة — راجع حالة الاشتراك.'],
  [/no account found for that email/i, 'لا يوجد حساب مسجّل بهذا البريد الإلكتروني في ملعبي — يجب أن ينشئ الموظف حسابًا أولاً.'],
  [/unknown role/i, 'الدور المحدد غير معروف.'],
  [/no such field|field not found/i, 'الملعب غير موجود.'],
  [/no price configured|no approved price/i, 'لا يوجد سعر معتمد لهذا التوقيت.'],
  [/outside operating hours|field is closed/i, 'الملعب مغلق في هذا التوقيت.'],
  [/membership not found/i, 'العضوية غير موجودة.'],
  [/invoice not found/i, 'الفاتورة غير موجودة.'],
  [/payment not found/i, 'الدفعة غير موجودة.'],
  [/exceeds? (the )?outstanding|refund amount/i, 'قيمة الاسترجاع تتجاوز الرصيد القابل للاسترجاع.'],
  [/customer not found/i, 'العميل غير موجود.'],
  [/already linked to a different account/i, 'هذا السجل مرتبط بالفعل بحساب آخر.'],
  [/already linked to a customer record in this club/i, 'حسابك مرتبط بالفعل ببيانات عميل في هذا النادي.'],
  [/invalid mobile number/i, 'رقم الهاتف غير صحيح.'],
]

const CODE_RULES: Record<string, string> = {
  '23505': 'هذا العنصر مسجّل بالفعل — تحقق من عدم التكرار.',
  '23503': 'لا يمكن إتمام العملية لوجود بيانات مرتبطة بهذا العنصر.',
  '23P01': 'هذا الموعد يتعارض مع حجز أو التزام آخر موجود بالفعل.',
  '42501': 'ليس لديك صلاحية لتنفيذ هذا الإجراء.',
  '22P02': 'أحد الحقول المُدخلة بصيغة غير صحيحة.',
}

/**
 * Translate a Supabase/PostgREST error into an Arabic, human-readable
 * message. Falls back to `fallback` (a screen-specific generic message)
 * when no rule matches -- never returns the raw error text.
 */
export function translateSupabaseError(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback
  const err = error as SupabaseLikeError

  if (err.code && CODE_RULES[err.code]) return CODE_RULES[err.code] as string

  const haystack = `${err.message ?? ''} ${err.details ?? ''}`
  for (const [pattern, translated] of MESSAGE_RULES) {
    if (pattern.test(haystack)) return translated
  }

  return fallback
}
