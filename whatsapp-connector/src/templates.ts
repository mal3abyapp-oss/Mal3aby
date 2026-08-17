/**
 * templates.ts -- centralized WhatsApp message template layer (Section
 * 20 of the directive: "not text scattered across components").
 *
 * The connector receives template_key + variables from a claimed
 * notification_queue row (task #93's business RPCs set template_key to
 * one of the keys below) and renders the final message body here --
 * the only place WhatsApp message text is composed. Task #96 will
 * expand this to cover invoices and add richer ar/en parity; this
 * minimal set covers the events already wired in task #93
 * (booking-created/confirmed/cancelled, payment-received/refunded) so
 * the connector is immediately useful end-to-end.
 *
 * Arabic-first: this app's primary audience is Arabic-speaking club
 * staff/customers (see i18n foundation, Gate 10) -- language is still
 * driven by notification_queue.language (defaults to 'ar'), never
 * hardcoded, so English falls back correctly for clubs/customers who
 * use it.
 */

export type TemplateKey =
  | 'booking-created'
  | 'booking-confirmed'
  | 'booking-cancelled'
  | 'payment-received'
  | 'payment-refunded'
  | 'invoice-created'

type Renderer = (vars: Record<string, unknown>) => string

function str(v: unknown, fallback = ''): string {
  return v === null || v === undefined ? fallback : String(v)
}

const AR: Record<TemplateKey, Renderer> = {
  'booking-created': (v) => `تم استلام حجزك في ملعب ${str(v.field_name)} بتاريخ ${str(v.start_at)}. سيتم تأكيد الحجز قريبًا.`,
  'booking-confirmed': (v) => `تم تأكيد حجزك في ملعب ${str(v.field_name)} بتاريخ ${str(v.start_at)}. نتشرف بخدمتك.`,
  'booking-cancelled': (v) => `تم إلغاء حجزك في ملعب ${str(v.field_name)} بتاريخ ${str(v.start_at)}.${v.reason ? ` السبب: ${str(v.reason)}` : ''}`,
  'payment-received': (v) =>
    `تم استلام دفعة بقيمة ${str(v.amount)} ج.م. الحالة: ${str(v.payment_status) === 'paid' ? 'مدفوعة بالكامل' : 'مدفوعة جزئيًا'}. شكرًا لك.`,
  'payment-refunded': (v) => `تم استرداد مبلغ ${str(v.amount)} ج.م. إلى حسابك.`,
  'invoice-created': (v) => `فاتورتك رقم ${str(v.invoice_number)} بقيمة ${str(v.total)} ج.م جاهزة.`,
}

const EN: Record<TemplateKey, Renderer> = {
  'booking-created': (v) => `Your booking at ${str(v.field_name)} on ${str(v.start_at)} has been received. Confirmation will follow shortly.`,
  'booking-confirmed': (v) => `Your booking at ${str(v.field_name)} on ${str(v.start_at)} is confirmed. See you there!`,
  'booking-cancelled': (v) => `Your booking at ${str(v.field_name)} on ${str(v.start_at)} was cancelled.${v.reason ? ` Reason: ${str(v.reason)}` : ''}`,
  'payment-received': (v) =>
    `We received a payment of EGP ${str(v.amount)}. Status: ${str(v.payment_status) === 'paid' ? 'fully paid' : 'partially paid'}. Thank you.`,
  'payment-refunded': (v) => `A refund of EGP ${str(v.amount)} has been issued to you.`,
  'invoice-created': (v) => `Your invoice ${str(v.invoice_number)} for EGP ${str(v.total)} is ready.`,
}

export function renderTemplate(templateKey: string, language: string, variables: Record<string, unknown>): string {
  const table = language === 'en' ? EN : AR
  const renderer = table[templateKey as TemplateKey]
  if (!renderer) {
    throw new Error(`Unknown WhatsApp template_key: ${templateKey}`)
  }
  return renderer(variables ?? {})
}
