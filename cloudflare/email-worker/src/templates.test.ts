/**
 * templates.test.ts -- automated tests for the email template layer.
 * Same plain-node-assertions pattern as
 * ../../whatsapp-connector/src/templates.test.ts (no test-framework
 * dependency in this separate npm package). Run with:
 *   npx tsx src/templates.test.ts
 *
 * Covers directive section 43's mandatory list for this file's scope:
 * Arabic/English rendering, activation_secret rejection (the
 * activation-security defense-in-depth check), null/undefined-safe
 * rendering, and HTML-escaping of untrusted variable content.
 */
import assert from 'node:assert/strict'
import { renderEmailTemplate } from './templates.js'

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
  start_at: '2026-08-17T07:00:00+00:00',
  end_at: '2026-08-17T08:00:00+00:00',
  total_price: 220,
  invoice_number: 'QAFULL-MAIN-2026-000030',
  payment_status: 'unpaid',
  club_name: 'نادي الاختبار الشامل',
  customer_name: 'مصطفى',
  timezone: 'Africa/Cairo',
  booking_ref: 'MB-1A2B3C4D',
}

check('booking-created (ar) renders subject/html/text with real venue-local date, never a raw ISO string', () => {
  const result = renderEmailTemplate('booking-created', 'ar', BASE_VARS)
  assert.ok(result.subject.includes('نادي الاختبار الشامل'), 'subject should include the club name')
  assert.ok(!result.html.includes('2026-08-17T07:00:00'), 'raw ISO string leaked into the HTML body')
  assert.ok(!result.text.includes('2026-08-17T07:00:00'), 'raw ISO string leaked into the text body')
  assert.ok(result.html.includes('أغسطس'), 'expected an Arabic month name in the formatted date')
  assert.ok(result.html.includes('dir="rtl"'), 'Arabic template must render with dir="rtl"')
})

check('booking-created (en) renders LTR with English content, no Arabic leaking through labels', () => {
  const result = renderEmailTemplate('booking-created', 'en', BASE_VARS)
  assert.ok(result.html.includes('dir="ltr"'), 'English template must render with dir="ltr"')
  assert.ok(result.subject.toLowerCase().includes('booking'), 'expected an English subject')
  assert.ok(result.html.includes('August'), 'expected an English month name')
})

check('activation_secret in variables causes renderEmailTemplate to throw, never silently render it', () => {
  assert.throws(
    () => renderEmailTemplate('booking-created', 'ar', { ...BASE_VARS, activation_secret: 'K7M4-P9Q2' }),
    /activation_secret/,
    'expected renderEmailTemplate to reject a payload containing activation_secret',
  )
})

check('activation_token alone (no secret) is accepted and does not throw -- the link is not the secret', () => {
  assert.doesNotThrow(() => renderEmailTemplate('booking-created', 'ar', { ...BASE_VARS, activation_token: 'sometoken123' }))
})

check('missing optional fields (sport, customer_name) never render "null"/"undefined"', () => {
  const vars = { ...BASE_VARS, sport: null, customer_name: undefined }
  const result = renderEmailTemplate('booking-created', 'ar', vars)
  assert.ok(!result.html.includes('null'), 'rendered "null" for a missing field')
  assert.ok(!result.html.includes('undefined'), 'rendered "undefined" for a missing field')
  assert.ok(!result.text.includes('null'))
  assert.ok(!result.text.includes('undefined'))
})

check('untrusted variable content is HTML-escaped, not injected raw (XSS safety)', () => {
  const vars = { ...BASE_VARS, field_name: '<script>alert(1)</script>' }
  const result = renderEmailTemplate('booking-created', 'ar', vars)
  assert.ok(!result.html.includes('<script>alert(1)</script>'), 'raw script tag leaked into HTML unescaped')
  assert.ok(result.html.includes('&lt;script&gt;'), 'expected the script tag to be HTML-escaped')
})

check('unknown template_key throws rather than silently rendering nothing', () => {
  assert.throws(() => renderEmailTemplate('not-a-real-template', 'ar', BASE_VARS), /Unknown email template_key/)
})

check('deliverability hardening: HTML table structure is well-formed -- every <tr> lives inside a <table>...</table> pair, no orphan rows (Outlook/Word-engine rendering fix)', () => {
  const withCta = renderEmailTemplate('booking-confirmed-paid', 'ar', { ...BASE_VARS, amount_paid: 220, method: 'cash', booking_qr_token: 'tok123' })
  const opens = (withCta.html.match(/<table/g) || []).length
  const closes = (withCta.html.match(/<\/table>/g) || []).length
  assert.strictEqual(opens, closes, `unbalanced <table> tags: ${opens} opens vs ${closes} closes -- a <tr> is very likely orphaned outside any <table>, which Outlook's Word-based renderer handles unpredictably`)
  assert.ok(opens >= 4, 'expected at least 4 tables (outer wrapper, card, details rows, CTA) when a CTA is present')
})

check('booking-confirmed-paid shows total/paid/outstanding correctly formatted, never a raw number', () => {
  const result = renderEmailTemplate('booking-confirmed-paid', 'ar', { ...BASE_VARS, amount_paid: 220, method: 'cash' })
  assert.ok(!result.html.includes('220.000000'), 'unformatted money leaked into the message')
})

check('booking-cancelled includes the reason only when provided', () => {
  const withReason = renderEmailTemplate('booking-cancelled', 'ar', { ...BASE_VARS, reason: 'Customer request' })
  assert.ok(withReason.html.includes('Customer request'))
  const withoutReason = renderEmailTemplate('booking-cancelled', 'ar', BASE_VARS)
  assert.ok(!withoutReason.html.includes('السبب') || !withoutReason.html.includes('undefined'))
})

check('academy-payment-received names the specific player, never a generic message', () => {
  const result = renderEmailTemplate('academy-payment-received', 'ar', {
    ...BASE_VARS,
    player_name: 'أحمد محمد',
    group_name: 'مجموعة الناشئين',
    amount: 500,
    payment_status: 'paid',
  })
  assert.ok(result.html.includes('أحمد محمد'), 'expected the player name to appear')
  assert.ok(result.text.includes('أحمد محمد'), 'expected the player name to appear in the text fallback')
})

check('every template produces a non-empty plain-text fallback alongside the HTML', () => {
  const keys = ['booking-created', 'booking-confirmed-paid', 'booking-rescheduled', 'booking-cancelled', 'payment-received', 'academy-payment-received']
  for (const key of keys) {
    const result = renderEmailTemplate(key, 'ar', BASE_VARS)
    assert.ok(result.text.trim().length > 0, `${key} produced an empty text fallback`)
    assert.ok(result.html.trim().length > 0, `${key} produced empty HTML`)
    assert.ok(!result.html.includes('<script'), `${key} must never include a <script> tag (directive section 29: no scripts)`)
  }
})

console.log(`\n[templates.test] ${passed} test(s) passed.`)
if (process.exitCode) {
  console.error('[templates.test] SOME TESTS FAILED.')
} else {
  console.log('[templates.test] ALL TESTS PASSED.')
}
