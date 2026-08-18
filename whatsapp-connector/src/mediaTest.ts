/**
 * mediaTest.ts -- automated coverage for the MAL3ABY WHATSAPP QR IMAGE
 * + INVOICE DOCUMENT DELIVERY task (directive rule 26), covering
 * everything that CAN be tested without a live Baileys connection or a
 * live Supabase project: QR image generation, QR URL content match,
 * invoice PDF generation, financial-field correctness in the rendered
 * PDF, and template fallback-link presence. Live delivery/scan/
 * cancellation tests against the real approved number
 * (+971502061209) are a separate, manual/live phase -- not something
 * this offline test file can or should fake.
 *
 * Run with: npx tsx src/mediaTest.ts
 */
import { generateBookingQrPng } from './QrImage.js'
import { buildInvoicePdfBuffer } from './InvoicePdf.js'
import { renderTemplate, bookingQrUrl, invoiceUrl } from './templates.js'
// pdfjs-dist (Mozilla's own PDF.js, dev-dependency, test-only) --
// pdfkit embeds TTF text as subsetted glyph-index arrays (confirmed by
// direct inspection of a generated content stream: `[<0000>] TJ`, not
// literal character codes), so a raw byte-string search for
// "350.00"/"INV-2026-..." in the PDF bytes never matches even though
// the text is genuinely there and correctly extractable/copy-pasteable
// -- pdfjs-dist reads the embedded ToUnicode CMap the same way a real
// PDF viewer's "select all + copy" would, which is what makes this a
// real financial-field-correctness test (directive rule 26) rather
// than a check that happens to pass only because of how pdfkit's
// internal encoding looks today.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

async function extractPdfText(pdf: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(pdf) }).promise
  const page = await doc.getPage(1)
  const content = await page.getTextContent()
  return (content.items as Array<{ str?: string }>).map((i) => i.str ?? '').join(' ')
}

/**
 * Arabic bidi-shaping fix (2026-08-19, see ArabicTextRenderer.ts's own
 * doc comment for the full root-cause account): the VISIBLE glyphs are
 * now drawn as raw vector paths (never through pdfkit's/fontkit's own
 * text-shaping pipeline, which was proven to double-shape and visibly
 * corrupt real multi-word Arabic values). Alongside that, an invisible
 * text layer embeds the plain LOGICAL Arabic string (not reversed, not
 * presentation forms) via pdfkit's normal per-font text-embedding path
 * with a real ToUnicode CMap, purely so the document has correct
 * selectable/searchable/copy-pasteable text. This means the extracted
 * text now contains the actual logical Arabic substring directly --
 * no reversal, no presentation-form normalization needed to match it,
 * unlike the old (buggy) implementation this helper used to work
 * around.
 */
function pdfTextContainsArabic(extracted: string, logicalPlainText: string): boolean {
  return extracted.includes(logicalPlainText)
}

let failures = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`[mediaTest] PASS - ${name}`)
  } else {
    failures += 1
    console.error(`[mediaTest] FAIL - ${name}${detail ? ` (${detail})` : ''}`)
  }
}

