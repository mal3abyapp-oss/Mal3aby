import PDFDocument from 'pdfkit'
import { textBidi, type PdfKitDocLike } from 'bidi-shaper/pdfkit'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * InvoicePdf -- generates the invoice document as a real PDF (never a
 * screenshot) in memory, per the directive.
 *
 * ================================================================
 * Arabic rendering -- real bugs found via visual testing, fixed here
 * ================================================================
 * The first implementation of this module used pdfkit's plain
 * `.text()` with manual `bidi-js` string reversal. Rendering an actual
 * PDF and reading it (not just "the code compiles") surfaced THREE
 * real, distinct bugs, exactly the kind directive rule 11 says are
 * unacceptable:
 *  1. Word order within a right-aligned Arabic line came out visually
 *     WRONG (not just character-level, whole words swapped) --
 *     root-caused to pdfkit/fontkit having NO real bidi implementation
 *     at all: fontkit only reverses glyphs *within* a same-script
 *     "word" (its own internal cache unit, split on whitespace), it
 *     never reorders words/runs relative to each other. Pre-reversing
 *     the whole string with `bidi-js` before handing it to fontkit's
 *     shaper broke Arabic letter-joining (the shaper needs LOGICAL
 *     adjacency to pick correct init/medial/final presentation forms
 *     -- a pre-reversed string feeds it a mirrored joining context).
 *  2. Digits/currency codes rendered as missing-glyph "tofu" boxes --
 *     root-caused to Noto Sans Arabic genuinely having NO Latin LETTER
 *     glyphs at all (confirmed via fontkit's own characterSet: has 'E'
 *     -> false). Only Arabic script + Western digits + basic
 *     punctuation are covered by that font.
 *  3. An invoice number embedded inline in an Arabic sentence
 *     ("رقم الفاتورة: INV-2026-0042") reordered incorrectly relative
 *     to the surrounding Arabic words.
 *
 * Fix, in two parts:
 *  a) `bidi-shaper` (MIT, zero deps, UAX#9-conformance-tested) does
 *     BOTH the Arabic contextual-shaping pass AND the bidi reordering
 *     pass itself, then hands pdfkit an already-shaped, already-
 *     visual-order string via its own `bidi-shaper/pdfkit` adapter
 *     (`textBidi()`), which also disables fontkit's own re-shaping for
 *     that call (`features: []`) so the two shaping passes don't
 *     double up. Verified live: pure-Arabic multi-word lines now read
 *     correctly right-to-left with correctly joined letters.
 *  b) Rather than trying to bidi-reorder mixed Arabic+Latin RUNS within
 *     one line (pdfkit has no multi-font-per-line API at all --
 *     confirmed: no rich-text/run API exists, `continued: true` is the
 *     only chaining primitive and still doesn't solve font
 *     substitution or cross-run reordering), every field that can
 *     contain a Latin/numeric value (invoice number, booking ref,
 *     amounts, currency) is laid out as an explicit two-column
 *     label/value row: the Arabic LABEL goes through textBidi() with
 *     the Arabic font, the VALUE goes through a second, independent
 *     `.text()` call with a Latin-capable font (Noto Sans, which DOES
 *     cover Latin letters+digits). This sidesteps the "no mixed-font
 *     bidi" gap entirely rather than fighting it, and reads as a
 *     normal, clean invoice table layout, not a workaround.
 *
 * Library/data-source rationale (directive rules 9, 10) is unchanged
 * from the original design: pdfkit (fontkit-based Arabic shaping) +
 * bidi-shaper (the UAX#9 reordering fontkit itself does not do) is
 * free/open-source, runs with no Chromium/Puppeteer dependency (no
 * local Docker, small Cloudflare Container image), and every financial
 * figure rendered here comes verbatim from the
 * whatsapp_connector_get_invoice_document_data() RPC (itself built on
 * get_invoice_payment_summary(), the same function verify_invoice_public()/
 * reports/billing already use) -- this module does zero arithmetic on
 * money, it only formats and lays out values it's handed.
 *
 * In-memory only: buildInvoicePdfBuffer() returns a Buffer built
 * entirely in-process (pdfkit's own internal stream, drained to a
 * Buffer) -- nothing is ever written to disk (directive rule 5).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FONT_ARABIC = path.resolve(__dirname, '..', 'assets', 'fonts', 'NotoSansArabic-Regular.ttf')
const FONT_ARABIC_BOLD = path.resolve(__dirname, '..', 'assets', 'fonts', 'NotoSansArabic-Bold.ttf')
const FONT_LATIN = path.resolve(__dirname, '..', 'assets', 'fonts', 'NotoSans-Regular.ttf')
const FONT_LATIN_BOLD = path.resolve(__dirname, '..', 'assets', 'fonts', 'NotoSans-Bold.ttf')

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

/** Money as a pure Latin-safe string ("350.00 EGP") -- always rendered with the Latin font, never mixed into an Arabic-font run. */
function money(n: number, currency: string): string {
  const formatted = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
  return `${formatted} ${currency}`
}

function formatIssuedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(d)
}

/**
 * Builds the invoice PDF as an in-memory Buffer. Renders every field
 * the directive requires (rule 8): club name, invoice number,
 * customer name, booking reference, field/venue, issue date, total,
 * paid, outstanding, payment status, currency -- refunded is shown
 * whenever non-zero, correctly reflecting a real refund per the
 * canonical financial data (never recomputed here).
 */
