/**
 * templates.ts -- centralized WhatsApp message template layer (the
 * ONLY place WhatsApp message text is composed; business RPCs never
 * embed message copy, they only pass event data as jsonb variables via
 * queue_whatsapp_notification -- see supabase/migrations/
 * 20260817130000_whatsapp_template_data_enrichment.sql for the data
 * side of this redesign).
 *
 * Owner-Level Review directive (2026-08-17): the previous version of
 * this file produced messages like "تم استلام حجزك في ملعب ملعب 1 -
 * كرة قدم بتاريخ 2026-08-17T07:00:00+00:00" -- a raw ISO timestamp, a
 * duplicated "ملعب" word (baked into the template AND already part of
 * the field's own free-text name), no club/booking-reference context,
 * and no visual structure. This rewrite fixes all of that:
 *
 *  - Real venue-timezone-aware date/time formatting (formatDateTime
 *    below), never a raw ISO string, never a hardcoded UTC offset --
 *    reads `variables.timezone` (an IANA zone from clubs.timezone,
 *    passed by the enrichment migration) exactly like the frontend's
 *    own src/lib/domain/time.ts does.
 *  - No hardcoded "ملعب " prefix -- field_name is shown as-is, with
 *    sport shown as its own labeled line when available.
 *  - WhatsApp-native bold (*text*) + a short, functional emoji set for
 *    section labels, following the exact style the directive specifies.
 *  - Every optional field (customer_name, sport, invoice_number,
 *    payment_status, amount, club_name, booking_ref) is rendered
 *    conditionally -- a missing/null value drops the whole line, never
 *    prints "null"/"undefined".
 *  - Money formatted via the same Intl.NumberFormat('ar-EG', {2 dp})
 *    pattern as the frontend's formatMoney() (src/lib/domain/
 *    billing.ts) -- can't import across the two separate npm packages,
 *    so the number-formatting logic is mirrored here, not reinvented.
 *  - Arabic status labels mirror BOOKING_STATUS_LABELS/
 *    PAYMENT_STATUS_LABELS from the frontend's src/lib/domain/
 *    booking.ts and billing.ts -- same wording, not reinvented.
 *  - Branding line: "*{club_name} عبر ملعبي*" when a reliable club name
 *    is available, "*ملعبي*" otherwise.
 *
 * Arabic-first: this app's primary audience is Arabic-speaking club
 * staff/customers (see i18n foundation, Gate 10) -- language is still
 * driven by notification_queue.language (defaults to 'ar'), never
 * hardcoded, so English falls back correctly for clubs/customers who
 * use it.
 */

// WHATSAPP BUSINESS MESSAGING FINAL HARDENING (2026-08-22), Sections
// 5/9 (one meaningful business outcome -> one message; no
// fragmentation): 'booking-confirmed' and 'invoice-created' were
// removed here. Both were confirmed dead code (no live RPC ever
// queues either template_key -- verified via
// `select proname from pg_proc where prosrc ilike '%queue_whatsapp_notification%'`
// across the whole schema) AND, on their own merits, would have
// violated this directive if ever wired up: booking.confirmed is
// already fully covered by 'booking-confirmed-paid' (fired in the
// same transaction when a booking is created-and-paid, or implied by
// 'payment-received' when payment completes later) -- a standalone
// booking-confirmed message would be exactly the "created, then
// confirmed, then invoiced" fragmentation Section 9 forbids. Likewise
// every invoice today is issued in the same transaction as a booking
// or payment event that already reports invoice_number/total/payment
// status -- a standalone "invoice created" message would fragment
// against that. 'booking-confirmed' also used the ambiguous "تم تأكيد
// حجزك" / "Booking confirmed" wording Section 15 explicitly flags as
// insufficiently specific (no "Field Booking" identity). If a future,
// genuinely distinct business outcome needs either message, add a new
// template_key key with correctly-scoped identity, rather than
// resurrecting these.
// WHATSAPP BUSINESS MESSAGING FINAL HARDENING (2026-08-22), Sections
// 14/28-35 (Field Booking vs Academy message identity): confirmed via
// the full message-producer matrix audit that NO Academy-specific
// WhatsApp message existed anywhere in this codebase before this
// change -- create_enrollment_with_subscription() enqueues zero
// messages (enrollment/subscription creation is silent by design,
// matching _create_booking_internal's "created silently, message on
// the actual paid outcome" pattern), and the only customer-facing
// message an Academy payment ever produced was the generic
// 'payment-received' template -- identical wording, identical
// structure, ZERO player name, for both a field-booking installment
// AND an academy enrollment payment. This directly violated Section
// 14 (two distinct message families required) and Section 29 (Academy
// message MUST name the specific player). 'academy-payment-received'
// closes this gap -- see record_payment()'s new Academy-detection
// branch (migration 20260822080000) for how this is selected.
export type TemplateKey =
  | 'booking-created'
  | 'booking-confirmed-paid'
  | 'booking-cancelled'
  | 'payment-received'
  | 'payment-refunded'
  | 'academy-payment-received'

type Vars = Record<string, unknown>
type Renderer = (vars: Vars) => string

