/**
 * templates.test.ts -- automated formatter/template tests (Owner-Level
 * Review directive rule 24). Plain node assertions, following this
 * package's existing selfTest.ts pattern (no vitest/jest dependency in
 * this separate npm package). Run with: npx tsx src/templates.test.ts
 *
 * Covers exactly the required cases: raw ISO never leaking through,
 * missing customer name never rendering "null"/"undefined", missing
 * sport dropping its line entirely, unformatted money never appearing,
 * raw enum status values never appearing, the "ملعب ملعب 1" duplication
 * never reproducing, and a full booking-created message containing the
 * expected structural pieces.
 */
import assert from 'node:assert/strict'
import { renderTemplate } from './templates.js'

let passed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`[templates.test] PASS: ${name}`)
  } catch (err) {
    console.error(`[templates.test] FAIL: ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

const BASE_VARS = {
  field_name: 'ملعب 1',
  sport: 'كرة قدم',
  start_at: '2026-08-17T07:00:00+00:00', // 09:00 Africa/Cairo (UTC+2 in this test's fixed dataset window)
  end_at: '2026-08-17T08:00:00+00:00',
  total_price: 220,
  invoice_number: 'QAFULL-MAIN-2026-000030',
  payment_status: 'unpaid',
  club_name: 'نادي الاختبار الشامل',
  customer_name: 'مصطفى',
  timezone: 'Africa/Cairo',
  booking_ref: 'MB-1A2B3C4D',
}

check('booking-created never leaks a raw ISO timestamp', () => {
  const msg = renderTemplate('booking-created', 'ar', BASE_VARS)
  assert.ok(!msg.includes('2026-08-17T07:00:00'), 'raw ISO string leaked into the rendered message')
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(msg), 'an ISO-shaped timestamp leaked into the rendered message')
})

check('booking-created formats the date and time as real venue-local text', () => {
  const msg = renderTemplate('booking-created', 'ar', BASE_VARS)
  assert.ok(msg.includes('أغسطس'), 'expected an Arabic month name in the formatted date')
  // ar-EG renders clock digits as Arabic-Indic numerals (same convention
  // the rest of the app already uses, e.g. formatMoney's ar-EG locale) --
  // match on the ص/م (AM/PM) marker plus a colon-separated numeral pair
  // in either digit system, not ASCII \d specifically.
  assert.ok(/[\d٠-٩]{1,2}:[\d٠-٩]{2}\s*(ص|م)/.test(msg), 'expected a formatted 12-hour time with ص/م in the message')
})

check('missing customer_name never renders "null"/"undefined" in the greeting', () => {
  const vars = { ...BASE_VARS, customer_name: undefined }
  const msg = renderTemplate('booking-created', 'ar', vars)
  assert.ok(!msg.includes('null'), 'rendered "null" for a missing customer name')
  assert.ok(!msg.includes('undefined'), 'rendered "undefined" for a missing customer name')
  assert.ok(msg.includes('مرحبًا 👋'), 'expected the no-name greeting fallback')
})

check('missing sport drops the النشاط line entirely, not a labeled empty value', () => {
  const vars = { ...BASE_VARS, sport: null }
  const msg = renderTemplate('booking-created', 'ar', vars)
  assert.ok(!msg.includes('النشاط'), 'the sport line should not render at all when sport is missing')
})

check('money is always formatted, never a raw unformatted number', () => {
  const msg = renderTemplate('payment-received', 'ar', { ...BASE_VARS, amount: 500, method: 'cash' })
  assert.ok(!msg.includes('500.000000'), 'unformatted money leaked into the message')
  // ar-EG renders both the amount AND the decimal separator using
  // Arabic-Indic numerals/glyphs (e.g. "٥٠٠٫٠٠ ج.م") -- match on the
  // currency suffix plus the presence of exactly 2 fraction digits in
  // either numeral system, not a specific ASCII pattern.
  assert.ok(msg.includes('ج.م'), 'expected the ج.م currency suffix')
  assert.ok(/[\d٠-٩]+[.٫][\d٠-٩]{2}\s*ج\.م/.test(msg), 'expected properly formatted money with exactly 2 fraction digits before the ج.م suffix')
})

check('payment status never renders as a raw enum value', () => {
  const msg = renderTemplate('payment-received', 'ar', { ...BASE_VARS, amount: 220, payment_status: 'paid', method: 'cash' })
  assert.ok(!msg.includes('*حالة الدفع:* paid'), 'raw enum "paid" leaked into the message')
  assert.ok(msg.includes('مدفوعة بالكامل'), 'expected the human Arabic label for paid')
})

check('booking status/payment status enums used elsewhere never leak raw', () => {
  const msg = renderTemplate('booking-confirmed-paid', 'ar', { ...BASE_VARS, payment_status: 'partially_paid' })
  assert.ok(!msg.includes('partially_paid'), 'raw enum leaked into booking-confirmed-paid message')
  assert.ok(msg.includes('مدفوعة جزئيًا'), 'expected the human Arabic label for partially_paid')
})

check('field name is never duplicated with a hardcoded "ملعب" prefix', () => {
  const msg = renderTemplate('booking-created', 'ar', { ...BASE_VARS, field_name: 'ملعب 1' })
  assert.ok(!msg.includes('ملعب ملعب 1'), 'the classic duplication bug reproduced')
  assert.ok(msg.includes('ملعب 1'), 'the field name itself should still appear once')
})

check('a full booking-created message contains all required structural pieces (acceptance example)', () => {
  const msg = renderTemplate('booking-created', 'ar', BASE_VARS)
  assert.ok(msg.includes('📝 *تم استلام طلب الحجز*'), 'missing title line')
  assert.ok(msg.includes('مرحبًا مصطفى 👋'), 'missing personalized greeting')
  assert.ok(msg.includes('🏟️ *الملعب:* ملعب 1'), 'missing field line')
  assert.ok(msg.includes('⚽ *النشاط:* كرة قدم'), 'missing sport line')
  assert.ok(msg.includes('🔖 *رقم الحجز:* MB-1A2B3C4D'), 'missing booking reference line')
  assert.ok(msg.includes('📌 *الحالة:* بانتظار التأكيد'), 'missing status line')
  assert.ok(msg.includes('*نادي الاختبار الشامل عبر ملعبي*'), 'missing club-branded footer')
})

check('missing club_name falls back to the plain ملعبي brand, not a blank/null value', () => {
  const msg = renderTemplate('booking-created', 'ar', { ...BASE_VARS, club_name: undefined })
  assert.ok(msg.includes('*ملعبي*'), 'expected the generic ملعبي fallback brand line')
  assert.ok(!msg.includes('null عبر ملعبي'), 'null leaked into the brand line')
})

check('English variant renders without Arabic leaking through and with the same structural pieces', () => {
  const msg = renderTemplate('booking-created', 'en', BASE_VARS)
  assert.ok(msg.includes('Booking request received'), 'missing English title')
  assert.ok(!msg.includes('2026-08-17T07:00:00'), 'raw ISO leaked into the English message')
  assert.ok(msg.includes('August'), 'expected an English month name in the formatted date')
})

check('booking-cancelled includes the reason only when provided, never a stray blank line otherwise', () => {
  const withReason = renderTemplate('booking-cancelled', 'ar', { ...BASE_VARS, reason: 'العميل طلب الإلغاء' })
  assert.ok(withReason.includes('السبب: العميل طلب الإلغاء'), 'missing reason line when reason is provided')
  const withoutReason = renderTemplate('booking-cancelled', 'ar', { ...BASE_VARS, reason: undefined })
  assert.ok(!withoutReason.includes('السبب:'), 'reason label rendered even though no reason was provided')
})

check('payment-refunded never promises a refund timing guarantee beyond the documented disclaimer', () => {
  const msg = renderTemplate('payment-refunded', 'ar', { ...BASE_VARS, amount: 100, reason: 'إلغاء الحجز' })
  assert.ok(msg.includes('قد يختلف وقت ظهور المبلغ'), 'missing the honest refund-timing disclaimer')
})

check('unknown template_key throws rather than silently rendering nothing', () => {
  assert.throws(() => renderTemplate('not-a-real-key', 'ar', BASE_VARS))
})

// ----------------------------------------------------------------
// WhatsApp secure links directive (rules 17/19): booking-created/
// booking-confirmed-paid must carry a QR check-in link when a token is
// present, payment-received must carry an invoice link. All must NEVER
// include one when the token is absent. (booking-confirmed and
// invoice-created were removed as dead/fragmenting templates -- see
// templates.ts's TemplateKey doc comment, business-messaging-hardening
// 2026-08-22 -- their coverage below now targets the surviving
// booking-confirmed-paid/payment-received templates instead.)
// ----------------------------------------------------------------

check('booking-created includes a /qr/ link when booking_qr_token is present', () => {
  const msg = renderTemplate('booking-created', 'ar', { ...BASE_VARS, booking_qr_token: 'abc123deadbeef' })
  assert.ok(msg.includes('/qr/abc123deadbeef'), 'missing the booking QR link with the raw token in the path')
  assert.ok(msg.includes('رمز الحضور'), 'missing the Arabic QR-link label')
})

check('booking-created omits the QR link entirely when booking_qr_token is absent', () => {
  const msg = renderTemplate('booking-created', 'ar', BASE_VARS)
  assert.ok(!msg.includes('/qr/'), 'a QR link appeared with no token supplied')
  assert.ok(!msg.includes('رمز الحضور'), 'the QR-link label appeared with no token supplied')
})

check('booking-confirmed-paid includes a /qr/ link when booking_qr_token is present (ar + en)', () => {
  const ar = renderTemplate('booking-confirmed-paid', 'ar', { ...BASE_VARS, booking_qr_token: 'xyz789' })
  assert.ok(ar.includes('/qr/xyz789'), 'missing the booking QR link (ar)')
  const en = renderTemplate('booking-confirmed-paid', 'en', { ...BASE_VARS, booking_qr_token: 'xyz789' })
  assert.ok(en.includes('/qr/xyz789'), 'missing the booking QR link (en)')
  assert.ok(en.includes('entry code'), 'missing the English QR-link label')
})

check('payment-received includes a /verify/ link when invoice_token is present', () => {
  const msg = renderTemplate('payment-received', 'ar', { ...BASE_VARS, amount: 220, method: 'cash', invoice_token: 'invtok456' })
  assert.ok(msg.includes('/verify/invtok456'), 'missing the invoice verification link with the raw token in the path')
  assert.ok(msg.includes('عرض الفاتورة'), 'missing the Arabic invoice-link label')
})

check('payment-received omits the invoice link entirely when invoice_token is absent', () => {
  const msg = renderTemplate('payment-received', 'ar', { ...BASE_VARS, amount: 220, method: 'cash' })
  assert.ok(!msg.includes('/verify/'), 'an invoice link appeared with no token supplied')
})

check('payment-received includes a /verify/ link when invoice_token is present (ar + en)', () => {
  const ar = renderTemplate('payment-received', 'ar', { ...BASE_VARS, amount: 220, method: 'cash', invoice_token: 'invtok789' })
  assert.ok(ar.includes('/verify/invtok789'), 'missing the invoice verification link (ar)')
  const en = renderTemplate('payment-received', 'en', { ...BASE_VARS, amount: 220, method: 'cash', invoice_token: 'invtok789' })
  assert.ok(en.includes('/verify/invtok789'), 'missing the invoice verification link (en)')
})

check('booking-cancelled NEVER includes a QR link even if a stale booking_qr_token is somehow present', () => {
  // Directive rule 3/11: a cancellation message must never carry a
  // valid-looking QR link -- confirmed the renderer for this template
  // never reads booking_qr_token at all, so even a caller mistake
  // (passing a stale token through) can't leak a link into this
  // specific message.
  const msg = renderTemplate('booking-cancelled', 'ar', { ...BASE_VARS, booking_qr_token: 'should-never-appear' })
  assert.ok(!msg.includes('should-never-appear'), 'a QR token leaked into the cancellation message')
  assert.ok(!msg.includes('/qr/'), 'a QR link appeared in the cancellation message')
})

check('the token itself is never used as a bare value -- always embedded inside a /qr/ or /verify/ path', () => {
  // Directive rule 8: never authorize off a raw predictable value with
  // no path context -- confirms the rendered link always has the
  // /qr/<token> or /verify/<token> shape, not the token printed alone.
  const msg = renderTemplate('booking-created', 'ar', { ...BASE_VARS, booking_qr_token: 'sole-token-999' })
  const bareTokenLine = msg.split('\n').find((l) => l.trim() === 'sole-token-999')
  assert.ok(!bareTokenLine, 'the token appeared on its own line with no /qr/ path prefix')
})

// -----------------------------------------------------------------
// booking-rescheduled -- BOOKING ENGINE / AVAILABILITY / RESCHEDULING
// directive (2026-08-23): one new business event (reschedule), exactly
// one message, no QR image (a link only, same pattern as every other
// template here) -- see templates.ts's own doc comment for the full
// rationale.
const RESCHEDULE_VARS = {
  ...BASE_VARS,
  old_start_at: '2026-08-25T14:00:00+00:00',
  old_end_at: '2026-08-25T15:00:00+00:00',
  start_at: '2026-08-25T16:00:00+00:00',
  end_at: '2026-08-25T17:30:00+00:00',
  booking_qr_token: 'reschedule-test-token',
}

check('booking-rescheduled never leaks a raw ISO timestamp (old or new)', () => {
  const msg = renderTemplate('booking-rescheduled', 'ar', RESCHEDULE_VARS)
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(msg), 'an ISO-shaped timestamp leaked into the rescheduled message')
})

check('booking-rescheduled shows both the OLD and the NEW time, not just one', () => {
  // Directive: the customer-facing message must make clear something
  // changed, not just state a new time with no reference to what it
  // replaced.
  const ar = renderTemplate('booking-rescheduled', 'ar', RESCHEDULE_VARS)
  assert.ok(ar.includes('الموعد السابق'), 'missing the "previous time" label (ar)')
  assert.ok(ar.includes('الموعد الجديد'), 'missing the "new time" label (ar)')
  const en = renderTemplate('booking-rescheduled', 'en', RESCHEDULE_VARS)
  assert.ok(/previous|old/i.test(en), 'missing an old-time reference (en)')
  assert.ok(/new/i.test(en), 'missing a new-time reference (en)')
})

check('booking-rescheduled links to the QR page, never embeds a QR image', () => {
  // Directive section 44/87: "No QR image" -- this connector generates
  // zero QR images anywhere (QrImage.ts was deleted this session); this
  // asserts the rescheduled template specifically follows the same
  // link-only pattern as every other template, not an image attachment
  // reference of any kind.
  const msg = renderTemplate('booking-rescheduled', 'ar', RESCHEDULE_VARS)
  assert.ok(msg.includes('/qr/reschedule-test-token'), 'missing the expected /qr/<token> link')
  assert.ok(!/\.(png|jpg|jpeg)/i.test(msg), 'an image file reference leaked into the rescheduled message')
})

check('booking-rescheduled includes the booking reference so the customer can match it to their prior confirmation', () => {
  const msg = renderTemplate('booking-rescheduled', 'ar', RESCHEDULE_VARS)
  assert.ok(msg.includes(RESCHEDULE_VARS.booking_ref), 'missing the booking reference')
})

// -----------------------------------------------------------------
// CUSTOMER ACCOUNT / CLUB PORTAL -- ZERO-COST ACTIVATION (2026-08-23):
// booking-created and booking-confirmed-paid must carry the account
// activation CTA ONLY when activation_token is present (i.e. only when
// _create_booking_internal found no linked portal account for this
// customer at booking time) -- never a separate message, and never
// present at all for an already-activated customer's booking.
// -----------------------------------------------------------------

check('booking-created includes the activation CTA when activation_token is present (ar + en)', () => {
  const ar = renderTemplate('booking-created', 'ar', { ...BASE_VARS, activation_token: 'activate-test-token' })
  assert.ok(ar.includes('/activate/activate-test-token'), 'missing the expected /activate/<token> link (ar)')
  assert.ok(ar.includes('فعّل حسابك'), 'missing the Arabic activation CTA wording')
  const en = renderTemplate('booking-created', 'en', { ...BASE_VARS, activation_token: 'activate-test-token' })
  assert.ok(en.includes('/activate/activate-test-token'), 'missing the expected /activate/<token> link (en)')
  assert.ok(/activate your account/i.test(en), 'missing the English activation CTA wording')
})

check('booking-created omits the activation CTA entirely when activation_token is absent (already-activated customer)', () => {
  const ar = renderTemplate('booking-created', 'ar', BASE_VARS)
  assert.ok(!ar.includes('/activate/'), 'an activation link appeared even though activation_token was not provided (ar)')
  assert.ok(!ar.includes('فعّل حسابك'), 'the activation CTA wording appeared even though activation_token was not provided (ar)')
  const en = renderTemplate('booking-created', 'en', BASE_VARS)
  assert.ok(!en.includes('/activate/'), 'an activation link appeared even though activation_token was not provided (en)')
})

check('booking-confirmed-paid includes the activation CTA when activation_token is present, omits when absent (ar + en)', () => {
  const withToken = renderTemplate('booking-confirmed-paid', 'ar', { ...BASE_VARS, amount_paid: 220, method: 'cash', activation_token: 'activate-test-token' })
  assert.ok(withToken.includes('/activate/activate-test-token'), 'missing the expected /activate/<token> link')
  const withoutToken = renderTemplate('booking-confirmed-paid', 'ar', { ...BASE_VARS, amount_paid: 220, method: 'cash' })
  assert.ok(!withoutToken.includes('/activate/'), 'an activation link appeared even though activation_token was not provided')
})

// -----------------------------------------------------------------
// CUSTOMER ACTIVATION TAKEOVER GAP -- SECURITY CLOSURE (2026-08-23):
// the activation secret is an INDEPENDENT factor from the token --
// it must appear as plain text (never inside a URL/link) alongside
// the activation link, and must be entirely absent whenever
// activation_secret itself is absent (mirrors activation_token's own
// presence-gating, but is a wholly separate variable/check).
// -----------------------------------------------------------------

check('booking-created includes the activation secret as plain text, never inside a URL, when present (ar + en)', () => {
  const ar = renderTemplate('booking-created', 'ar', { ...BASE_VARS, activation_token: 'activate-test-token', activation_secret: 'K7M4-P9Q2' })
  assert.ok(ar.includes('K7M4-P9Q2'), 'missing the activation secret text (ar)')
  assert.ok(ar.includes('رمز التفعيل'), 'missing the Arabic activation-code label')
  assert.ok(!/\/activate\/[^\s]*K7M4-P9Q2/.test(ar), 'the activation secret leaked into the activation URL itself (ar)')
  const en = renderTemplate('booking-created', 'en', { ...BASE_VARS, activation_token: 'activate-test-token', activation_secret: 'K7M4-P9Q2' })
  assert.ok(en.includes('K7M4-P9Q2'), 'missing the activation secret text (en)')
  assert.ok(/activation code/i.test(en), 'missing the English activation-code label')
  assert.ok(!/\/activate\/[^\s]*K7M4-P9Q2/.test(en), 'the activation secret leaked into the activation URL itself (en)')
})

check('booking-created omits the activation secret entirely when activation_secret is absent, even if activation_token is present', () => {
  const ar = renderTemplate('booking-created', 'ar', { ...BASE_VARS, activation_token: 'activate-test-token' })
  assert.ok(!ar.includes('رمز التفعيل'), 'the activation-code label appeared even though activation_secret was not provided (ar)')
  const en = renderTemplate('booking-created', 'en', { ...BASE_VARS, activation_token: 'activate-test-token' })
  assert.ok(!/activation code/i.test(en), 'the activation-code label appeared even though activation_secret was not provided (en)')
})

check('booking-confirmed-paid includes the activation secret as plain text when present, omits when absent (ar + en)', () => {
  const withSecret = renderTemplate('booking-confirmed-paid', 'ar', { ...BASE_VARS, amount_paid: 220, method: 'cash', activation_token: 'activate-test-token', activation_secret: 'K7M4-P9Q2' })
  assert.ok(withSecret.includes('K7M4-P9Q2'), 'missing the activation secret text')
  assert.ok(!/\/activate\/[^\s]*K7M4-P9Q2/.test(withSecret), 'the activation secret leaked into the activation URL itself')
  const withoutSecret = renderTemplate('booking-confirmed-paid', 'ar', { ...BASE_VARS, amount_paid: 220, method: 'cash', activation_token: 'activate-test-token' })
  assert.ok(!withoutSecret.includes('رمز التفعيل'), 'the activation-code label appeared even though activation_secret was not provided')
})

check('the activation secret is never logged by templates.ts -- rendering never triggers console output as a side effect', () => {
  // templates.ts is a pure string-building module (no console.*/logger
  // calls anywhere in its render path) -- this test asserts that
  // invariant holds by spying on console.log/console.error around a
  // render call that includes a secret, rather than grepping source
  // text, so a future accidental `console.log(vars)` debug statement
  // added to templates.ts would fail this test immediately.
  const originalLog = console.log
  const originalError = console.error
  const calls: unknown[] = []
  console.log = (...args: unknown[]) => { calls.push(args) }
  console.error = (...args: unknown[]) => { calls.push(args) }
  try {
    renderTemplate('booking-created', 'ar', { ...BASE_VARS, activation_token: 'activate-test-token', activation_secret: 'K7M4-P9Q2' })
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  assert.strictEqual(calls.length, 0, 'rendering a template with an activation secret produced console output -- the secret must never be logged')
})

check('the booking-created and booking-confirmed-paid messages never carry two separate CTAs when both QR and activation are present -- exactly one message, multiple sections is fine, but never a second standalone message marker', () => {
  // This is a structural sanity check, not a multi-message test (this
  // connector only ever renders one string per template call) -- it
  // confirms the activation CTA is additive content within the SAME
  // message, not something that duplicates the headline/greeting.
  const msg = renderTemplate('booking-created', 'ar', { ...BASE_VARS, activation_token: 'activate-test-token' })
  const headlineCount = (msg.match(/تم استلام طلب الحجز/g) ?? []).length
  assert.strictEqual(headlineCount, 1, 'the booking headline appeared more than once -- suggests a duplicated/concatenated message rather than one combined message')
})

// -----------------------------------------------------------------
// booking-confirmed-paid -- duplicate-message fix (directive Sections
// 22-24): the single merged message for a booking + same-transaction
// payment, replacing the old booking-created + booking-confirmed +
// payment-received trio.
// -----------------------------------------------------------------

const PAID_VARS = {
  ...BASE_VARS,
  amount_paid: 220,
  method: 'cash',
  booking_qr_token: 'qrtok-paid-1',
  invoice_token: 'invtok-paid-1',
}

check('booking-confirmed-paid contains booking, payment, and invoice details in one message (ar + en)', () => {
  const ar = renderTemplate('booking-confirmed-paid', 'ar', PAID_VARS)
  assert.ok(ar.includes('ملعب 1'), 'missing field name')
  assert.ok(ar.includes('MB-1A2B3C4D'), 'missing booking ref')
  assert.ok(ar.includes('QAFULL-MAIN-2026-000030'), 'missing invoice number')
  assert.ok(ar.includes('/qr/qrtok-paid-1'), 'missing QR link')
  assert.ok(ar.includes('/verify/invtok-paid-1'), 'missing invoice link')

  const en = renderTemplate('booking-confirmed-paid', 'en', PAID_VARS)
  assert.ok(en.includes('Booking confirmed'), 'missing English title')
  assert.ok(en.includes('MB-1A2B3C4D'), 'missing booking ref (en)')
  assert.ok(en.includes('/qr/qrtok-paid-1'), 'missing QR link (en)')
  assert.ok(en.includes('/verify/invtok-paid-1'), 'missing invoice link (en)')
})

check('booking-confirmed-paid formats money with Western digits in English, Arabic-Indic digits in Arabic (localization fix)', () => {
  // Regression test for a real bug found in this exact template: money
  // was always formatted with the 'ar-EG' locale regardless of message
  // language, so an English customer's amounts rendered as "٢٢٠.٠٠"
  // instead of "220.00" -- directive Section 38 (English mode must be
  // actually English, not just the labels).
  const en = renderTemplate('booking-confirmed-paid', 'en', PAID_VARS)
  assert.ok(en.includes('220.00'), 'expected Western-digit amount in the English message')
  assert.ok(!/[٠-٩]/.test(en), 'an Arabic-Indic digit leaked into the English message')

  const ar = renderTemplate('booking-confirmed-paid', 'ar', PAID_VARS)
  assert.ok(/[٠-٩]/.test(ar), 'expected Arabic-Indic digits in the Arabic message')
})

check('booking-confirmed-paid never leaks a raw ISO timestamp or unformatted money', () => {
  const msg = renderTemplate('booking-confirmed-paid', 'ar', PAID_VARS)
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(msg), 'an ISO-shaped timestamp leaked into the rendered message')
  assert.ok(!/\b220\b(?!\.00)/.test(msg), 'an unformatted raw amount leaked into the rendered message')
})

check('booking-confirmed-paid omits the invoice link when invoice_token is absent, but keeps the QR link', () => {
  const { invoice_token, ...withoutInvoiceToken } = PAID_VARS
  const msg = renderTemplate('booking-confirmed-paid', 'ar', withoutInvoiceToken)
  assert.ok(!msg.includes('/verify/'), 'an invoice link appeared with no token supplied')
  assert.ok(msg.includes('/qr/qrtok-paid-1'), 'the QR link should still be present')
})

// -----------------------------------------------------------------
// Business-messaging audit fix (directive rule 12 "Partial payment is
// not full payment" / Section 15): a customer receiving a
// partially-paid confirmation must be told, explicitly, how much is
// still owed -- not just a translated "partially paid" status label
// that gives no number. Covers both booking-confirmed-paid (a payment
// recorded in the SAME transaction as booking creation, which only
// ever carries total_price/amount_paid -- no separate
// remaining_outstanding field) and payment-received (a later,
// independent payment via record_payment(), which DOES pass
// remaining_outstanding directly from the RPC).
// -----------------------------------------------------------------

const PARTIALLY_PAID_VARS = {
  ...PAID_VARS,
  amount_paid: 100, // total_price (from BASE_VARS) is 220 -- 120 still owed
  payment_status: 'partially_paid',
}

check('booking-confirmed-paid shows the real outstanding balance for a partial payment (ar + en)', () => {
  const ar = renderTemplate('booking-confirmed-paid', 'ar', PARTIALLY_PAID_VARS)
  assert.ok(ar.includes('المتبقي'), 'expected an outstanding-balance line in the Arabic message')
  assert.ok(ar.includes('120.00') || ar.includes('١٢٠٫٠٠') || ar.includes('١٢٠.٠٠'), 'expected the correct 120.00 outstanding amount (220 total - 100 paid)')

  const en = renderTemplate('booking-confirmed-paid', 'en', PARTIALLY_PAID_VARS)
  assert.ok(en.includes('Outstanding'), 'expected an outstanding-balance line in the English message')
  assert.ok(en.includes('120.00'), 'expected the correct 120.00 outstanding amount in English')
})

check('booking-confirmed-paid NEVER shows an outstanding-balance line for a fully-paid booking', () => {
  // PAID_VARS itself is fully paid: total_price=220 (BASE_VARS), amount_paid=220.
  const ar = renderTemplate('booking-confirmed-paid', 'ar', PAID_VARS)
  assert.ok(!ar.includes('المتبقي'), 'an outstanding-balance line appeared for a fully-paid booking (should be silent, not "0.00")')

  const en = renderTemplate('booking-confirmed-paid', 'en', PAID_VARS)
  assert.ok(!en.includes('Outstanding'), 'an outstanding-balance line appeared for a fully-paid booking (should be silent, not "0.00")')
})

check('payment-received uses the RPC-provided remaining_outstanding directly when present (ar + en)', () => {
  // record_payment() passes remaining_outstanding explicitly -- this
  // must take priority over any total_price/amount_paid derivation,
  // since remaining_outstanding accounts for prior payments/refunds
  // this template call alone cannot see.
  const vars = { ...PAID_VARS, amount: 100, payment_status: 'partially_paid', remaining_outstanding: 75 }
  const ar = renderTemplate('payment-received', 'ar', vars)
  assert.ok(ar.includes('المتبقي'), 'expected an outstanding-balance line')
  assert.ok(ar.includes('75.00') || ar.includes('٧٥٫٠٠') || ar.includes('٧٥.٠٠'), 'expected the RPC-provided 75.00 outstanding amount, not a derived one')

  const en = renderTemplate('payment-received', 'en', vars)
  assert.ok(en.includes('75.00'), 'expected the RPC-provided 75.00 outstanding amount in English')
})

check('payment-received omits the outstanding-balance line when remaining_outstanding is zero (fully paid)', () => {
  const vars = { ...PAID_VARS, amount: 220, payment_status: 'paid', remaining_outstanding: 0 }
  const ar = renderTemplate('payment-received', 'ar', vars)
  assert.ok(!ar.includes('المتبقي'), 'an outstanding-balance line appeared despite remaining_outstanding=0')
})

// -----------------------------------------------------------------
// Business-messaging audit fix (directive Section 29 "no ملعب ملعب/
// football-in-Arabic bug" -- localize the actual taxonomy source):
// fields.sport is a real free-text DB column, confirmed live to store
// raw English-ish values like "football"/"basketball"/"padel" (not the
// already-Arabic string BASE_VARS happens to use, which never actually
// exercised this path). An Arabic message must show "كرة قدم", not the
// literal English word.
// -----------------------------------------------------------------

// -----------------------------------------------------------------
// Real bug found live during this audit (2026-08-22): every single
// template that shows a field name rendered the "🏟️ *الملعب:*"/
// "🏟️ *Field:*" line TWICE (a duplicated line() call, present in all
// 4 Arabic and all 4 English templates) -- a real customer would have
// seen the field name repeated back-to-back in every booking message.
// The pre-existing .includes(...) assertions never caught this since
// they only check presence, not exact occurrence count.
// -----------------------------------------------------------------

check('the field name line never appears more than once in any template', () => {
  const templates = ['booking-created', 'booking-confirmed-paid', 'booking-cancelled'] as const
  for (const key of templates) {
    for (const lang of ['ar', 'en'] as const) {
      const msg = renderTemplate(key, lang, PAID_VARS)
      const fieldLabel = lang === 'ar' ? 'الملعب' : 'Field'
      const occurrences = msg.split(fieldLabel).length - 1
      assert.ok(occurrences <= 1, `${key} (${lang}) showed the field name line ${occurrences} times, expected at most 1`)
    }
  }
})

check('a raw "football" sport value renders as localized Arabic in an Arabic message', () => {
  const msg = renderTemplate('booking-created', 'ar', { ...BASE_VARS, sport: 'football' })
  assert.ok(msg.includes('كرة قدم'), 'expected the localized Arabic sport label')
  assert.ok(!msg.includes('football'), 'the raw English sport value leaked into the Arabic message')
})

check('a raw "football" sport value renders as "Football" in an English message', () => {
  const msg = renderTemplate('booking-created', 'en', { ...BASE_VARS, sport: 'football' })
  assert.ok(msg.includes('Football'), 'expected the capitalized English sport label')
})

check('an unrecognized free-text sport value falls back to showing the raw text, never blanked', () => {
  // fields.sport has no DB-level enum constraint -- a club can type
  // anything. An unmapped value must still show real information to
  // the customer, not silently disappear (unlike a genuinely optional
  // field like customer_name, which correctly drops when absent).
  const msg = renderTemplate('booking-created', 'ar', { ...BASE_VARS, sport: 'squash' })
  assert.ok(msg.includes('squash'), 'an unrecognized sport value was dropped instead of falling back to the raw text')
})

check('basketball and padel both localize correctly in Arabic', () => {
  const basketball = renderTemplate('booking-created', 'ar', { ...BASE_VARS, sport: 'basketball' })
  assert.ok(basketball.includes('كرة سلة'), 'expected the localized Arabic label for basketball')
  const padel = renderTemplate('booking-created', 'ar', { ...BASE_VARS, sport: 'padel' })
  assert.ok(padel.includes('بادل'), 'expected the localized Arabic label for padel')
})

check('payment-received never shows a negative or nonsensical outstanding amount', () => {
  // A refund or an overpayment could in principle push a naive
  // total-minus-paid derivation negative -- must never surface that to
  // a customer as "outstanding: -30.00".
  const vars = { ...PAID_VARS, amount_paid: 250, total_price: 220 } // overpaid by 30, no explicit remaining_outstanding
  const msg = renderTemplate('booking-confirmed-paid', 'ar', vars)
  assert.ok(!msg.includes('المتبقي'), 'a negative/overpaid outstanding line leaked through instead of being suppressed')
})

// Master Operational Simplification directive Sections 4/7: official
// collection receipt details must appear in the customer WhatsApp
// message for government-club payments, but never for non-government
// payments (no receipt fields supplied).
const RECEIPT_VARS = {
  ...PAID_VARS,
  receipt_serial: 'GOV-2026-004521',
  receipt_book: 'B12',
  receipt_series: 'S3',
  receipt_date: '2026-08-20',
}

check('booking-confirmed-paid includes official receipt details when present (ar + en)', () => {
  const ar = renderTemplate('booking-confirmed-paid', 'ar', RECEIPT_VARS)
  assert.ok(ar.includes('إيصال التحصيل الرسمي'), 'missing official receipt heading (ar)')
  assert.ok(ar.includes('GOV-2026-004521'), 'missing receipt serial (ar)')
  assert.ok(ar.includes('B12'), 'missing receipt book (ar)')
  assert.ok(ar.includes('S3'), 'missing receipt series (ar)')

  const en = renderTemplate('booking-confirmed-paid', 'en', RECEIPT_VARS)
  assert.ok(en.includes('Official Collection Receipt'), 'missing official receipt heading (en)')
  assert.ok(en.includes('GOV-2026-004521'), 'missing receipt serial (en)')
})

check('booking-confirmed-paid omits the receipt block entirely for non-government payments', () => {
  const msg = renderTemplate('booking-confirmed-paid', 'ar', PAID_VARS)
  assert.ok(!msg.includes('إيصال التحصيل الرسمي'), 'a receipt heading appeared with no receipt data supplied')
})

check('payment-received includes official receipt details when present, omits when absent', () => {
  const withReceipt = renderTemplate('payment-received', 'ar', { ...PAID_VARS, receipt_serial: 'GOV-2026-009', receipt_date: '2026-08-20' })
  assert.ok(withReceipt.includes('GOV-2026-009'), 'missing receipt serial in payment-received (ar)')

  const withoutReceipt = renderTemplate('payment-received', 'ar', PAID_VARS)
  assert.ok(!withoutReceipt.includes('إيصال التحصيل الرسمي'), 'a receipt heading appeared with no receipt data supplied')
})

// Real bug found during production QA acceptance testing (2026-08-22):
// receipt_date rendered as a raw unformatted SQL date string
// ("2026-08-22") in every template that shows it, while every other
// date in the same message was correctly localized -- confirmed live
// against a real production WhatsApp send before this fix.
check('the official receipt date is a real formatted date, never a raw SQL date string (ar + en, all three receipt-bearing templates)', () => {
  const rawDate = '2026-08-22'
  const receiptVars = { ...PAID_VARS, receipt_serial: 'GOV-2026-777', receipt_date: rawDate }

  for (const templateKey of ['booking-confirmed-paid', 'payment-received'] as const) {
    const ar = renderTemplate(templateKey, 'ar', receiptVars)
    assert.ok(!ar.includes(rawDate), `${templateKey} (ar) leaked the raw SQL receipt date string`)
    assert.ok(ar.includes('أغسطس'), `${templateKey} (ar) missing a real Arabic month name for the receipt date`)

    const en = renderTemplate(templateKey, 'en', receiptVars)
    assert.ok(!en.includes(rawDate), `${templateKey} (en) leaked the raw SQL receipt date string`)
    assert.ok(en.includes('August'), `${templateKey} (en) missing a real English month name for the receipt date`)
  }

  const academyVars = { customer_name: 'ولي الأمر', player_name: 'أحمد', group_name: 'الأكاديمية', amount: 100, method: 'cash', invoice_number: 'INV-1', payment_status: 'paid', receipt_serial: 'GOV-2026-778', receipt_date: rawDate }
  const academyAr = renderTemplate('academy-payment-received', 'ar', academyVars)
  assert.ok(!academyAr.includes(rawDate), 'academy-payment-received (ar) leaked the raw SQL receipt date string')
  assert.ok(academyAr.includes('أغسطس'), 'academy-payment-received (ar) missing a real Arabic month name for the receipt date')
})

// -----------------------------------------------------------------
// Secure Booking Page language hand-off (directive Sections 28-32/40):
// the /qr/ and /verify/ links must carry ?lang=ar|en matching the
// message's own language, so a first-time anonymous visitor's Secure
// Booking Page opens already in the right language instead of forcing
// a guess/re-detection.
// -----------------------------------------------------------------

check('booking-created (ar) QR link carries ?lang=ar', () => {
  const msg = renderTemplate('booking-created', 'ar', { ...BASE_VARS, booking_qr_token: 'qrtok-lang-1' })
  assert.ok(msg.includes('/qr/qrtok-lang-1?lang=ar'), 'expected ?lang=ar suffix on the AR booking-created QR link')
})

check('booking-created (en) QR link carries ?lang=en', () => {
  const msg = renderTemplate('booking-created', 'en', { ...BASE_VARS, booking_qr_token: 'qrtok-lang-2' })
  assert.ok(msg.includes('/qr/qrtok-lang-2?lang=en'), 'expected ?lang=en suffix on the EN booking-created QR link')
})

check('booking-confirmed-paid (ar) QR and invoice links both carry ?lang=ar', () => {
  const msg = renderTemplate('booking-confirmed-paid', 'ar', PAID_VARS)
  assert.ok(msg.includes('/qr/qrtok-paid-1?lang=ar'), 'expected ?lang=ar suffix on the QR link')
  assert.ok(msg.includes('/verify/invtok-paid-1?lang=ar'), 'expected ?lang=ar suffix on the invoice link')
})

check('booking-confirmed-paid (en) QR and invoice links both carry ?lang=en', () => {
  const msg = renderTemplate('booking-confirmed-paid', 'en', PAID_VARS)
  assert.ok(msg.includes('/qr/qrtok-paid-1?lang=en'), 'expected ?lang=en suffix on the QR link')
  assert.ok(msg.includes('/verify/invtok-paid-1?lang=en'), 'expected ?lang=en suffix on the invoice link')
})

// ----------------------------------------------------------------
// Academy message identity (Sections 14/28-35, added 2026-08-22):
// 'academy-payment-received' -- the first-ever Academy-specific
// WhatsApp template in this codebase. Must be clearly distinct from
// Field Booking's payment-received, must ALWAYS name the specific
// player, and must pick the right headline for partial vs final
// payment based on the real resulting payment_status.
// ----------------------------------------------------------------

const ACADEMY_VARS = {
  customer_name: 'ولي الأمر مصطفى',
  player_name: 'أحمد مصطفى',
  group_name: 'أكاديمية الناشئين',
  club_name: 'نادي الاختبار الشامل',
  amount: 300,
  method: 'cash',
  invoice_number: 'ACADEMY-2026-000001',
  subscription_start_date: '2026-09-01',
  subscription_end_date: '2026-10-01',
  payment_status: 'partially_paid',
  remaining_outstanding: 200,
  invoice_token: 'academytok123',
}

check('academy-payment-received names the specific player, never a generic "your payment" (ar + en)', () => {
  const ar = renderTemplate('academy-payment-received', 'ar', ACADEMY_VARS)
  assert.ok(ar.includes('أحمد مصطفى'), 'missing the player name in the Arabic Academy message')
  assert.ok(ar.includes('🏅'), 'missing the Academy identity emoji')
  const en = renderTemplate('academy-payment-received', 'en', { ...ACADEMY_VARS, player_name: 'Ahmed Mustafa' })
  assert.ok(en.includes('Ahmed Mustafa'), 'missing the player name in the English Academy message')
})

check('academy-payment-received is structurally distinct from payment-received (different headline)', () => {
  const academyMsg = renderTemplate('academy-payment-received', 'ar', ACADEMY_VARS)
  const bookingMsg = renderTemplate('payment-received', 'ar', { ...BASE_VARS, amount: 300, method: 'cash' })
  assert.notStrictEqual(academyMsg.split('\n')[0], bookingMsg.split('\n')[0], 'Academy and Field Booking payment messages must not share the same headline')
  assert.ok(!academyMsg.includes('تم استلام دفعتك بنجاح'), 'Academy message should not reuse the generic Field Booking payment headline')
})

check('academy-payment-received picks the partial-payment wording when not yet fully paid', () => {
  const msg = renderTemplate('academy-payment-received', 'ar', { ...ACADEMY_VARS, payment_status: 'partially_paid' })
  assert.ok(msg.includes('تم تسجيل دفعة لاشتراك اللاعب'), 'expected the partial-payment headline for a partially_paid academy payment')
  assert.ok(!msg.includes('تم استكمال دفع اشتراك اللاعب'), 'should not show the final-payment headline for a partial payment')
})

check('academy-payment-received picks the final-payment wording when fully paid', () => {
  const msg = renderTemplate('academy-payment-received', 'ar', { ...ACADEMY_VARS, payment_status: 'paid', remaining_outstanding: 0 })
  assert.ok(msg.includes('تم استكمال دفع اشتراك اللاعب'), 'expected the final-payment headline for a fully paid academy payment')
  assert.ok(!msg.includes('تم تسجيل دفعة لاشتراك اللاعب'), 'should not show the partial-payment headline once fully paid')
})

check('academy-payment-received shows the subscription date range as real formatted dates, never a raw ISO/date string', () => {
  const msg = renderTemplate('academy-payment-received', 'ar', ACADEMY_VARS)
  assert.ok(!msg.includes('2026-09-01'), 'raw subscription start date leaked into the message')
  assert.ok(!msg.includes('2026-10-01'), 'raw subscription end date leaked into the message')
  assert.ok(msg.includes('سبتمبر') || msg.includes('أكتوبر'), 'expected an Arabic month name in the subscription date range')
})

check('academy-payment-received omits the group/academy line when group_name is absent, never renders it blank', () => {
  const msg = renderTemplate('academy-payment-received', 'ar', { ...ACADEMY_VARS, group_name: undefined })
  assert.ok(!msg.includes('الأكاديمية/المجموعة'), 'the group line should not render at all when group_name is missing')
})

check('academy-payment-received includes official receipt details when present, matching the Field Booking pattern', () => {
  const msg = renderTemplate('academy-payment-received', 'ar', {
    ...ACADEMY_VARS,
    receipt_serial: 'GOV-ACADEMY-001',
    receipt_book: '12',
    receipt_series: 'A',
    receipt_date: '2026-08-22',
  })
  assert.ok(msg.includes('🏛️ *إيصال التحصيل الرسمي*'), 'missing the official receipt block')
  assert.ok(msg.includes('GOV-ACADEMY-001'), 'missing the receipt serial number')
})

check('academy-payment-received includes a /verify/ invoice link, matching the Field Booking pattern', () => {
  const msg = renderTemplate('academy-payment-received', 'ar', ACADEMY_VARS)
  assert.ok(msg.includes('/verify/academytok123'), 'missing the invoice verification link')
})

console.log(`\n[templates.test] ${passed} test(s) passed.`)
if (process.exitCode) {
  console.error('[templates.test] SOME TESTS FAILED.')
} else {
  console.log('[templates.test] ALL TESTS PASSED.')
}
