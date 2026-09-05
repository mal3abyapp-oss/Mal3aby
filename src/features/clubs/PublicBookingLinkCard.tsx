import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { translateSupabaseError } from '@/lib/errors'
import { Copy, Share2, QrCode, Download, Printer, Check } from 'lucide-react'

/**
 * PublicBookingLinkCard -- the club-owner "Your Booking Link" sharing
 * tools (directive Section 50): copy link, share, view QR, download
 * QR, print QR, plus the enable/disable toggle (Section 51's
 * practical printable QR, not a Design Studio -- a clean card with
 * club name + "Scan to Book" + the QR + the brand line).
 *
 * The Club Booking QR is generated CLIENT-SIDE, directly from the
 * public URL -- no server round-trip, no credential to mint (see the
 * schema migration's own note: this QR has no token/security model
 * beyond public_booking_enabled itself).
 */
interface PublicClubSettings {
  id: string
  publicSlug: string | null
  publicBookingEnabled: boolean
  name: string
}

async function fetchClub(clubId: string): Promise<PublicClubSettings> {
  const { data, error } = await supabase.from('clubs').select('id, public_slug, public_booking_enabled, name').eq('id', clubId).single()
  if (error) throw error
  return { id: data.id, publicSlug: data.public_slug, publicBookingEnabled: data.public_booking_enabled, name: data.name }
}