// ----------------------------------------------------------------
// Shared value helpers -- every one of these is null/undefined-safe by
// construction, so a template line built from them can be dropped
// entirely with `line(...)` below rather than ever printing a raw
// "null"/"undefined"/empty value to a real customer.
// ----------------------------------------------------------------

function isPresent(v: unknown): v is string | number {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim().length > 0
  return true
}

/** Builds one "emoji *label:* value" line, or '' if the value is missing -- join with filter(Boolean) so a dropped line leaves no stray blank line either. */
function line(emoji: string, label: string, value: unknown): string {
  return isPresent(value) ? `${emoji} *${label}:* ${value}` : ''
}

// ----------------------------------------------------------------
// WhatsApp secure links directive: booking_qr_token / invoice_token
// arrive in `variables` as the RAW TOKEN ONLY -- business RPCs
// (supabase/migrations/20260818120000_whatsapp_secure_links.sql)
// deliberately never build a URL in SQL or the frontend, since this
// connector is the only layer with real env-var access. URL
// composition happens here, once, right before the token is used in
// a rendered line -- never logged, never stored, only interpolated
// into the outgoing message text.
//
// PUBLIC_APP_URL must be a full origin (e.g. https://app.mala3by.com)
// with no trailing slash and no localhost/127.0.0.1 in a deployed
// environment (directive rule 14) -- during local dev it's fine to
// point this at a dev URL (http://localhost:5173), that's what the
// directive's own "local/dev URL for testing, architecture ready for
// the final domain at deploy time" language describes. Falls back to
// localhost ONLY as a last resort so local runs don't crash outright
// if the var is unset -- deployed environments MUST set this.
// ----------------------------------------------------------------
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL ?? 'http://localhost:5173').replace(/\/+$/, '')

// Exported (not just used internally) so QrImage.ts can encode the
// EXACT SAME url this file puts in the message text -- directive rule
// 1: the QR image must encode the same secure opaque URL already used,
// never a second, independently-built URL that could silently drift
// from the text fallback link.
//
// `language` (directive Sections 28-32/40 -- Secure Booking Page must
// open in the customer's own language, not force a re-detection/guess
// on first visit): appended as `?lang=ar|en`, read once on mount by
// SecureBookingPage/VerifyInvoicePage to seed DirectionProvider's
// locale for a first-time anonymous visitor. Optional and additive --
// a caller that omits it (or an older queued row missing `language`)
// still gets a working link, just without the language pre-set.
export function bookingQrUrl(token: unknown, language?: string): string | null {
  if (!isPresent(token)) return null
  const suffix = language === 'en' || language === 'ar' ? `?lang=${language}` : ''
  return `${PUBLIC_APP_URL}/qr/${encodeURIComponent(String(token))}${suffix}`
}

export function invoiceUrl(token: unknown, language?: string): string | null {
  if (!isPresent(token)) return null
  const suffix = language === 'en' || language === 'ar' ? `?lang=${language}` : ''
  return `${PUBLIC_APP_URL}/verify/${encodeURIComponent(String(token))}${suffix}`
}

/**
 * Venue-timezone-aware date/time formatting -- mirrors the frontend's
 * formatInstant() (src/lib/domain/time.ts) intent exactly: never a raw
 * ISO string, never a hardcoded offset, always Intl.DateTimeFormat
 * against the real IANA zone from clubs.timezone. Falls back to
 * 'Africa/Cairo' (the same platform default clubs.timezone itself
 * defaults to) only if a queue row genuinely predates the enrichment
 * migration and has no timezone variable -- documented here, not
 * silently guessed per-call.
 */
const DEFAULT_TIMEZONE = 'Africa/Cairo'

function formatDate(instant: string, timezone: string, locale: string): string | null {
  const d = new Date(instant)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}

function formatTime(instant: string, timezone: string, locale: string): string | null {
  const d = new Date(instant)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(d)
}

/**
 * Academy subscription dates (subscriptions.start_date/end_date) are
 * plain SQL `date` values ('2026-09-01'), not timestamptz instants --
 * no venue timezone conversion applies (a calendar date is the same
 * date everywhere), so this deliberately does NOT go through
 * formatDate()/timezone at all -- parsing 'YYYY-MM-DD' as UTC midnight
 * and formatting with timeZone:'UTC' keeps the calendar date stable
 * regardless of the connector process's own local timezone.
 */
