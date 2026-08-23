/**
 * templates.ts -- centralized EMAIL template layer (the ONLY place
 * email subject/HTML/text is composed; business RPCs never embed
 * message copy, they only pass event data as jsonb variables via
 * queue_email_notification -- mirrors whatsapp-connector/src/
 * templates.ts's own architecture exactly, same reasoning: business
 * logic lives once, in SQL; rendering lives once, per channel, here).
 *
 * SECURITY (directive sections 23-25): activation_secret is NEVER
 * read or rendered by this file, even if a future queue row somehow
 * carried it in `variables` -- the independent activation secret must
 * travel exclusively over WhatsApp. This is enforced at TWO layers:
 * (1) queue_email_notification's own SQL call sites never pass
 * activation_secret into the jsonb payload in the first place; (2)
 * even so, no renderer below ever reads `v.activation_secret` as a
 * defense-in-depth measure against a future call site accidentally
 * including it.
 *
 * Mobile-first HTML email (directive section 29): simple table-based
 * layout, inline styles only (no <style> block, no external
 * stylesheet, no JS) -- the single most compatible pattern across
 * Gmail/Outlook/mobile clients, which routinely strip <style> blocks
 * or ignore modern CSS. A plain-text fallback (directive section 30)
 * is generated alongside every HTML render from the same data, never
 * a second hand-maintained copy.
 */

type Vars = Record<string, unknown>

// ----------------------------------------------------------------
// Shared value helpers -- same null/undefined-safe contract as
// whatsapp-connector/src/templates.ts's own isPresent()/line().
// ----------------------------------------------------------------

function isPresent(v: unknown): v is string | number {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim().length > 0
  return true
}