export function PublicBookingLinkCard() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [fullScreenOpen, setFullScreenOpen] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [desiredSlug, setDesiredSlug] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const { data: club } = useQuery({ queryKey: ['public-club-settings', currentClubId], queryFn: () => fetchClub(currentClubId!), enabled: !!currentClubId })

  const publicUrl = useMemo(() => {
    if (!club?.publicSlug || typeof window === 'undefined') return null
    return `${window.location.origin}/c/${club.publicSlug}`
  }, [club?.publicSlug])

  const generateSlugMutation = useMutation({
    mutationFn: async () => {
      if (!currentClubId) throw new Error('no club')
      const { error } = await supabase.rpc('set_club_public_slug', { p_club_id: currentClubId })
      if (error) throw error
    },
    onSuccess: () => {
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['public-club-settings', currentClubId] })
    },
    onError: (error) => setFormError(translateSupabaseError(error, t('clubs.publicBookingLink.generateError'))),
  })

  const setCustomSlugMutation = useMutation({
    mutationFn: async () => {
      if (!currentClubId) throw new Error('no club')
      const { error } = await supabase.rpc('set_club_public_slug', { p_club_id: currentClubId, p_desired_slug: desiredSlug })
      if (error) throw error
    },
    onSuccess: () => {
      setFormError(null)
      setDesiredSlug('')
      void queryClient.invalidateQueries({ queryKey: ['public-club-settings', currentClubId] })
    },
    onError: (error) => setFormError(translateSupabaseError(error, t('clubs.publicBookingLink.customSlugError'))),
  })

  const toggleEnabledMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!currentClubId) throw new Error('no club')
      const { error } = await supabase.rpc('set_club_public_booking_enabled', { p_club_id: currentClubId, p_enabled: enabled })
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['public-club-settings', currentClubId] }),
  })

  async function handleCopy() {
    if (!publicUrl) return
    await navigator.clipboard.writeText(publicUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleShare() {
    if (!publicUrl) return
    if (navigator.share) {
      try {
        await navigator.share({ title: club?.name, url: publicUrl })
      } catch {
        // user cancelled the native share sheet -- not an error
      }
    } else {
      await handleCopy()
    }
  }

  async function handleViewQr() {
    if (!publicUrl) return
    const url = await QRCode.toDataURL(publicUrl, { width: 480, margin: 1 })
    setQrDataUrl(url)
    setFullScreenOpen(true)
  }

  async function handleDownloadQr() {
    if (!publicUrl) return
    const url = await QRCode.toDataURL(publicUrl, { width: 1024, margin: 2 })
    const a = document.createElement('a')
    a.href = url
    a.download = `${club?.publicSlug ?? 'club'}-booking-qr.png`
    a.click()
  }

  async function handlePrint() {
    if (!publicUrl || !club) return
    const url = await QRCode.toDataURL(publicUrl, { width: 640, margin: 1 })
    const printWindow = window.open('', '_blank')
    if (!printWindow) return
    // VISUAL AUDIT B2 (2026-09-05): #444/#888 below are intentionally
    // literal, not a token-duplication bug — this markup is written via
    // document.write() into a brand-new, separate HTML document opened
    // in its own window, which has no access to the app's index.css
    // custom properties (var(--color-text-secondary) would not resolve
    // here). Kept as documented literals instead: #444 approximates
    // --color-text-primary (#111827) at reduced weight for the tagline,
    // #888 approximates --color-text-secondary (#667085) for the small
    // brand footer line. If those tokens are ever retuned, revisit here too.
    printWindow.document.write(`<!doctype html><html><head><title>${club.name}</title><style>
      body { font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
      h1 { font-size: 28px; margin-bottom: 4px; }
      p.tagline { font-size: 18px; color: #444; margin-top: 0; }
      img { width: 320px; height: 320px; margin: 24px 0; }
      p.brand { color: #888; font-size: 14px; }
    </style></head><body>
      <h1>${club.name}</h1>
      <p class="tagline">${t('clubs.publicBookingLink.printTagline')}</p>
      <img src="${url}" alt="QR" />
      <p class="brand">mal3aby.app</p>
      <script>window.onload = () => window.print()</script>
    </body></html>`)
    printWindow.document.close()
  }

  if (!club) return null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t('clubs.publicBookingLink.title')}</CardTitle>
        {club.publicSlug && (
          <Button
            size="sm"
            variant={club.publicBookingEnabled ? 'outline' : 'default'}
            disabled={toggleEnabledMutation.isPending}
            onClick={() => toggleEnabledMutation.mutate(!club.publicBookingEnabled)}
          >
            {club.publicBookingEnabled ? t('clubs.publicBookingLink.disable') : t('clubs.publicBookingLink.enable')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!club.publicSlug && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-text-secondary">{t('clubs.publicBookingLink.noSlugHint')}</p>
            {formError && <p role="alert" className="text-sm text-status-danger">{formError}</p>}
            <Button size="sm" className="w-fit" disabled={generateSlugMutation.isPending} onClick={() => generateSlugMutation.mutate()}>
              {generateSlugMutation.isPending ? t('clubs.publicBookingLink.generating') : t('clubs.publicBookingLink.generateLink')}
            </Button>
          </div>
        )}

        {club.publicSlug && publicUrl && (
          <>
            <div className="flex items-center gap-2 rounded-md border border-border bg-page-bg p-2">
              <code dir="ltr" className="flex-1 truncate text-sm">{publicUrl}</code>
              <Button size="sm" variant="ghost" onClick={handleCopy}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={handleShare}>
                <Share2 className="size-4" /> {t('clubs.publicBookingLink.share')}
              </Button>
              <Button size="sm" variant="outline" onClick={handleViewQr}>
                <QrCode className="size-4" /> {t('clubs.publicBookingLink.viewQr')}
              </Button>
              <Button size="sm" variant="outline" onClick={handleDownloadQr}>
                <Download className="size-4" /> {t('clubs.publicBookingLink.downloadQr')}
              </Button>
              <Button size="sm" variant="outline" onClick={handlePrint}>
                <Printer className="size-4" /> {t('clubs.publicBookingLink.printQr')}
              </Button>
            </div>

            {!club.publicBookingEnabled && (
              <p role="alert" className="text-xs text-status-warning">{t('clubs.publicBookingLink.disabledHint')}</p>
            )}

            <div className="flex flex-col gap-1.5 border-t border-border pt-3">
              <label className="text-xs font-medium text-text-secondary">{t('clubs.publicBookingLink.changeSlugLabel')}</label>
              <div className="flex gap-2">
                <Input
                  value={desiredSlug}
                  onChange={(e) => { setDesiredSlug(e.target.value); setFormError(null) }}
                  placeholder={club.publicSlug}
                  dir="ltr"
                  className="flex-1"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!desiredSlug.trim() || setCustomSlugMutation.isPending}
                  onClick={() => setCustomSlugMutation.mutate()}
                >
                  {setCustomSlugMutation.isPending ? t('clubs.publicBookingLink.saving') : t('clubs.publicBookingLink.save')}
                </Button>
              </div>
              {formError && <p role="alert" className="text-xs text-status-danger">{formError}</p>}
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={fullScreenOpen} onOpenChange={setFullScreenOpen}>
        <DialogContent className="flex max-w-none flex-col items-center justify-center gap-4 border-none bg-white p-8 sm:max-w-none">
          <DialogTitle className="sr-only">{t('clubs.publicBookingLink.viewQr')}</DialogTitle>
          {qrDataUrl && <img src={qrDataUrl} alt="QR" className="size-[min(80vw,80vh)]" />}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
