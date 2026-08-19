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
//
// Locale (2026-08-19 fix): this translator used to return Arabic-only
// text unconditionally, which meant every RPC-error toast/message across
// the app stayed Arabic even in English mode -- a real, high-impact gap
// (this function is called from ~20 feature files). It now reads the
// shared i18next instance's current language directly (the same
// instance DirectionProvider drives) rather than taking a `locale`
// param, since call sites span both component and non-component code
// and adding the param everywhere would be a much larger, riskier
// change for the same outcome.
import i18n from './i18n/config'

interface SupabaseLikeError {
  message?: string
  code?: string
  details?: string | null
}

const MESSAGE_RULES: Array<[RegExp, string, string]> = [
  // [pattern, arabic, english]
  [/not authorized/i, 'ليس لديك صلاحية لتنفيذ هذا الإجراء.', "You don't have permission to do this."],
  [/authentication required/i, 'يجب تسجيل الدخول أولاً.', 'You need to sign in first.'],
  [/group is at full capacity/i, 'المجموعة وصلت إلى الحد الأقصى من اللاعبين.', 'This group has reached its maximum number of players.'],
  [/group is not accepting enrollments/i, 'هذه المجموعة لا تقبل تسجيلات جديدة حاليًا.', 'This group is not accepting new enrollments right now.'],
  [/already actively enrolled|enrollments_active_player_group_idx|enrollments_one_active_per_player_group/i, 'هذا اللاعب مسجّل بالفعل في هذه المجموعة.', 'This player is already enrolled in this group.'],
  [/group not found/i, 'المجموعة غير موجودة.', 'Group not found.'],
  [/player not found/i, 'اللاعب غير موجود في هذا النادي.', 'Player not found in this club.'],
  [/guardian not found/i, 'ولي الأمر المحدد غير موجود في هذا النادي.', 'The selected guardian was not found in this club.'],
  [/no billing guardian/i, 'يجب اختيار ولي أمر لإتمام الفوترة، أو ربط ولي أمر أساسي باللاعب أولاً.', 'You need to select a guardian to bill, or link a primary guardian to the player first.'],
  [/end date must be after start date/i, 'تاريخ الانتهاء يجب أن يكون بعد تاريخ البداية.', 'The end date must be after the start date.'],
  [/club subscription does not allow new commitments/i, 'اشتراك النادي في المنصة لا يسمح حاليًا بإنشاء التزامات جديدة — راجع حالة الاشتراك.', "The club's platform subscription doesn't currently allow new commitments — check the subscription status."],
  [/no account found for that email/i, 'لا يوجد حساب مسجّل بهذا البريد الإلكتروني في ملعبي — يجب أن ينشئ الموظف حسابًا أولاً.', 'No account is registered with that email in Mal3aby — a staff member needs to create an account first.'],
  [/unknown role/i, 'الدور المحدد غير معروف.', 'The selected role is not recognized.'],
  [/no such field|field not found/i, 'الملعب غير موجود.', 'Field not found.'],
  [/no price configured|no approved price/i, 'لا يوجد سعر معتمد لهذا التوقيت.', 'No approved price is configured for this time.'],
  [/outside operating hours|field is closed/i, 'الملعب مغلق في هذا التوقيت.', 'The field is closed at this time.'],
  [/membership not found/i, 'العضوية غير موجودة.', 'Membership not found.'],
  [/invoice not found/i, 'الفاتورة غير موجودة.', 'Invoice not found.'],
  [/payment not found/i, 'الدفعة غير موجودة.', 'Payment not found.'],
  [/exceeds? (the )?outstanding|refund amount/i, 'قيمة الاسترجاع تتجاوز الرصيد القابل للاسترجاع.', 'The refund amount exceeds the refundable balance.'],
  [/customer not found/i, 'العميل غير موجود.', 'Customer not found.'],
  [/already linked to a different account/i, 'هذا السجل مرتبط بالفعل بحساب آخر.', 'This record is already linked to a different account.'],
  [/already linked to a customer record in this club/i, 'حسابك مرتبط بالفعل ببيانات عميل في هذا النادي.', 'Your account is already linked to a customer record in this club.'],
  [/invalid mobile number/i, 'رقم الهاتف غير صحيح.', 'The phone number is not valid.'],
]

const CODE_RULES: Record<string, [string, string]> = {
  // code -> [arabic, english]
  '23505': ['هذا العنصر مسجّل بالفعل — تحقق من عدم التكرار.', 'This already exists — check for a duplicate.'],
  '23503': ['لا يمكن إتمام العملية لوجود بيانات مرتبطة بهذا العنصر.', "This can't be done because related data still references it."],
  '23P01': ['هذا الموعد يتعارض مع حجز أو التزام آخر موجود بالفعل.', 'This time conflicts with another existing booking or commitment.'],
  '42501': ['ليس لديك صلاحية لتنفيذ هذا الإجراء.', "You don't have permission to do this."],
  '22P02': ['أحد الحقول المُدخلة بصيغة غير صحيحة.', 'One of the entered fields is not in a valid format.'],
}

function isEnglish(): boolean {
  return i18n.language?.startsWith('en') ?? false
}

/**
 * Translate a Supabase/PostgREST error into a human-readable message in
 * the current UI language. Falls back to `fallback` (a screen-specific
 * generic message, itself expected to already be in the current
 * language via t()) when no rule matches -- never returns the raw
 * error text.
 */
export function translateSupabaseError(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback
  const err = error as SupabaseLikeError
  const english = isEnglish()

  if (err.code && CODE_RULES[err.code]) {
    const [ar, en] = CODE_RULES[err.code] as [string, string]
    return english ? en : ar
  }

  const haystack = `${err.message ?? ''} ${err.details ?? ''}`
  for (const [pattern, ar, en] of MESSAGE_RULES) {
    if (pattern.test(haystack)) return english ? en : ar
  }

  return fallback
}