function formatCalendarDate(dateStr: string, locale: string): string | null {
  const d = new Date(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}

/**
 * Mirrors formatMoney() (src/lib/domain/billing.ts) -- same 2dp
 * pattern, ported rather than imported since the connector is a
 * separate npm package with no shared module boundary to the frontend.
 *
 * Localization fix (2026-08-18, directive Section 38): this always
 * used the 'ar-EG' locale for Intl.NumberFormat regardless of
 * `language`, which renders Arabic-Indic digits (e.g. "٢٢٠.٠٠") even
 * in an English-language message -- an English customer's booking
 * confirmation showed Arabic numerals for every amount. Now picks
 * 'en-US' (Western digits) for English, 'ar-EG' (Arabic-Indic digits,
 * matching the rest of the Arabic UI) for Arabic.
 */
function formatMoney(amount: unknown, currencySuffixAr: string, currencySuffixEn: string, language: string): string | null {
  const n = typeof amount === 'number' ? amount : typeof amount === 'string' ? Number(amount) : NaN
  if (!Number.isFinite(n)) return null
  const locale = language === 'en' ? 'en-US' : 'ar-EG'
  const formatted = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
  return `${formatted} ${language === 'en' ? currencySuffixEn : currencySuffixAr}`
}

/**
 * Business-messaging audit fix (2026-08-22, directive rule 12 "Partial
 * payment is not full payment" / Section 15): payment-received and
 * booking-confirmed-paid both showed a translated payment_status label
 * (e.g. "مدفوعة جزئيًا" / "Partially paid") but never stated HOW MUCH
 * was still owed -- a customer receiving a partial-payment message had
 * no way to know their outstanding balance from the message itself,
 * only by clicking through to the invoice link. record_payment()
 * already computes and passes remaining_outstanding for the
 * payment-received path; booking-confirmed-paid (fired from
 * _create_booking_internal, a payment recorded in the SAME transaction
 * as booking creation) does not pass an equivalent field, so this
 * derives it from total_price - amount_paid when remaining_outstanding
 * itself is absent -- both call sites already have the raw numbers
 * needed, this is a pure rendering-layer fix, no RPC/migration change
 * required. Returns null (line() then drops it entirely, matching
 * every other optional line in this file) whenever there is nothing
 * meaningful to show: a fully-paid booking, a missing/non-numeric
 * amount, or a computed value that rounds to zero or below (never show
 * "outstanding: -5.00" or "outstanding: 0.00" -- both are noise, not
 * information, once the balance is actually settled).
 */
function outstandingAmount(explicitRemaining: unknown, total: unknown, paid: unknown): number | null {
  if (typeof explicitRemaining === 'number' && Number.isFinite(explicitRemaining)) {
    return explicitRemaining > 0.004 ? explicitRemaining : null
  }
  const totalN = typeof total === 'number' ? total : typeof total === 'string' ? Number(total) : NaN
  const paidN = typeof paid === 'number' ? paid : typeof paid === 'string' ? Number(paid) : NaN
  if (!Number.isFinite(totalN) || !Number.isFinite(paidN)) return null
  const remaining = totalN - paidN
  return remaining > 0.004 ? remaining : null
}

// Mirrors BOOKING_STATUS_LABELS (src/lib/domain/booking.ts) -- same
// Arabic wording as the app's own UI, not reinvented.
const BOOKING_STATUS_LABELS_AR: Record<string, string> = {
  pending_payment: 'بانتظار الدفع',
  confirmed: 'مؤكد',
  checked_in: 'تم تسجيل الحضور',
  completed: 'مكتمل',
  cancelled: 'ملغي',
  no_show: 'لم يحضر',
}
const BOOKING_STATUS_LABELS_EN: Record<string, string> = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
}

// Mirrors PAYMENT_STATUS_LABELS (src/lib/domain/billing.ts) -- same
// wording. The connector only ever sees a narrower subset in practice
// (unpaid/paid/partially_paid from the payloads that reach it today),
// but the full map is kept here so a future payload value never falls
// through to a raw enum string on the customer's phone.
const PAYMENT_STATUS_LABELS_AR: Record<string, string> = {
  draft: 'مسودة',
  void: 'ملغاة',
  unpaid: 'غير مدفوعة',
  partially_paid: 'مدفوعة جزئيًا',
  paid: 'مدفوعة بالكامل',
  partially_refunded: 'مستردة جزئيًا',
  refunded: 'مستردة بالكامل',
}
const PAYMENT_STATUS_LABELS_EN: Record<string, string> = {
  draft: 'Draft',
  void: 'Voided',
  unpaid: 'Unpaid',
  partially_paid: 'Partially paid',
  paid: 'Fully paid',
  partially_refunded: 'Partially refunded',
  refunded: 'Fully refunded',
}

const PAYMENT_METHOD_LABELS_AR: Record<string, string> = {
  cash: 'نقدًا',
  card: 'بطاقة',
  bank_transfer: 'تحويل بنكي',
  wallet: 'محفظة إلكترونية',
  other: 'أخرى',
}
const PAYMENT_METHOD_LABELS_EN: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  wallet: 'E-wallet',
  other: 'Other',
}

// Business-messaging audit fix (2026-08-22, directive rule "Use actual
// taxonomy/localization source" / Section 29): fields.sport is a
// free-text column (confirmed live: staff enter it via a plain
// unconstrained <Input>, FieldsManagement.tsx -- not a strict DB enum),
// so a raw "football"/"basketball"/"padel" was rendering literally
// inside an Arabic message instead of "كرة قدم"/"كرة سلة"/"بادل".
// Mirrors src/lib/i18n/resources/{ar,en}/common.json's own
// publicBooking.sportLabels map and its own established fallback
// pattern (PublicClubBookingPage.tsx:
// t(`publicBooking.sportLabels.${f.sport}`, { defaultValue: f.sport })
// -- translate the known values, but since a club can genuinely type
// any free-text sport name, NEVER drop or blank an unrecognized one;
// fall back to showing it as-is rather than silently hiding real
// information a customer needs (which field name).
const SPORT_LABELS_AR: Record<string, string> = {
  football: 'كرة قدم',
  padel: 'بادل',
  basketball: 'كرة سلة',
}
const SPORT_LABELS_EN: Record<string, string> = {
  football: 'Football',
  padel: 'Padel',
  basketball: 'Basketball',
}

