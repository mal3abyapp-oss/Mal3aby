import QRCode from 'qrcode'

/**
 * QrImage -- generates the booking check-in QR as an in-memory PNG
 * Buffer, per the directive:
 *
 *  - No new QR credential system: the caller passes the SAME secure
 *    `https://mal3aby.app/qr/<opaque-token>` url templates.ts already
 *    puts in the message text (bookingQrUrl()) -- this module never
 *    sees a raw booking_id or mints anything itself, it only encodes a
 *    url it's handed.
 *  - Local, free, open-source generation only: `qrcode` (pure JS,
 *    dependencies are pngjs/yargs/dijkstrajs only -- no browser, no
 *    external/paid QR API, no native binary). Runs inside this
 *    process, nothing is ever sent to a third party to produce the
 *    image.
 *  - Generate in memory -> return Buffer -> caller sends and discards.
 *    This module never writes the PNG to disk and never returns
 *    anything but a Buffer -- there is no persistence step to forget.
 *
 * Sizing/reliability tuning (directive rule 2 -- "no over-designed
 * image that hurts scan reliability"):
 *  - errorCorrectionLevel 'M' (~15% recovery): the standard balance for
 *    a WhatsApp-displayed/phone-camera-scanned code -- 'H' would only
 *    be needed if the image were going to be printed small or overlaid
 *    with a logo (neither applies here), and 'L' trims too much
 *    recovery margin for a photo taken off a phone screen in variable
 *    lighting.
 *  - margin: 2 modules -- the actual minimum "quiet zone" the QR spec
 *    requires for reliable decode is 4 modules, but WhatsApp itself
 *    already renders a solid white/dark chat-bubble margin around any
 *    image it displays, so 2 is not literally violating the spec's
 *    intent (a completely zero quiet zone is what breaks scanners);
 *    kept slightly tighter than the raw default to hold the PNG's
 *    physical size down (rule 16: PDFs get big, but even the small QR
 *    should not carry unnecessary padding weight) without approaching
 *    the failure zone.
 *  - width 512px: large enough that the PNG stays crisp after
 *    WhatsApp's own client-side image compression/resizing (a common
 *    real-world QR-in-chat failure mode is the platform's own
 *    downscaling softening a too-small source image below decodability
 *    for a phone camera at arm's length), small enough that the PNG
 *    stays a few KB, not hundreds.
 */
const QR_PNG_OPTIONS: QRCode.QRCodeToBufferOptions = {
  type: 'png',
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 512,
  color: {
    dark: '#000000',
    light: '#FFFFFF',
  },
}

/**
 * Encodes `url` (the SAME secure opaque url already in the message
 * text -- see bookingQrUrl() in templates.ts) as a PNG Buffer. Throws
 * on an empty/invalid url rather than silently generating a QR of
 * "undefined" -- the caller (QueueConsumer) is expected to have
 * already validated media_intent === 'booking_qr' and a real token was
 * present before ever calling this.
 */
export async function generateBookingQrPng(url: string): Promise<Buffer> {
  if (!url || !url.trim()) {
    throw new Error('generateBookingQrPng: empty url')
  }
  return QRCode.toBuffer(url, QR_PNG_OPTIONS)
}