export async function buildInvoicePdfBuffer(data: InvoiceDocumentData, opts: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      // compress defaults to true (smaller WhatsApp attachment, the
      // real send path) -- mediaTest.ts passes compress:false so it can
      // assert on literal financial-figure text in the raw PDF stream,
      // a genuine correctness check (directive rule 9/26) that FlateDecode
      // compression would otherwise hide from a simple byte-string search.
      const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, compress: opts.compress ?? true })
      // bidi-shaper's PdfKitDocLike is a narrower structural type than
      // @types/pdfkit's own TextOptions (its `features` is a plain
      // string[] rather than pdfkit's specific OpenTypeFeatures union)
      // -- both describe the same real doc.text() call at runtime, this
      // cast just reconciles the two independently-typed declarations.
      const bidiDoc = doc as unknown as PdfKitDocLike
      const chunks: Buffer[] = []
      doc.on('data', (chunk: Buffer) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      doc.registerFont('Arabic', FONT_ARABIC)
      doc.registerFont('ArabicBold', FONT_ARABIC_BOLD)
      doc.registerFont('Latin', FONT_LATIN)
      doc.registerFont('LatinBold', FONT_LATIN_BOLD)

      const left = doc.page.margins.left
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
      const rightEdge = doc.page.width - doc.page.margins.right

      /** Arabic-only line (label, heading, footer note) -- shaped+reordered via bidi-shaper. */
      const arabicLine = (text: string, opts: { font?: 'Arabic' | 'ArabicBold'; size?: number; color?: string } = {}) => {
        doc.font(opts.font ?? 'Arabic').fontSize(opts.size ?? 11).fillColor(opts.color ?? '#000000')
        textBidi(bidiDoc, text, left, doc.y, { width: pageWidth, align: 'right' })
        doc.fillColor('#000000')
      }

      /**
       * Label/value row: the Arabic label goes through textBidi() with
       * the Arabic font (right-aligned); the value is either plain
       * Latin/numeric text (Latin font, left-aligned) or an Arabic
       * name/string (also textBidi(), same row y) -- pdfkit has no
       * mixed-font-per-line API (confirmed during this fix), so label
       * and value are always two independent calls sharing one `y`,
       * never one call mixing scripts.
       */
      const row = (label: string, value: string, opts: { valueIsArabic?: boolean; bold?: boolean; valueColor?: string } = {}) => {
        const y = doc.y
        doc.font(opts.bold ? 'ArabicBold' : 'Arabic').fontSize(11).fillColor('#000000')
        textBidi(bidiDoc, label, left, y, { width: pageWidth * 0.55, align: 'right' })
        if (opts.valueIsArabic) {
          doc.font(opts.bold ? 'ArabicBold' : 'Arabic').fontSize(11).fillColor(opts.valueColor ?? '#000000')
          textBidi(bidiDoc, value, left, y, { width: pageWidth, align: 'left' })
        } else {
          doc.font(opts.bold ? 'LatinBold' : 'Latin').fontSize(11).fillColor(opts.valueColor ?? '#000000')
          doc.text(value, left, y, { width: pageWidth, align: 'left' })
        }
        doc.fillColor('#000000')
        doc.moveDown(0.55)
      }

      const divider = () => {
        doc.moveTo(left, doc.y).lineTo(rightEdge, doc.y).strokeColor('#dddddd').stroke()
        doc.moveDown(0.8)
      }

      // ---- Header ----
      arabicLine(data.clubName ?? 'ملعبي', { font: 'ArabicBold', size: 20 })
      doc.moveDown(0.2)
      arabicLine('فاتورة', { size: 11, color: '#555555' })
      doc.moveDown(0.8)
      divider()

      // ---- Meta ----
      row('رقم الفاتورة', data.invoiceNumber, { bold: true })
      if (data.bookingRef) row('رقم الحجز', data.bookingRef)
      row('تاريخ الإصدار', formatIssuedAt(data.issuedAt))
      doc.moveDown(0.3)
      divider()

      // ---- Booking details ----
      arabicLine('بيانات الحجز', { font: 'ArabicBold', size: 12 })
      doc.moveDown(0.3)
      if (data.customerName) row('العميل', data.customerName, { valueIsArabic: true })
      if (data.fieldName) row('الملعب', data.fieldName, { valueIsArabic: true })
      doc.moveDown(0.3)
      divider()

      // ---- Financial summary ----
      arabicLine('الملخص المالي', { font: 'ArabicBold', size: 12 })
      doc.moveDown(0.3)
      row('الإجمالي', money(data.total, data.currency))
      row('المدفوع', money(data.paid, data.currency))
      if (data.refunded > 0) {
        row('المسترد', money(data.refunded, data.currency), { valueColor: '#b45309' })
      }
      row('المتبقي', money(data.outstanding, data.currency), { bold: true })
      row('حالة الدفع', PAYMENT_STATUS_LABELS_AR[data.paymentStatus] ?? data.paymentStatus, { valueIsArabic: true, bold: true })

      doc.moveDown(0.8)
      divider()

      // ---- Footer ----
      arabicLine('هذا المستند لقطة بتاريخ إصداره. للاطلاع على آخر حالة مالية محدثة للفاتورة، يرجى استخدام رابط التحقق الآمن المرسل في رسالة واتساب.', { size: 9, color: '#777777' })
      doc.moveDown(0.2)
      arabicLine('عبر ملعبي', { size: 9, color: '#777777' })

      doc.end()
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