function bookingStatusLabel(status: unknown, language: string): string | null {
  if (!isPresent(status)) return null
  const table = language === 'en' ? BOOKING_STATUS_LABELS_EN : BOOKING_STATUS_LABELS_AR
  return table[String(status)] ?? null
}
function paymentStatusLabel(status: unknown, language: string): string | null {
  if (!isPresent(status)) return null
  const table = language === 'en' ? PAYMENT_STATUS_LABELS_EN : PAYMENT_STATUS_LABELS_AR
  return table[String(status)] ?? null
}
function paymentMethodLabel(method: unknown, language: string): string | null {
  if (!isPresent(method)) return null
  const table = language === 'en' ? PAYMENT_METHOD_LABELS_EN : PAYMENT_METHOD_LABELS_AR
  return table[String(method)] ?? null
}
/** Translates a known sport value; falls back to the raw stored value for anything else, since fields.sport is genuinely free-text, not a closed enum -- never blanks real information. */
function sportLabel(sport: unknown, language: string): string | null {
  if (!isPresent(sport)) return null
  const table = language === 'en' ? SPORT_LABELS_EN : SPORT_LABELS_AR
  return table[String(sport)] ?? String(sport)
}

/**
 * Real bug found during production QA acceptance testing (2026-08-22):
 * every template showing an official-receipt date passed `v.receipt_date`
 * straight to `line()` with no formatting -- the raw SQL date string
 * ('2026-08-22') rendered literally in an otherwise fully-localized
 * Arabic/English message (every other date field already went through
 * formatCalendarDate()/formatDate()). Confirmed live: a real production
 * QA message showed "📅 *تاريخ الإيصال:* 2026-08-22" surrounded by
 * properly formatted Arabic dates everywhere else. receipt_date is a
 * plain calendar date (not a timestamptz instant), so this reuses
 * formatCalendarDate() -- the same helper subscription_start_date/
 * subscription_end_date already use -- rather than formatDate()'s
 * timezone-instant logic.
 */
function receiptDateLabel(receiptDate: unknown, language: string): string | null {
  if (!isPresent(receiptDate)) return null
  return formatCalendarDate(String(receiptDate), language === 'en' ? 'en-US' : 'ar-EG')
}

/** "*{club_name} عبر ملعبي*" when a reliable club name is available, "*ملعبي*"/"*Mal3aby*" otherwise -- directive rule 21. */
function brandLine(vars: Vars, language: string): string {
  if (isPresent(vars.club_name)) {
    return language === 'en' ? `*${String(vars.club_name)} via Mal3aby*` : `*${String(vars.club_name)} عبر ملعبي*`
  }
  return language === 'en' ? '*Mal3aby*' : '*ملعبي*'
}

function greeting(vars: Vars, language: string): string {
  const name = isPresent(vars.customer_name) ? String(vars.customer_name) : ''
  if (language === 'en') return name ? `Hi ${name} 👋` : 'Hi 👋'
  return name ? `مرحبًا ${name} 👋` : 'مرحبًا 👋'
}

/**
 * Joins template lines with '\n', preserving intentional blank-line
 * spacing between sections (a literal '' argument means "blank line
 * here") while dropping lines that were conditionally omitted
 * (produced as '' by `line()` when a variable was missing) so a
 * missing optional field never leaves a doubled-up blank gap. The
 * distinction: a hardcoded '' literal in a template's call is
 * intentional spacing; a '' returned FROM `line()`/a ternary is an
 * omitted field -- both arrive here as the same JS value, so this
 * collapses any run of 2+ blanks down to exactly 1, which satisfies
 * both cases correctly (intentional single blank lines stay exactly
 * one line; an omitted field next to an intentional blank never
 * produces a double gap).
 */
function joinLines(...lines: (string | null)[]): string {
  const cleaned = lines.map((l) => l ?? '')
  const collapsed: string[] = []
  for (const l of cleaned) {
    if (l === '' && collapsed[collapsed.length - 1] === '') continue
    collapsed.push(l)
  }
  while (collapsed[0] === '') collapsed.shift()
  while (collapsed[collapsed.length - 1] === '') collapsed.pop()
  return collapsed.join('\n')
}

// ----------------------------------------------------------------
// Templates
// ----------------------------------------------------------------