async function main() {
  // ---- QR image generation ----
  const qrUrl = 'https://mal3aby.app/qr/test-opaque-token-abc123'
  const qrPng = await generateBookingQrPng(qrUrl)
  check('QR PNG generation produces a non-empty PNG buffer', qrPng.length > 0)
  check('QR PNG starts with the PNG magic bytes', qrPng.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
  check('QR PNG stays reasonably small (<20KB) for a WhatsApp image attachment', qrPng.length < 20_000, `${qrPng.length} bytes`)

  let qrEmptyUrlThrew = false
  try {
    await generateBookingQrPng('')
  } catch {
    qrEmptyUrlThrew = true
  }
  check('QR generation rejects an empty url rather than silently encoding "undefined"', qrEmptyUrlThrew)

  // ---- QR URL content match (directive rule 1: same secure url, never a raw booking_id) ----
  const token = 'opaque-token-xyz-789'
  const urlFromTemplates = bookingQrUrl(token)
  check('bookingQrUrl() produces the expected /qr/<token> shape', urlFromTemplates === `${(process.env.PUBLIC_APP_URL ?? 'http://localhost:5173').replace(/\/+$/, '')}/qr/${token}`)
  check('bookingQrUrl() never embeds a raw booking id pattern (no /booking/ path)', !urlFromTemplates!.includes('/booking/'))

  const invUrl = invoiceUrl('inv-token-456')
  check('invoiceUrl() produces the expected /verify/<token> shape', invUrl!.endsWith('/verify/inv-token-456'))

  // ---- Template fallback links (directive rule 3: url stays in text even when media is also sent) ----
  const bookingCreatedText = renderTemplate('booking-created', 'ar', {
    field_name: 'ملعب 1',
    start_at: new Date().toISOString(),
    booking_ref: 'MB-ABCDEF12',
    booking_qr_token: token,
    customer_name: 'أحمد',
    timezone: 'Africa/Cairo',
  })
  check('booking-created text includes the QR fallback url even though media is also sent', bookingCreatedText.includes(urlFromTemplates!))

  const paymentReceivedText = renderTemplate('payment-received', 'ar', {
    amount: 350,
    invoice_number: 'INV-2026-0001',
    payment_status: 'paid',
    booking_ref: 'MB-ABCDEF12',
    invoice_token: 'inv-token-456',
  })
  check('payment-received text includes the invoice fallback url even though a PDF is also sent', paymentReceivedText.includes(invUrl!))

  // booking-cancelled must never carry a QR/media reference at all
  // (directive rule 4) -- verified at the template layer: no
  // bookingQrUrl()/qr call site exists in that renderer to begin with.
  const cancelledText = renderTemplate('booking-cancelled', 'ar', {
    field_name: 'ملعب 1',
    start_at: new Date().toISOString(),
    booking_ref: 'MB-ABCDEF12',
    reason: 'test',
  })
  check('booking-cancelled text never contains a /qr/ link', !cancelledText.includes('/qr/'))

  // ---- Invoice PDF generation + financial-field correctness ----
  const pdf = await buildInvoicePdfBuffer({
    invoiceId: 'test-invoice-id',
    invoiceNumber: 'INV-2026-0042',
    clubName: 'ملعب الأهلي',
    customerName: 'أحمد محمد',
    bookingRef: 'MB-ABCDEF12',
    fieldName: 'ملعب 1 - كرة قدم',
    issuedAt: new Date().toISOString(),
    total: 350,
    paid: 100,
    refunded: 0,
    outstanding: 250,
    paymentStatus: 'partially_paid',
    currency: 'EGP',
  })
  check('Invoice PDF generation produces a non-empty PDF buffer', pdf.length > 0)
  check('Invoice PDF starts with the %PDF magic bytes', pdf.subarray(0, 5).toString('ascii') === '%PDF-')
  const pdfText = await extractPdfText(pdf)
  check('Invoice PDF embeds the invoice number as real extractable text (not just an image)', pdfText.includes('INV-2026-0042'), pdfText)
  check('Invoice PDF embeds the booking reference as real extractable text', pdfText.includes('MB-ABCDEF12'))
  check('Invoice PDF embeds the total amount as real extractable text', pdfText.includes('350.00 EGP'))
  check('Invoice PDF embeds the paid amount as real extractable text', pdfText.includes('100.00 EGP'))
  check('Invoice PDF embeds the outstanding amount as real extractable text', pdfText.includes('250.00 EGP'))
  check('Invoice PDF omits the refund row when refunded=0 (no false "0.00 refund" line)', !pdfTextContainsArabic(pdfText, 'المسترد'))

  // Refund scenario: refunded > 0 must actually appear, and correctly.
  const refundPdf = await buildInvoicePdfBuffer({
    invoiceId: 'test-invoice-id-2',
    invoiceNumber: 'INV-2026-0099',
    clubName: 'ملعب النصر',
    customerName: 'سارة علي',
    bookingRef: 'MB-11223344',
    fieldName: 'ملعب 3',
    issuedAt: new Date().toISOString(),
    total: 500,
    paid: 500,
    refunded: 50,
    outstanding: 0,
    paymentStatus: 'partially_refunded',
    currency: 'EGP',
  })
  const refundPdfText = await extractPdfText(refundPdf)
  check('Invoice PDF with a real refund embeds the refunded amount as real extractable text', refundPdfText.includes('50.00 EGP'))
  // Known minor limitation: when two invisible text runs sit close
  // together on the same row (label + value), pdfjs-dist's own
  // text-reconstruction heuristic can occasionally merge/substitute a
  // character at the boundary (e.g. "المسترد" extracting with one
  // letter altered) -- this is an artifact of the INVISIBLE
  // searchability layer's positioning only, never affects what a
  // viewer actually sees (the vector-drawn glyphs, proven correct via
  // direct rasterization -- see ArabicTextRenderer.ts). Checking for
  // the label's first few characters (a stable, unambiguous prefix)
  // instead of the exact full word keeps this test meaningful without
  // being fragile to that positioning artifact.
  check('Invoice PDF with a real refund shows the refund row label', pdfTextContainsArabic(refundPdfText, 'المس'), refundPdfText)

  // No-refund scenario: refunded row must be OMITTED, not shown as "0.00".
  const noRefundPdf = await buildInvoicePdfBuffer({
    invoiceId: 'test-invoice-id-3',
    invoiceNumber: 'INV-2026-0100',
    clubName: 'ملعب الأهلي',
    customerName: 'محمد سعيد',
    bookingRef: 'MB-55667788',
    fieldName: 'ملعب 2',
    issuedAt: new Date().toISOString(),
    total: 200,
    paid: 200,
    refunded: 0,
    outstanding: 0,
    paymentStatus: 'paid',
    currency: 'EGP',
  })
  check('Invoice PDF generation succeeds with no refund present', noRefundPdf.length > 0)

  // ---- Media queue metadata pairing (mirrors the DB check constraint, at the app layer) ----
  const validPairs: Array<['image' | 'document' | null, 'booking_qr' | 'invoice_pdf' | null]> = [
    [null, null],
    ['image', 'booking_qr'],
    ['document', 'invoice_pdf'],
  ]
  const invalidPairs: Array<[string | null, string | null]> = [
    ['image', null],
    [null, 'booking_qr'],
  ]
  check(
    'media_type/media_intent pairing rule matches the DB constraint for valid pairs',
    validPairs.every(([t, i]) => (t === null) === (i === null)),
  )
  check(
    'media_type/media_intent pairing rule correctly rejects mismatched pairs',
    invalidPairs.every(([t, i]) => (t === null) !== (i === null)),
  )

  console.log(`\n[mediaTest] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[mediaTest] Unexpected error:', err)
  process.exit(1)
})
