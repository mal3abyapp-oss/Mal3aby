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
  const msg = renderTemplate('booking-confirmed', 'ar', { ...BASE_VARS, payment_status: 'partially_paid' })
  assert.ok(!msg.includes('partially_paid'), 'raw enum leaked into booking-confirmed message')
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
// booking-confirmed must carry a QR check-in link when a token is
// present, payment-received/invoice-created must carry an invoice
// link. All must NEVER include one when the token is absent.
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

check('booking-confirmed includes a /qr/ link when booking_qr_token is present (ar + en)', () => {
  const ar = renderTemplate('booking-confirmed', 'ar', { ...BASE_VARS, booking_qr_token: 'xyz789' })
  assert.ok(ar.includes('/qr/xyz789'), 'missing the booking QR link (ar)')
  const en = renderTemplate('booking-confirmed', 'en', { ...BASE_VARS, booking_qr_token: 'xyz789' })
  assert.ok(en.includes('/qr/xyz789'), 'missing the booking QR link (en)')
  assert.ok(en.includes('Check-in code'), 'missing the English QR-link label')
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

check('invoice-created includes a /verify/ link when invoice_token is present (ar + en)', () => {
  const ar = renderTemplate('invoice-created', 'ar', { ...BASE_VARS, total: 220, invoice_token: 'invtok789' })
  assert.ok(ar.includes('/verify/invtok789'), 'missing the invoice verification link (ar)')
  const en = renderTemplate('invoice-created', 'en', { ...BASE_VARS, total: 220, invoice_token: 'invtok789' })
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

console.log(`\n[templates.test] ${passed} test(s) passed.`)
if (process.exitCode) {
  console.error('[templates.test] SOME TESTS FAILED.')
} else {
  console.log('[templates.test] ALL TESTS PASSED.')
}
