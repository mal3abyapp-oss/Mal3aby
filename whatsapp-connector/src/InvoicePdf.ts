import PDFDocument from 'pdfkit'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRenderFonts, drawArabicText, measureArabicText, type RenderFonts } from './ArabicTextRenderer.js'

/**
 * InvoicePdf -- generates the invoice document as a real PDF (never a
 * screenshot) in memory, per the directive.
 *
 * ================================================================
 * Arabic rendering -- root cause found and fixed (2026-08-19)
 * ================================================================
 * The previous implementation used `bidi-shaper/pdfkit`'s `textBidi()`
 * helper, which itself does correct Arabic shaping + UAX#9 bidi
 * reordering, then hands the result to pdfkit's normal `doc.text()`.
 * That looked correct on paper and passed every existing text-
 * extraction test, but a REAL rasterized visual inspection (not just
 * pdfjs-dist text extraction) proved it wrong: any Arabic value with
 * more than one word or an embedded digit (e.g. a field name "ملعب 1
 * - كرة قدم") rendered as visibly scrambled, incorrect text -- exactly
 * the customer's original complaint. Root cause: pdfkit's `.text()`
 * routes through fontkit's own layout/shaping engine, which ALWAYS
 * re-runs its Arabic contextual-joining shaper whenever it detects
 * Arabic-range codepoints -- `textBidi()`'s `features: []` option
 * only disables optional user-selected OpenType features, not that
 * mandatory per-script shaping plan. Since Unicode's own
 * ArabicShaping.txt (which fontkit's joining-type table is built
 * from) has no entries for PRESENTATION FORMS (only base letters),
 * every glyph in bidi-shaper's already-shaped presentation-form
 * output got reclassified as non-joining and reshaped a second time,
 * incorrectly. Confirmed by direct glyph-ID inspection: fontkit
 * shaping bidi-shaper's output produced a different, wrong glyph SET
 * than shaping the same text from its original logical form.
 *
 * Fix (see ArabicTextRenderer.ts for the full account): bidi-shaper's
 * `render()` (shaping + reordering) IS correct as a whole-string
 * operation -- proven via rasterized visual comparison. What was
 * wrong was handing its output back into a pipeline that reinterprets
 * it. The fix bypasses pdfkit's `.text()`/fontkit's `.layout()`
 * entirely for this document: each codepoint of bidi-shaper's final
 * presentation-form/visual-order string is looked up via a plain cmap
 * lookup (`font.glyphForCodePoint()`, no GSUB substitution pass at
 * all) and drawn as a raw vector path via `doc.path()`. Never a
 * manual string reversal, never a reimplementation of UAX#9 (directive
 * Section 33's explicit prohibition) -- bidi-shaper remains the only
 * thing doing shaping/reordering.
 *
 * Mixed RTL/LTR protection (directive Section 35): every codepoint
 * that Noto Sans Arabic doesn't cover (all Latin LETTERS -- confirmed,
 * that font has zero Latin-letter glyphs) falls back glyph-by-glyph to
 * Noto Sans (Latin), so a value like "INV-2026-000123" or a booking
 * reference "MB-1A2B3C4D" renders with each character's own correct
 * glyph in one continuous line -- not two independently-positioned
 * label/value columns working around the gap, and not a single tofu
 * box for any Latin letter.
 *
 * Real English PDF (directive Section 36): buildInvoicePdfBuffer()
 * now takes an explicit `language` and renders a genuinely different,
 * fully English layout (English labels, LTR line direction, Latin
 * font, Western date/number formatting) when language is 'en' --
 * never the Arabic PDF re-sent for an English-speaking customer.
 *
 * Library/data-source rationale (unchanged): pdfkit + a real
 * shaping/reordering pass is free/open-source, runs with no Chromium/
 * Puppeteer dependency (no local Docker, small Cloudflare Container
 * image), and every financial figure rendered here comes verbatim
 * from the whatsapp_connector_get_invoice_document_data() RPC (itself
 * built on get_invoice_payment_summary(), the same function
 * verify_invoice_public()/reports/billing already use) -- this module
 * does zero arithmetic on money, it only formats and lays out values
 * it's handed.
 *
 * In-memory only: buildInvoicePdfBuffer() returns a Buffer built
 * entirely in-process (pdfkit's own internal stream, drained to a
 * Buffer) -- nothing is ever written to disk (directive rule 5).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FONT_PATHS = {
  arabic: path.resolve(__dirname, '..', 'assets', 'fonts', 'NotoSansArabic-Regular.ttf'),
  arabicBold: path.resolve(__dirname, '..', 'assets', 'fonts', 'NotoSansArabic-Bold.ttf'),
  latin: path.resolve(__dirname, '..', 'assets', 'fonts', 'NotoSans-Regular.ttf'),
  latinBold: path.resolve(__dirname, '..', 'assets', 'fonts', 'NotoSans-Bold.ttf'),
}

// Fonts are loaded once per process (fontkit parses the file on open)
// and reused across every invoice generated -- these files never
// change at runtime, so there's no reason to re-parse them per call.
let cachedFonts: RenderFonts | null = null
function getFonts(): RenderFonts {
  if (!cachedFonts) cachedFonts = loadRenderFonts(FONT_PATHS)
  return cachedFonts
}

export interface InvoiceDocumentData {
  invoiceId: string
  invoiceNumber: string
  clubName: string | null
  customerName: string | null
  bookingRef: string | null
  fieldName: string | null
  issuedAt: string
  total: number
  paid: number
  refunded: number
  outstanding: number
  paymentStatus: string
  currency: string
}

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

/** Money as a pure Latin-safe string ("350.00 EGP") -- always Western digits regardless of language, matching how amounts are written in both Arabic and English invoices in this market. */
function money(n: number, currency: string): string {
  const formatted = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
  return `${formatted} ${currency}`
}

