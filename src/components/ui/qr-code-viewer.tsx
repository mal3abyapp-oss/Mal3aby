import { useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

/**
 * QrCodeViewer -- the ONE shared QR-image display component (directive
 * item 15, "لا تنشئ InvoiceQr/BookingQr/SecurePageQr بثلاث
 * implementations مختلفة"). Extracted from SecureBookingPage.tsx's
 * original inline markup (the first surface to build this pattern) so
 * every surface that displays an already-rendered QR data URL --
 * SecureBookingPage's own attendance QR, and now VerifyInvoicePage's
 * "عرض رمز QR" feature -- shares the exact same click-to-fullscreen
 * behavior, sizing, and accessibility labeling instead of three
 * separate copies drifting apart over time.
 *
 * Pure presentation only -- takes an already-generated QR data URL
 * (via the `qrcode` npm package's QRCode.toDataURL(), called once by
 * whichever page owns the actual token/RPC call) and a label; never
 * itself calls any RPC, mints any credential, or knows about tokens.
 * Each caller remains responsible for its own token-minting /
 * credential-fetching logic (which differs per surface: staff-
 * authenticated ensure_booking_qr() vs. anonymous token-possession-
 * gated RPCs) -- this component only renders the result.
 */
export function QrCodeViewer({ qrDataUrl, label, hint }: { qrDataUrl: string; label: string; hint?: string }) {
  const [fullScreenOpen, setFullScreenOpen] = useState(false)

  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <button
        type="button"
        onClick={() => setFullScreenOpen(true)}
        className="group relative"
        aria-label={label}
      >
        <img src={qrDataUrl} alt={label} className="size-40" />
        <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100">
          <Maximize2 className="size-6 text-white" />
        </span>
      </button>
      {hint && <p className="text-xs text-text-secondary">{hint}</p>}

      <Dialog open={fullScreenOpen} onOpenChange={setFullScreenOpen}>
        <DialogContent className="flex max-w-none flex-col items-center justify-center gap-4 border-none bg-white p-8 sm:max-w-none">
          <DialogTitle className="sr-only">{label}</DialogTitle>
          <img src={qrDataUrl} alt={label} className="size-[min(80vw,80vh)]" />
        </DialogContent>
      </Dialog>
    </div>
  )
}