function esc(v: unknown): string {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const PUBLIC_APP_URL = 'https://mal3aby.app'

/** Same bare-raw-token URL pattern as the WhatsApp connector's own bookingQrUrl/activationUrl -- the destination page resolves everything server-side from the token alone. */
function bookingQrUrl(token: unknown, language: string): string | null {
  if (!isPresent(token)) return null
  return `${PUBLIC_APP_URL}/qr/${encodeURIComponent(String(token))}?lang=${language}`
}

function invoiceUrl(token: unknown, language: string): string | null {
  if (!isPresent(token)) return null
  return `${PUBLIC_APP_URL}/verify/${encodeURIComponent(String(token))}?lang=${language}`
}

// activationUrl() is deliberately NOT defined here -- this template
// layer never renders an activation link or any activation-related
// content at all (directive sections 23-25: the activation secret,
// and by extension the activation flow itself, stays exclusively on
// WhatsApp). If a future phase adds an activation-reminder email
// template, add the helper back then, alongside the same
// assertNoActivationSecret() guard already enforced below.

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

function formatCalendarDate(dateStr: string, locale: string): string | null {
  const d = new Date(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}

/** Mirrors formatMoney() (src/lib/domain/billing.ts) and the WhatsApp connector's own port of it. */
function formatMoney(amount: unknown, currencySuffixAr: string, currencySuffixEn: string, language: string): string | null {
  const n = typeof amount === 'number' ? amount : typeof amount === 'string' ? Number(amount) : NaN
  if (!Number.isFinite(n)) return null
  const locale = language === 'en' ? 'en-US' : 'ar-EG'
  const formatted = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
  return `${formatted} ${language === 'en' ? currencySuffixEn : currencySuffixAr}`
}

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

const BOOKING_STATUS_LABELS_AR: Record<string, string> = {
  pending_payment: 'بانتظار الدفع', confirmed: 'مؤكد', checked_in: 'تم تسجيل الحضور',
  completed: 'مكتمل', cancelled: 'ملغي', no_show: 'لم يحضر',
}
const BOOKING_STATUS_LABELS_EN: Record<string, string> = {
  pending_payment: 'Awaiting payment', confirmed: 'Confirmed', checked_in: 'Checked in',
  completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
}
const PAYMENT_STATUS_LABELS_AR: Record<string, string> = {
  draft: 'مسودة', void: 'ملغاة', unpaid: 'غير مدفوعة', partially_paid: 'مدفوعة جزئيًا',
  paid: 'مدفوعة بالكامل', partially_refunded: 'مستردة جزئيًا', refunded: 'مستردة بالكامل',
}
const PAYMENT_STATUS_LABELS_EN: Record<string, string> = {
  draft: 'Draft', void: 'Voided', unpaid: 'Unpaid', partially_paid: 'Partially paid',
  paid: 'Fully paid', partially_refunded: 'Partially refunded', refunded: 'Fully refunded',
}
const SPORT_LABELS_AR: Record<string, string> = { football: 'كرة قدم', padel: 'بادل', basketball: 'كرة سلة' }
const SPORT_LABELS_EN: Record<string, string> = { football: 'Football', padel: 'Padel', basketball: 'Basketball' }

function bookingStatusLabel(status: unknown, language: string): string | null {
  if (!isPresent(status)) return null
  return (language === 'en' ? BOOKING_STATUS_LABELS_EN : BOOKING_STATUS_LABELS_AR)[String(status)] ?? null
}
function paymentStatusLabel(status: unknown, language: string): string | null {
  if (!isPresent(status)) return null
  return (language === 'en' ? PAYMENT_STATUS_LABELS_EN : PAYMENT_STATUS_LABELS_AR)[String(status)] ?? null
}
function sportLabel(sport: unknown, language: string): string | null {
  if (!isPresent(sport)) return null
  return (language === 'en' ? SPORT_LABELS_EN : SPORT_LABELS_AR)[String(sport)] ?? String(sport)
}

// ----------------------------------------------------------------
// HTML shell -- mobile-first, table-based, inline styles only.
// Same shell reused by every template so branding/spacing stays
// consistent without a theme engine (directive section 31: "Do not
// build a theme engine").
// ----------------------------------------------------------------

interface Row {
  label: string
  value: string
}

function row(label: string, value: unknown): Row | null {
  return isPresent(value) ? { label, value: esc(value) } : null
}

function renderShell(opts: {
  language: string
  headline: string
  intro: string
  rows: (Row | null)[]
  ctaLabel: string | null
  ctaUrl: string | null
  clubName: unknown
  footer?: string
}): string {
  const dir = opts.language === 'en' ? 'ltr' : 'rtl'
  const align = opts.language === 'en' ? 'left' : 'right'
  const rowsHtml = opts.rows
    .filter((r): r is Row => r !== null)
    .map(
      (r) =>
        `<tr><td style="padding:8px 0;color:#6b7280;font-size:14px;white-space:nowrap;${align === 'right' ? 'padding-left' : 'padding-right'}:16px;">${esc(r.label)}</td><td style="padding:8px 0;color:#111827;font-size:14px;font-weight:600;text-align:${align};">${r.value}</td></tr>`,
    )
    .join('')
  const brand = isPresent(opts.clubName) ? `${esc(opts.clubName)} <span style="color:#9ca3af;">${opts.language === 'en' ? 'via Mal3aby' : 'عبر ملعبي'}</span>` : 'Mal3aby'
  const cta =
    opts.ctaLabel && opts.ctaUrl
      ? `<tr><td style="padding:24px 0 0;"><a href="${esc(opts.ctaUrl)}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 28px;border-radius:8px;">${esc(opts.ctaLabel)}</a></td></tr>`
      : ''
  return `<!doctype html>
<html dir="${dir}" lang="${opts.language}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background:#111827;padding:20px 24px;"><span style="color:#ffffff;font-size:16px;font-weight:700;">${brand}</span></td></tr>
<tr><td style="padding:28px 24px 8px;">
<h1 style="margin:0 0 8px;font-size:19px;color:#111827;">${esc(opts.headline)}</h1>
<p style="margin:0 0 20px;font-size:14px;color:#4b5563;line-height:1.6;">${esc(opts.intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;">
${rowsHtml}
</table>
${cta}
</td></tr>
<tr><td style="padding:20px 24px;background:#f9fafb;">
<p style="margin:0;font-size:12px;color:#9ca3af;">${esc(opts.footer ?? (opts.language === 'en' ? 'This is an automated message from Mal3aby.' : 'هذه رسالة تلقائية من ملعبي.'))}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

function renderText(opts: { headline: string; intro: string; rows: (Row | null)[]; ctaLabel: string | null; ctaUrl: string | null }): string {
  const lines = [opts.headline, '', opts.intro, '']
  for (const r of opts.rows) {
    if (r) lines.push(`${r.label}: ${r.value.replace(/<[^>]+>/g, '')}`)
  }
  if (opts.ctaLabel && opts.ctaUrl) {
    lines.push('', `${opts.ctaLabel}: ${opts.ctaUrl}`)
  }
  return lines.join('\n')
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

export type TemplateKey =
  | 'booking-created'
  | 'booking-confirmed-paid'
  | 'booking-rescheduled'
  | 'booking-cancelled'
  | 'payment-received'
  | 'academy-payment-received'

type Renderer = (v: Vars, language: string) => RenderedEmail

const RENDERERS: Record<TemplateKey, Renderer> = {
  'booking-created': (v, language) => {
    const tz = isPresent(v.timezone) ? String(v.timezone) : DEFAULT_TIMEZONE
    const locale = language === 'en' ? 'en-US' : 'ar-EG'
    const date = isPresent(v.start_at) ? formatDate(String(v.start_at), tz, locale) : null
    const time = isPresent(v.start_at) ? formatTime(String(v.start_at), tz, locale) : null
    const qrUrl = bookingQrUrl(v.booking_qr_token, language)
    const total = formatMoney(v.total_price, 'ج.م', 'EGP', language)
    const ar = language !== 'en'
    return {
      subject: ar ? `تأكيد حجزك — ${isPresent(v.club_name) ? String(v.club_name) : 'ملعبي'}` : `Booking confirmation — ${isPresent(v.club_name) ? String(v.club_name) : 'Mal3aby'}`,
      html: renderShell({
        language,
        headline: ar ? 'تم استلام طلب حجزك' : 'Your booking request was received',
        intro: ar ? 'استلمنا طلب حجزك بنجاح، وهذه التفاصيل:' : "We've received your booking request. Here are the details:",
        rows: [
          row(ar ? 'النادي' : 'Club', v.club_name),
          row(ar ? 'الملعب' : 'Field', v.field_name),
          row(ar ? 'النشاط' : 'Sport', sportLabel(v.sport, language)),
          row(ar ? 'رقم الحجز' : 'Booking ref', v.booking_ref),
          row(ar ? 'التاريخ' : 'Date', date),
          row(ar ? 'الوقت' : 'Time', time),
          row(ar ? 'الحالة' : 'Status', ar ? 'بانتظار التأكيد' : 'Awaiting confirmation'),
          row(ar ? 'الإجمالي' : 'Total', total),
          row(ar ? 'حالة الدفع' : 'Payment status', paymentStatusLabel(v.payment_status, language)),
        ],
        ctaLabel: qrUrl ? (ar ? 'عرض تفاصيل الحجز' : 'View booking details') : null,
        ctaUrl: qrUrl,
        clubName: v.club_name,
      }),
      text: renderText({
        headline: ar ? 'تم استلام طلب حجزك' : 'Your booking request was received',
        intro: ar ? 'استلمنا طلب حجزك بنجاح.' : "We've received your booking request.",
        rows: [
          row(ar ? 'النادي' : 'Club', v.club_name),
          row(ar ? 'الملعب' : 'Field', v.field_name),
          row(ar ? 'رقم الحجز' : 'Booking ref', v.booking_ref),
          row(ar ? 'التاريخ' : 'Date', date),
          row(ar ? 'الوقت' : 'Time', time),
          row(ar ? 'الإجمالي' : 'Total', total),
        ],
        ctaLabel: qrUrl ? (ar ? 'عرض تفاصيل الحجز' : 'View booking details') : null,
        ctaUrl: qrUrl,
      }),
    }
  },

  'booking-confirmed-paid': (v, language) => {
    const tz = isPresent(v.timezone) ? String(v.timezone) : DEFAULT_TIMEZONE
    const locale = language === 'en' ? 'en-US' : 'ar-EG'
    const date = isPresent(v.start_at) ? formatDate(String(v.start_at), tz, locale) : null
    const time = isPresent(v.start_at) ? formatTime(String(v.start_at), tz, locale) : null
    const qrUrl = bookingQrUrl(v.booking_qr_token, language)
    const total = formatMoney(v.total_price, 'ج.م', 'EGP', language)
    const paid = formatMoney(v.amount_paid, 'ج.م', 'EGP', language)
    const outstanding = formatMoney(outstandingAmount(v.remaining_outstanding, v.total_price, v.amount_paid), 'ج.م', 'EGP', language)
    const ar = language !== 'en'
    const rows = [
      row(ar ? 'النادي' : 'Club', v.club_name),
      row(ar ? 'الملعب' : 'Field', v.field_name),
      row(ar ? 'النشاط' : 'Sport', sportLabel(v.sport, language)),
      row(ar ? 'رقم الحجز' : 'Booking ref', v.booking_ref),
      row(ar ? 'التاريخ' : 'Date', date),
      row(ar ? 'الوقت' : 'Time', time),
      row(ar ? 'الحالة' : 'Status', bookingStatusLabel('confirmed', language)),
      row(ar ? 'الإجمالي' : 'Total', total),
      row(ar ? 'المدفوع' : 'Paid', paid),
      row(ar ? 'المتبقي' : 'Outstanding', outstanding),
      row(ar ? 'رقم الفاتورة' : 'Invoice #', v.invoice_number),
      row(ar ? 'رقم الإيصال الرسمي' : 'Official receipt #', v.receipt_serial),
    ]
    return {
      subject: ar ? `تأكيد حجزك — ${isPresent(v.club_name) ? String(v.club_name) : 'ملعبي'}` : `Booking confirmed — ${isPresent(v.club_name) ? String(v.club_name) : 'Mal3aby'}`,
      html: renderShell({
        language,
        headline: ar ? 'تم تأكيد حجزك' : 'Your booking is confirmed',
        intro: ar ? 'تم تأكيد حجزك وتسجيل دفعتك بنجاح.' : 'Your booking is confirmed and your payment has been recorded.',
        rows,
        ctaLabel: qrUrl ? (ar ? 'عرض تفاصيل الحجز' : 'View booking details') : null,
        ctaUrl: qrUrl,
        clubName: v.club_name,
      }),
      text: renderText({ headline: ar ? 'تم تأكيد حجزك' : 'Your booking is confirmed', intro: '', rows, ctaLabel: qrUrl ? (ar ? 'عرض تفاصيل الحجز' : 'View booking details') : null, ctaUrl: qrUrl }),
    }
  },

  'booking-rescheduled': (v, language) => {
    const tz = isPresent(v.timezone) ? String(v.timezone) : DEFAULT_TIMEZONE
    const locale = language === 'en' ? 'en-US' : 'ar-EG'
    const oldDate = isPresent(v.old_start_at) ? formatDate(String(v.old_start_at), tz, locale) : null
    const oldTime = isPresent(v.old_start_at) ? formatTime(String(v.old_start_at), tz, locale) : null
    const newDate = isPresent(v.start_at) ? formatDate(String(v.start_at), tz, locale) : null
    const newTime = isPresent(v.start_at) ? formatTime(String(v.start_at), tz, locale) : null
    const qrUrl = bookingQrUrl(v.booking_qr_token, language)
    const ar = language !== 'en'
    const rows = [
      row(ar ? 'النادي' : 'Club', v.club_name),
      row(ar ? 'الملعب' : 'Field', v.field_name),
      row(ar ? 'رقم الحجز' : 'Booking ref', v.booking_ref),
      row(ar ? 'الموعد السابق' : 'Previous time', oldDate && oldTime ? `${oldDate} — ${oldTime}` : null),
      row(ar ? 'الموعد الجديد' : 'New time', newDate && newTime ? `${newDate} — ${newTime}` : null),
      row(ar ? 'الإجمالي' : 'Total', formatMoney(v.total_price, 'ج.م', 'EGP', language)),
    ]
    return {
      subject: ar ? `تم تعديل موعد حجزك — ${isPresent(v.club_name) ? String(v.club_name) : 'ملعبي'}` : `Booking rescheduled — ${isPresent(v.club_name) ? String(v.club_name) : 'Mal3aby'}`,
      html: renderShell({
        language,
        headline: ar ? 'تم تعديل موعد حجزك' : 'Your booking was rescheduled',
        intro: ar ? 'تم تعديل موعد حجزك بنجاح.' : 'Your booking time has been updated.',
        rows,
        ctaLabel: qrUrl ? (ar ? 'عرض تفاصيل الحجز' : 'View booking details') : null,
        ctaUrl: qrUrl,
        clubName: v.club_name,
      }),
      text: renderText({ headline: ar ? 'تم تعديل موعد حجزك' : 'Your booking was rescheduled', intro: '', rows, ctaLabel: qrUrl ? (ar ? 'عرض تفاصيل الحجز' : 'View booking details') : null, ctaUrl: qrUrl }),
    }
  },

  'booking-cancelled': (v, language) => {
    const tz = isPresent(v.timezone) ? String(v.timezone) : DEFAULT_TIMEZONE
    const locale = language === 'en' ? 'en-US' : 'ar-EG'
    const date = isPresent(v.start_at) ? formatDate(String(v.start_at), tz, locale) : null
    const time = isPresent(v.start_at) ? formatTime(String(v.start_at), tz, locale) : null
    const ar = language !== 'en'
    const rows = [
      row(ar ? 'الملعب' : 'Field', v.field_name),
      row(ar ? 'التاريخ' : 'Date', date),
      row(ar ? 'الوقت' : 'Time', time),
      row(ar ? 'الحالة' : 'Status', bookingStatusLabel('cancelled', language)),
      row(ar ? 'السبب' : 'Reason', v.reason),
    ]
    return {
      subject: ar ? 'تم إلغاء حجزك' : 'Booking cancelled',
      html: renderShell({
        language,
        headline: ar ? 'تم إلغاء حجزك' : 'Your booking was cancelled',
        intro: ar ? 'تم إلغاء حجزك. يمكنك إنشاء حجز جديد في أي وقت.' : 'Your booking has been cancelled. You can make a new booking any time.',
        rows,
        ctaLabel: null,
        ctaUrl: null,
        clubName: null,
      }),
      text: renderText({ headline: ar ? 'تم إلغاء حجزك' : 'Your booking was cancelled', intro: '', rows, ctaLabel: null, ctaUrl: null }),
    }
  },

  'payment-received': (v, language) => {
    const invoiceLink = invoiceUrl(v.invoice_token, language)
    const ar = language !== 'en'
    const rows = [
      row(ar ? 'رقم الحجز' : 'Booking ref', v.booking_ref),
      row(ar ? 'المبلغ المدفوع' : 'Amount paid', formatMoney(v.amount, 'ج.م', 'EGP', language)),
      row(ar ? 'حالة الدفع' : 'Payment status', paymentStatusLabel(v.payment_status, language)),
      row(ar ? 'المتبقي' : 'Outstanding', formatMoney(outstandingAmount(v.remaining_outstanding, v.total_price, v.amount_paid), 'ج.م', 'EGP', language)),
      row(ar ? 'رقم الفاتورة' : 'Invoice #', v.invoice_number),
      row(ar ? 'رقم الإيصال الرسمي' : 'Official receipt #', v.receipt_serial),
    ]
    return {
      subject: ar ? 'تم استلام دفعتك' : 'Payment received',
      html: renderShell({
        language,
        headline: ar ? 'تم استلام دفعتك بنجاح' : 'Your payment was received',
        intro: ar ? 'تم تسجيل الدفع الخاص بحجزك.' : 'Your payment has been recorded.',
        rows,
        ctaLabel: invoiceLink ? (ar ? 'عرض الفاتورة' : 'View invoice') : null,
        ctaUrl: invoiceLink,
        clubName: v.club_name,
      }),
      text: renderText({ headline: ar ? 'تم استلام دفعتك بنجاح' : 'Your payment was received', intro: '', rows, ctaLabel: invoiceLink ? (ar ? 'عرض الفاتورة' : 'View invoice') : null, ctaUrl: invoiceLink }),
    }
  },

  'academy-payment-received': (v, language) => {
    const invoiceLink = invoiceUrl(v.invoice_token, language)
    const ar = language !== 'en'
    const isFinal = v.payment_status === 'paid'
    const startDate = isPresent(v.subscription_start_date) ? formatCalendarDate(String(v.subscription_start_date), language === 'en' ? 'en-US' : 'ar-EG') : null
    const endDate = isPresent(v.subscription_end_date) ? formatCalendarDate(String(v.subscription_end_date), language === 'en' ? 'en-US' : 'ar-EG') : null
    const rows = [
      row(ar ? 'النادي' : 'Club', v.club_name),
      row(ar ? 'اللاعب' : 'Player', v.player_name),
      row(ar ? 'الأكاديمية/المجموعة' : 'Academy/Group', v.group_name),
      row(ar ? 'مدة الاشتراك' : 'Subscription period', startDate && endDate ? `${startDate} — ${endDate}` : null),
      row(ar ? 'المبلغ المدفوع الآن' : 'Amount paid now', formatMoney(v.amount, 'ج.م', 'EGP', language)),
      row(ar ? 'حالة الدفع' : 'Payment status', paymentStatusLabel(v.payment_status, language)),
      row(ar ? 'المتبقي' : 'Outstanding', formatMoney(outstandingAmount(v.remaining_outstanding, v.total_price, v.amount_paid), 'ج.م', 'EGP', language)),
      row(ar ? 'رقم الفاتورة' : 'Invoice #', v.invoice_number),
    ]
    const headline = isFinal
      ? ar
        ? 'تم استكمال دفع اشتراك اللاعب'
        : 'Academy subscription payment complete'
      : ar
        ? 'تم تسجيل دفعة لاشتراك اللاعب'
        : 'Academy payment recorded'
    return {
      subject: ar ? 'دفعة اشتراك الأكاديمية — ملعبي' : 'Academy subscription payment — Mal3aby',
      html: renderShell({
        language,
        headline,
        intro: ar
          ? `تم تسجيل دفعة لاشتراك اللاعب في الأكاديمية${isPresent(v.player_name) ? ` — ${String(v.player_name)}` : ''}.`
          : `A payment was recorded for the academy subscription${isPresent(v.player_name) ? ` — ${String(v.player_name)}` : ''}.`,
        rows,
        ctaLabel: invoiceLink ? (ar ? 'عرض الفاتورة' : 'View invoice') : null,
        ctaUrl: invoiceLink,
        clubName: v.club_name,
      }),
      text: renderText({ headline, intro: '', rows, ctaLabel: invoiceLink ? (ar ? 'عرض الفاتورة' : 'View invoice') : null, ctaUrl: invoiceLink }),
    }
  },
}

/** Explicitly rejects an activation_secret key anywhere in variables -- defense-in-depth, see this file's own header comment. Throws rather than silently stripping, so a violation is loud (caller sees a failed send + a clear error, never a quiet leak). */
function assertNoActivationSecret(variables: Vars): void {
  if ('activation_secret' in variables && variables.activation_secret != null) {
    throw new Error('refusing to render an email template with activation_secret present in variables -- the activation secret must only ever be delivered via WhatsApp')
  }
}

export function renderEmailTemplate(templateKey: string, language: string, variables: Record<string, unknown>): RenderedEmail {
  const vars = variables ?? {}
  assertNoActivationSecret(vars)
  const renderer = RENDERERS[templateKey as TemplateKey]
  if (!renderer) {
    throw new Error(`Unknown email template_key: ${templateKey}`)
  }
  return renderer(vars, language === 'en' ? 'en' : 'ar')
}