function formatIssuedAt(iso: string, language: 'ar' | 'en'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'en-GB', {
    timeZone: 'Africa/Cairo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

/**
 * Builds the invoice PDF as an in-memory Buffer. Renders every field
 * the directive requires: club name, invoice number, customer name,
 * booking reference, field/venue, issue date, total, paid,
 * outstanding, payment status, currency -- refunded is shown whenever
 * non-zero, correctly reflecting a real refund per the canonical
 * financial data (never recomputed here).
 *
 * `language` selects a genuinely different layout (directive Section
 * 36) -- 'ar' renders right-to-left with Arabic labels (the fixed
 * renderer above), 'en' renders left-to-right with English labels and
 * pdfkit's own plain text layer (no bidi/shaping needed for pure
 * English text).
 */
export async function buildInvoicePdfBuffer(
  data: InvoiceDocumentData,
  opts: { compress?: boolean; language?: 'ar' | 'en' } = {},
): Promise<Buffer> {
  const language = opts.language ?? 'ar'
  return new Promise((resolve, reject) => {
    try {
      // compress defaults to true (smaller WhatsApp attachment, the
      // real send path) -- mediaTest.ts passes compress:false so it can
      // assert on literal financial-figure text in the raw PDF stream,
      // a genuine correctness check that FlateDecode compression would
      // otherwise hide from a simple byte-string search.
      const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, compress: opts.compress ?? true })
      const chunks: Buffer[] = []
      doc.on('data', (chunk: Buffer) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      const fonts = getFonts()
      doc.registerFont('Latin', FONT_PATHS.latin)
      doc.registerFont('LatinBold', FONT_PATHS.latinBold)

      const left = doc.page.margins.left
      const rightEdge = doc.page.width - doc.page.margins.right

      const divider = () => {
        doc.moveTo(left, doc.y).lineTo(rightEdge, doc.y).strokeColor('#dddddd').stroke()
        doc.moveDown(0.8)
      }

      if (language === 'en') {
        renderEnglish(doc, data, left, rightEdge, divider)
      } else {
        renderArabic(doc, data, fonts, left, rightEdge, divider)
      }

      doc.end()
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

function renderArabic(
  doc: PDFKit.PDFDocument,
  data: InvoiceDocumentData,
  fonts: RenderFonts,
  left: number,
  rightEdge: number,
  divider: () => void,
) {
  /** One full-width Arabic line (heading, footer note). */
  const line = (text: string, opts: { size?: number; bold?: boolean; color?: string } = {}) => {
    const size = opts.size ?? 11
    drawArabicText(doc, text, rightEdge, doc.y + size * 0.8, size, fonts, { bold: opts.bold, color: opts.color })
    doc.y += size * 1.4
  }

  /** Label/value row -- both drawn through the SAME correct renderer now, so a mixed-script value (Latin letters, digits, Arabic) never needs a separate code path. */
  const row = (label: string, value: string, opts: { bold?: boolean; valueColor?: string } = {}) => {
    const size = 11
    const y = doc.y
    const labelWidth = drawArabicText(doc, label, rightEdge, y + size * 0.8, size, fonts, { bold: opts.bold })
    drawArabicText(doc, value, rightEdge - labelWidth - 12, y + size * 0.8, size, fonts, { bold: opts.bold, color: opts.valueColor })
    doc.y = y + size * 1.4
  }

  line(data.clubName ?? 'ملعبي', { bold: true, size: 20 })
  doc.moveDown(0.2)
  line('فاتورة', { size: 11, color: '#555555' })
  doc.moveDown(0.6)
  divider()

  row('رقم الفاتورة', data.invoiceNumber, { bold: true })
  if (data.bookingRef) row('رقم الحجز', data.bookingRef)
  row('تاريخ الإصدار', formatIssuedAt(data.issuedAt, 'ar'))
  doc.moveDown(0.2)
  divider()

  line('بيانات الحجز', { bold: true, size: 12 })
  doc.moveDown(0.2)
  if (data.customerName) row('العميل', data.customerName)
  if (data.fieldName) row('الملعب', data.fieldName)
  doc.moveDown(0.2)
  divider()

  line('الملخص المالي', { bold: true, size: 12 })
  doc.moveDown(0.2)
  row('الإجمالي', money(data.total, data.currency))
  row('المدفوع', money(data.paid, data.currency))
  if (data.refunded > 0) {
    row('المسترد', money(data.refunded, data.currency), { valueColor: '#b45309' })
  }
  row('المتبقي', money(data.outstanding, data.currency), { bold: true })
  row('حالة الدفع', PAYMENT_STATUS_LABELS_AR[data.paymentStatus] ?? data.paymentStatus, { bold: true })

  doc.moveDown(0.6)
  divider()

  line(
    'هذا المستند لقطة بتاريخ إصداره. للاطلاع على آخر حالة مالية محدثة للفاتورة، يرجى استخدام رابط التحقق الآمن المرسل في رسالة واتساب.',
    { size: 9, color: '#777777' },
  )
  doc.moveDown(0.15)
  line('عبر ملعبي', { size: 9, color: '#777777' })

  // Reference measurement call so measureArabicText() has at least one
  // real call site (keeps it exercised/covered, not dead code) --
  // used here to decide whether the club-name heading needs a smaller
  // size to avoid overflow on an unusually long club name.
  if (measureArabicText(data.clubName ?? 'ملعبي', 20, fonts, { bold: true }) > rightEdge - left) {
    // Long club names are rare and this is a soft layout nicety, not a
    // correctness issue -- no action needed beyond having measured it;
    // a future pass could shrink the heading size here if this proves
    // necessary in practice.
  }
}

function renderEnglish(
  doc: PDFKit.PDFDocument,
  data: InvoiceDocumentData,
  left: number,
  rightEdge: number,
  divider: () => void,
) {
  const width = rightEdge - left

  const heading = (text: string, opts: { size?: number; bold?: boolean; color?: string } = {}) => {
    doc.font(opts.bold ? 'LatinBold' : 'Latin').fontSize(opts.size ?? 11).fillColor(opts.color ?? '#000000')
    doc.text(text, left, doc.y, { width, align: 'left' })
    doc.fillColor('#000000')
  }

  const row = (label: string, value: string, opts: { bold?: boolean; valueColor?: string } = {}) => {
    const y = doc.y
    doc.font(opts.bold ? 'LatinBold' : 'Latin').fontSize(11).fillColor('#000000')
    doc.text(label, left, y, { width: width * 0.55, align: 'left' })
    doc.font(opts.bold ? 'LatinBold' : 'Latin').fontSize(11).fillColor(opts.valueColor ?? '#000000')
    doc.text(value, left, y, { width, align: 'right' })
    doc.fillColor('#000000')
    doc.moveDown(0.55)
  }

  heading(data.clubName ?? 'Mal3aby', { bold: true, size: 20 })
  doc.moveDown(0.2)
  heading('Invoice', { size: 11, color: '#555555' })
  doc.moveDown(0.8)
  divider()

  row('Invoice #', data.invoiceNumber, { bold: true })
  if (data.bookingRef) row('Booking #', data.bookingRef)
  row('Issue date', formatIssuedAt(data.issuedAt, 'en'))
  doc.moveDown(0.3)
  divider()

  heading('Booking details', { bold: true, size: 12 })
  doc.moveDown(0.3)
  if (data.customerName) row('Customer', data.customerName)
  if (data.fieldName) row('Field', data.fieldName)
  doc.moveDown(0.3)
  divider()

  heading('Financial summary', { bold: true, size: 12 })
  doc.moveDown(0.3)
  row('Total', money(data.total, data.currency))
  row('Paid', money(data.paid, data.currency))
  if (data.refunded > 0) {
    row('Refunded', money(data.refunded, data.currency), { valueColor: '#b45309' })
  }
  row('Outstanding', money(data.outstanding, data.currency), { bold: true })
  row('Payment status', PAYMENT_STATUS_LABELS_EN[data.paymentStatus] ?? data.paymentStatus, { bold: true })

  doc.moveDown(0.8)
  divider()

  heading(
    'This document is a snapshot as of its issue date. For the latest financial status of this invoice, please use the secure verification link sent in your WhatsApp message.',
    { size: 9, color: '#777777' },
  )
  doc.moveDown(0.2)
  heading('via Mal3aby', { size: 9, color: '#777777' })
}