const AR: Record<TemplateKey, Renderer> = {
  'booking-created': (v) => {
    const tz = isPresent(v.timezone) ? String(v.timezone) : DEFAULT_TIMEZONE
    const date = isPresent(v.start_at) ? formatDate(String(v.start_at), tz, 'ar-EG') : null
    const time = isPresent(v.start_at) ? formatTime(String(v.start_at), tz, 'ar-EG') : null
    const qrUrl = bookingQrUrl(v.booking_qr_token, 'ar')
    return joinLines(
      '📝 *تم استلام طلب الحجز*',
      '',
      greeting(v, 'ar'),
      '',
      'استلمنا طلب حجزك بنجاح، وهذه التفاصيل:',
      '',
      line('🏟️', 'الملعب', v.field_name),
      line('⚽', 'النشاط', sportLabel(v.sport, 'ar')),
      line('📅', 'التاريخ', date),
      line('🕐', 'الوقت', time),
      line('🔖', 'رقم الحجز', v.booking_ref),
      line('📌', 'الحالة', 'بانتظار التأكيد'),
      '',
      'سنرسل لك رسالة أخرى فور تأكيد الحجز.',
      '',
      qrUrl ? `رمز الحضور:\n${qrUrl}` : '',
      '',
      brandLine(v, 'ar'),
    )
  },

  /**
   * Duplicate-message fix (2026-08-18, directive Sections 22-24): fired
   * ONCE instead of the old booking-created + booking-confirmed +
   * payment-received trio when a payment is recorded in the SAME
   * booking-creation transaction -- see
   * _create_booking_internal()'s p_record_payment branch. A payment
   * recorded LATER, as an independent event, still uses the separate
   * 'payment-received' template below (that case is a genuinely
   * distinct customer-facing event, not a duplicate).
   */
  'booking-confirmed-paid': (v) => {
    const tz = isPresent(v.timezone) ? String(v.timezone) : DEFAULT_TIMEZONE
    const date = isPresent(v.start_at) ? formatDate(String(v.start_at), tz, 'ar-EG') : null
    const time = isPresent(v.start_at) ? formatTime(String(v.start_at), tz, 'ar-EG') : null
    const total = formatMoney(v.total_price, 'ج.م', 'EGP', 'ar')
    const paid = formatMoney(v.amount_paid, 'ج.م', 'EGP', 'ar')
    const outstanding = formatMoney(outstandingAmount(v.remaining_outstanding, v.total_price, v.amount_paid), 'ج.م', 'EGP', 'ar')
    const paymentStatus = paymentStatusLabel(v.payment_status, 'ar')
    const method = paymentMethodLabel(v.method, 'ar')
    const qrUrl = bookingQrUrl(v.booking_qr_token, 'ar')
    const invoiceLink = invoiceUrl(v.invoice_token, 'ar')
    return joinLines(
      '✅ *تم تأكيد حجزك*',
      '',
      greeting(v, 'ar'),
      '',
      'تم تأكيد حجزك وتسجيل دفعتك بنجاح.',
      '',
      line('🏟️', 'الملعب', v.field_name),
      line('⚽', 'النشاط', sportLabel(v.sport, 'ar')),
      line('📅', 'التاريخ', date),
      line('🕐', 'الوقت', time),
      line('🔖', 'رقم الحجز', v.booking_ref),
      '',
      line('💰', 'الإجمالي', total),
      line('✅', 'المدفوع', paid),
      // Business-messaging audit fix: only shown for a genuine positive
      // balance -- never for a fully-paid booking, where it would be a
      // confusing "outstanding: 0.00" line.
      line('⏳', 'المتبقي', outstanding),
      line('💳', 'طريقة الدفع', method),
      line('💳', 'حالة الدفع', paymentStatus),
      line('🧾', 'رقم الفاتورة', v.invoice_number),
      // Directive Sections 4/7: official collection receipt details --
      // only shown when this payment actually has one (government
      // clubs with a required-method match). Never internal
      // notes/audit metadata/image paths -- serial, book, series, date
      // only, exactly the fields the directive lists as safe to expose.
      isPresent(v.receipt_serial) ? '🏛️ *إيصال التحصيل الرسمي*' : '',
      line('🧾', 'رقم الإيصال', v.receipt_serial),
      line('📘', 'رقم الدفتر', v.receipt_book),
      line('🔢', 'السلسلة', v.receipt_series),
      line('📅', 'تاريخ الإيصال', receiptDateLabel(v.receipt_date, 'ar')),
      '',
      qrUrl ? `تفاصيل الحجز ورمز الحضور:\n${qrUrl}` : '',
      invoiceLink ? `عرض الفاتورة:\n${invoiceLink}` : '',
      '',
      'نتمنى لك وقتًا ممتعًا ⚽',
      '',
      brandLine(v, 'ar'),
    )
  },

  'booking-cancelled': (v) => {
    const tz = isPresent(v.timezone) ? String(v.timezone) : DEFAULT_TIMEZONE
    const date = isPresent(v.start_at) ? formatDate(String(v.start_at), tz, 'ar-EG') : null
    const time = isPresent(v.start_at) ? formatTime(String(v.start_at), tz, 'ar-EG') : null
    return joinLines(
      '❌ *تم إلغاء الحجز*',
      '',
      isPresent(v.booking_ref) ? `تم إلغاء حجزك رقم *${String(v.booking_ref)}*.` : 'تم إلغاء حجزك.',
      '',
      line('🏟️', 'الملعب', v.field_name),
      line('⚽', 'النشاط', sportLabel(v.sport, 'ar')),
      line('📅', 'التاريخ', date),
      line('🕐', 'الوقت', time),
      isPresent(v.reason) ? `\nالسبب: ${String(v.reason)}` : '',
      '',
      'إذا كنت بحاجة إلى حجز موعد آخر، يمكنك إنشاء حجز جديد من خلال ملعبي.',
      '',
      brandLine(v, 'ar'),
    )
  },

  'payment-received': (v) => {
    const amount = formatMoney(v.amount, 'ج.م', 'EGP', 'ar')
    const outstanding = formatMoney(outstandingAmount(v.remaining_outstanding, v.total_price, v.amount_paid), 'ج.م', 'EGP', 'ar')
    const paymentStatus = paymentStatusLabel(v.payment_status, 'ar')
    const method = paymentMethodLabel(v.method, 'ar')
    const invoiceLink = invoiceUrl(v.invoice_token, 'ar')
    return joinLines(
      '✅ *تم استلام دفعتك بنجاح*',
      '',
      'تم تسجيل الدفع الخاص بحجزك.',
      '',
      line('💰', 'المبلغ', amount),
      line('💳', 'طريقة الدفع', method),
      line('🔖', 'رقم الحجز', v.booking_ref),
      line('🧾', 'رقم الفاتورة', v.invoice_number),
      line('💳', 'حالة الدفع', paymentStatus),
      // Business-messaging audit fix (directive rule 12): only shown for
      // a genuine positive balance -- never for a fully-paid invoice.
      line('⏳', 'المتبقي', outstanding),
      isPresent(v.receipt_serial) ? '🏛️ *إيصال التحصيل الرسمي*' : '',
      line('🧾', 'رقم الإيصال', v.receipt_serial),
      line('📘', 'رقم الدفتر', v.receipt_book),
      line('🔢', 'السلسلة', v.receipt_series),
      line('📅', 'تاريخ الإيصال', receiptDateLabel(v.receipt_date, 'ar')),
      '',
      invoiceLink ? `عرض الفاتورة:\n${invoiceLink}` : '',
      '',
      'شكرًا لك.',
      '',
      brandLine(v, 'ar'),
    )
  },

  /**
   * Academy identity (Sections 14/28-35): distinct headline from Field
   * Booking's payment-received, ALWAYS names the specific player
   * (Section 29 -- a guardian may have multiple children, so
   * "دفعتك"/"your payment" alone is never enough), and picks between
   * "دفعة" (partial, Section 34) vs "استكمال دفع" (final/full, Section
   * 35) wording based on the real resulting payment_status --
   * record_payment() computes this the identical way it does for
   * payment-received ('paid' when the invoice's new outstanding
   * balance is <= 0, 'partially_paid' otherwise), so this is never
   * guessed independently of the actual invoice state.
   */
  'academy-payment-received': (v) => {
    const isFinal = v.payment_status === 'paid'
    const playerName = isPresent(v.player_name) ? String(v.player_name) : null
    const amount = formatMoney(v.amount, 'ج.م', 'EGP', 'ar')
    const outstanding = formatMoney(outstandingAmount(v.remaining_outstanding, v.total_price, v.amount_paid), 'ج.م', 'EGP', 'ar')
    const paymentStatus = paymentStatusLabel(v.payment_status, 'ar')
    const method = paymentMethodLabel(v.method, 'ar')
    const startDate = isPresent(v.subscription_start_date) ? formatCalendarDate(String(v.subscription_start_date), 'ar-EG') : null
    const endDate = isPresent(v.subscription_end_date) ? formatCalendarDate(String(v.subscription_end_date), 'ar-EG') : null
    const invoiceLink = invoiceUrl(v.invoice_token, 'ar')
    return joinLines(
      isFinal ? '🏅 *تم استكمال دفع اشتراك اللاعب*' : '🏅 *تم تسجيل دفعة لاشتراك اللاعب*',
      '',
      greeting(v, 'ar'),
      '',
      playerName
        ? (isFinal ? `تم استكمال دفع اشتراك اللاعب *${playerName}* بنجاح.` : `تم تسجيل دفعة لاشتراك اللاعب *${playerName}*.`)
        : (isFinal ? 'تم استكمال دفع الاشتراك بنجاح.' : 'تم تسجيل دفعة للاشتراك.'),
      '',
      line('🏅', 'اللاعب', playerName),
      line('🏫', 'الأكاديمية/المجموعة', v.group_name),
      startDate && endDate ? `📅 *مدة الاشتراك:* ${startDate} — ${endDate}` : '',
      '',
      line('💰', 'المبلغ المدفوع الآن', amount),
      line('💳', 'طريقة الدفع', method),
      line('🧾', 'رقم الفاتورة', v.invoice_number),
      line('💳', 'حالة الدفع', paymentStatus),
      line('⏳', 'المتبقي', outstanding),
      isPresent(v.receipt_serial) ? '🏛️ *إيصال التحصيل الرسمي*' : '',
      line('🧾', 'رقم الإيصال', v.receipt_serial),
      line('📘', 'رقم الدفتر', v.receipt_book),
      line('🔢', 'السلسلة', v.receipt_series),
      line('📅', 'تاريخ الإيصال', receiptDateLabel(v.receipt_date, 'ar')),
      '',
      invoiceLink ? `عرض الفاتورة:\n${invoiceLink}` : '',
      '',
      'شكرًا لك.',
      '',
      brandLine(v, 'ar'),
    )
  },

  'payment-refunded': (v) => {
    const amount = formatMoney(v.amount, 'ج.م', 'EGP', 'ar')
    return joinLines(
      '💰 *تم تسجيل استرداد المبلغ*',
      '',
      isPresent(v.booking_ref) ? `تم تسجيل استرداد مرتبط بالحجز رقم *${String(v.booking_ref)}*.` : 'تم تسجيل استرداد مرتبط بحسابك.',
      '',
      line('💵', 'المبلغ المسترد', amount),
      line('🧾', 'رقم الفاتورة', v.invoice_number),
      '',
      'قد يختلف وقت ظهور المبلغ في حسابك حسب وسيلة الدفع المستخدمة.',
      '',
      brandLine(v, 'ar'),
    )
  },

}

const EN: Record<TemplateKey, Renderer> = {
  'booking-created': (v) => {
    const tz = isPresent(v.timezone) ? String(v.timezone) : DEFAULT_TIMEZONE
    const date = isPresent(v.start_at) ? formatDate(String(v.start_at), tz, 'en-US') : null
    const time = isPresent(v.start_at) ? formatTime(String(v.start_at), tz, 'en-US') : null
    const qrUrl = bookingQrUrl(v.booking_qr_token, 'en')
    return joinLines(
      '📝 *Booking request received*',
      '',
      greeting(v, 'en'),
      '',
      'We received your booking request. Here are the details:',
      '',
      line('🏟️', 'Field', v.field_name),
      line('⚽', 'Sport', sportLabel(v.sport, 'en')),
      line('📅', 'Date', date),
      line('🕐', 'Time', time),
      line('🔖', 'Booking #', v.booking_ref),
      line('📌', 'Status', 'Awaiting confirmation'),
      '',
      "We'll message you again once your booking is confirmed.",
      '',
      qrUrl ? `Check-in code:\n${qrUrl}` : '',
      '',
      brandLine(v, 'en'),
    )
  },

  /** English mirror of AR's 'booking-confirmed-paid' -- see its doc comment for the full duplicate-message-fix rationale. */
  'booking-confirmed-paid': (v) => {
    const tz = isPresent(v.timezone) ? String(v.timezone) : DEFAULT_TIMEZONE
    const date = isPresent(v.start_at) ? formatDate(String(v.start_at), tz, 'en-US') : null
    const time = isPresent(v.start_at) ? formatTime(String(v.start_at), tz, 'en-US') : null
    const total = formatMoney(v.total_price, 'ج.م', 'EGP', 'en')
    const paid = formatMoney(v.amount_paid, 'ج.م', 'EGP', 'en')
    const outstanding = formatMoney(outstandingAmount(v.remaining_outstanding, v.total_price, v.amount_paid), 'ج.م', 'EGP', 'en')
    const paymentStatus = paymentStatusLabel(v.payment_status, 'en')
    const method = paymentMethodLabel(v.method, 'en')
    const qrUrl = bookingQrUrl(v.booking_qr_token, 'en')
    const invoiceLink = invoiceUrl(v.invoice_token, 'en')
    return joinLines(
      '✅ *Booking confirmed*',
      '',
      greeting(v, 'en'),
      '',
      'Your booking is confirmed and your payment has been recorded.',
      '',
      line('🏟️', 'Field', v.field_name),
      line('⚽', 'Sport', sportLabel(v.sport, 'en')),
      line('📅', 'Date', date),
      line('🕐', 'Time', time),
      line('🔖', 'Booking #', v.booking_ref),
      '',
      line('💰', 'Total', total),
      line('✅', 'Paid', paid),
      line('⏳', 'Outstanding', outstanding),
      line('💳', 'Method', method),
      line('💳', 'Payment status', paymentStatus),
      line('🧾', 'Invoice #', v.invoice_number),
      isPresent(v.receipt_serial) ? '🏛️ *Official Collection Receipt*' : '',
      line('🧾', 'Receipt #', v.receipt_serial),
      line('📘', 'Book', v.receipt_book),
      line('🔢', 'Series', v.receipt_series),
      line('📅', 'Receipt date', receiptDateLabel(v.receipt_date, 'en')),
      '',
      qrUrl ? `View booking details and entry code:\n${qrUrl}` : '',
      invoiceLink ? `View invoice:\n${invoiceLink}` : '',
      '',
      'See you there ⚽',
      '',
      brandLine(v, 'en'),
    )
  },

  'booking-cancelled': (v) => {
    const tz = isPresent(v.timezone) ? String(v.timezone) : DEFAULT_TIMEZONE
    const date = isPresent(v.start_at) ? formatDate(String(v.start_at), tz, 'en-US') : null
    const time = isPresent(v.start_at) ? formatTime(String(v.start_at), tz, 'en-US') : null
    return joinLines(
      '❌ *Booking cancelled*',
      '',
      isPresent(v.booking_ref) ? `Your booking *${String(v.booking_ref)}* was cancelled.` : 'Your booking was cancelled.',
      '',
      line('🏟️', 'Field', v.field_name),
      line('⚽', 'Sport', sportLabel(v.sport, 'en')),
      line('📅', 'Date', date),
      line('🕐', 'Time', time),
      isPresent(v.reason) ? `\nReason: ${String(v.reason)}` : '',
      '',
      'You can create a new booking any time through Mal3aby.',
      '',
      brandLine(v, 'en'),
    )
  },

  'payment-received': (v) => {
    const amount = formatMoney(v.amount, 'ج.م', 'EGP', 'en')
    const outstanding = formatMoney(outstandingAmount(v.remaining_outstanding, v.total_price, v.amount_paid), 'ج.م', 'EGP', 'en')
    const paymentStatus = paymentStatusLabel(v.payment_status, 'en')
    const method = paymentMethodLabel(v.method, 'en')
    const invoiceLink = invoiceUrl(v.invoice_token, 'en')
    return joinLines(
      '✅ *Payment received*',
      '',
      'Your payment has been recorded.',
      '',
      line('💰', 'Amount', amount),
      line('💳', 'Method', method),
      line('🔖', 'Booking #', v.booking_ref),
      line('🧾', 'Invoice #', v.invoice_number),
      line('💳', 'Payment status', paymentStatus),
      line('⏳', 'Outstanding', outstanding),
      isPresent(v.receipt_serial) ? '🏛️ *Official Collection Receipt*' : '',
      line('🧾', 'Receipt #', v.receipt_serial),
      line('📘', 'Book', v.receipt_book),
      line('🔢', 'Series', v.receipt_series),
      line('📅', 'Receipt date', receiptDateLabel(v.receipt_date, 'en')),
      '',
      invoiceLink ? `View invoice:\n${invoiceLink}` : '',
      '',
      'Thank you.',
      '',
      brandLine(v, 'en'),
    )
  },

  /** English mirror of AR's 'academy-payment-received' -- see its doc comment for the full identity/wording rationale. */
  'academy-payment-received': (v) => {
    const isFinal = v.payment_status === 'paid'
    const playerName = isPresent(v.player_name) ? String(v.player_name) : null
    const amount = formatMoney(v.amount, 'ج.م', 'EGP', 'en')
    const outstanding = formatMoney(outstandingAmount(v.remaining_outstanding, v.total_price, v.amount_paid), 'ج.م', 'EGP', 'en')
    const paymentStatus = paymentStatusLabel(v.payment_status, 'en')
    const method = paymentMethodLabel(v.method, 'en')
    const startDate = isPresent(v.subscription_start_date) ? formatCalendarDate(String(v.subscription_start_date), 'en-US') : null
    const endDate = isPresent(v.subscription_end_date) ? formatCalendarDate(String(v.subscription_end_date), 'en-US') : null
    const invoiceLink = invoiceUrl(v.invoice_token, 'en')
    return joinLines(
      isFinal ? '🏅 *Academy subscription payment complete*' : '🏅 *Academy payment recorded*',
      '',
      greeting(v, 'en'),
      '',
      playerName
        ? (isFinal ? `Payment for *${playerName}*'s academy subscription is now complete.` : `A payment was recorded for *${playerName}*'s academy subscription.`)
        : (isFinal ? 'Payment for the academy subscription is now complete.' : 'A payment was recorded for the academy subscription.'),
      '',
      line('🏅', 'Player', playerName),
      line('🏫', 'Academy/Group', v.group_name),
      startDate && endDate ? `📅 *Subscription period:* ${startDate} — ${endDate}` : '',
      '',
      line('💰', 'Amount paid now', amount),
      line('💳', 'Method', method),
      line('🧾', 'Invoice #', v.invoice_number),
      line('💳', 'Payment status', paymentStatus),
      line('⏳', 'Outstanding', outstanding),
      isPresent(v.receipt_serial) ? '🏛️ *Official Collection Receipt*' : '',
      line('🧾', 'Receipt #', v.receipt_serial),
      line('📘', 'Book', v.receipt_book),
      line('🔢', 'Series', v.receipt_series),
      line('📅', 'Receipt date', receiptDateLabel(v.receipt_date, 'en')),
      '',
      invoiceLink ? `View invoice:\n${invoiceLink}` : '',
      '',
      'Thank you.',
      '',
      brandLine(v, 'en'),
    )
  },

  'payment-refunded': (v) => {
    const amount = formatMoney(v.amount, 'ج.م', 'EGP', 'en')
    return joinLines(
      '💰 *Refund recorded*',
      '',
      isPresent(v.booking_ref) ? `A refund was recorded for booking *${String(v.booking_ref)}*.` : 'A refund was recorded on your account.',
      '',
      line('💵', 'Refunded amount', amount),
      line('🧾', 'Invoice #', v.invoice_number),
      '',
      'The time it takes to appear in your account depends on your payment method.',
      '',
      brandLine(v, 'en'),
    )
  },

}

export function renderTemplate(templateKey: string, language: string, variables: Record<string, unknown>): string {
  const table = language === 'en' ? EN : AR
  const renderer = table[templateKey as TemplateKey]
  if (!renderer) {
    throw new Error(`Unknown WhatsApp template_key: ${templateKey}`)
  }
  return renderer(variables ?? {})
}
