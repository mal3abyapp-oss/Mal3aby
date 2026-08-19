import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { formatCurrency, type SupportedLocale } from '@/lib/i18n/config'
import { Button } from '@/components/ui/button'
import { Copy, Check, MessageCircle, ChevronDown } from 'lucide-react'
import { PaymentProofUpload } from './PaymentProofUpload'

/**
 * PaymentMethodsPanel -- the Booking Success / Secure Booking payment
 * panel (directive Part XI-XII). Reads the club's own active,
 * customer-visible payment methods (get_public_payment_methods_for_
 * booking, scoped to this exact booking's club -- never a hardcoded
 * global list, never another club's methods) and the club's own
 * payment-receipt WhatsApp number (never Mal3aby's).
 */

interface PaymentMethod {
  id: string
  underlyingMethod: string
  provider: string | null
  nameAr: string
  nameEn: string
  instructionsAr: string | null
  instructionsEn: string | null
  details: Record<string, string>
  referenceRequired: boolean
  proofRequired: boolean
}

async function fetchMethods(bookingId: string): Promise<PaymentMethod[]> {
  const { data, error } = await supabase.rpc('get_public_payment_methods_for_booking', { p_booking_id: bookingId })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    underlyingMethod: r.underlying_method,
    provider: r.provider,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    instructionsAr: r.instructions_ar,
    instructionsEn: r.instructions_en,
    details: (r.details as Record<string, string>) ?? {},
    referenceRequired: r.reference_required,
    proofRequired: r.proof_required,
  }))
}

async function fetchReceiptContact(bookingId: string): Promise<{ receiptWa: string | null; generalWa: string | null }> {
  const { data, error } = await supabase.rpc('get_public_booking_receipt_contact', { p_booking_id: bookingId })
  if (error) throw error
  const row = data?.[0]
  return { receiptWa: row?.payment_receipt_whatsapp_number ?? null, generalWa: row?.whatsapp_number ?? null }
}

function toWaDigits(phone: string): string {
  return phone.replace(/\D/g, '')
}

const DETAIL_KEY_LABELS: Record<string, { ar: string; en: string }> = {
  bank_name: { ar: 'البنك', en: 'Bank' },
  account_holder: { ar: 'صاحب الحساب', en: 'Account holder' },
  account_number: { ar: 'رقم الحساب', en: 'Account number' },
  iban: { ar: 'IBAN', en: 'IBAN' },
  swift: { ar: 'SWIFT', en: 'SWIFT' },
  phone: { ar: 'الرقم', en: 'Number' },
  beneficiary: { ar: 'المستفيد', en: 'Beneficiary' },
  link: { ar: 'الرابط', en: 'Link' },
  terminal_reference: { ar: 'مرجع الماكينة', en: 'Terminal reference' },
}

export function PaymentMethodsPanel({
  bookingId,
  clubId,
  bookingRef,
  clubName,
  total,
  currency,
  locale,
}: {
  bookingId: string
  clubId: string
  bookingRef: string | null
  clubName: string
  total: number | null
  currency: string
  locale: SupportedLocale
}) {
  const { t } = useTranslation()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const { data: methods = [], isLoading } = useQuery({
    queryKey: ['public-payment-methods', bookingId],
    queryFn: () => fetchMethods(bookingId),
  })

  const { data: contact } = useQuery({
    queryKey: ['public-receipt-contact', bookingId],
    queryFn: () => fetchReceiptContact(bookingId),
  })

  const receiptWaNumber = contact?.receiptWa || contact?.generalWa || null

  async function copy(value: string, key: string) {
    await navigator.clipboard.writeText(value)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 2000)
  }

  if (isLoading) {
    return <p className="text-sm text-text-secondary">{t('publicBooking.loading')}</p>
  }

  if (methods.length === 0) {
    return null
  }

  const isEn = locale === 'en'

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{t('publicBooking.choosePaymentMethod')}</p>
      <div className="flex flex-col gap-2">
        {methods.map((m) => {
          const isOpen = expandedId === m.id
          const name = isEn ? m.nameEn : m.nameAr
          const instructions = isEn ? m.instructionsEn : m.instructionsAr
          return (
            <div key={m.id} className="rounded-lg border border-border bg-surface">
              <button
                type="button"
                className="flex w-full items-center justify-between p-3 text-start text-sm font-medium"
                onClick={() => setExpandedId(isOpen ? null : m.id)}
              >
                <span>{name}</span>
                <ChevronDown className={`size-4 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
              </button>
              {isOpen && (
                <div className="flex flex-col gap-2 border-t border-border p-3 text-sm">
                  {Object.entries(m.details).filter(([, v]) => v).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <span className="text-xs text-text-secondary">{DETAIL_KEY_LABELS[key] ? DETAIL_KEY_LABELS[key][isEn ? 'en' : 'ar'] : key}</span>
                      <div className="flex items-center gap-1">
                        <span dir="ltr" className="font-medium tabular-nums">{value}</span>
                        <Button size="sm" variant="ghost" onClick={() => copy(value, `${m.id}-${key}`)}>
                          {copiedKey === `${m.id}-${key}` ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                        </Button>
                      </div>
                    </div>
                  ))}
                  {instructions && <p className="text-xs text-text-secondary">{instructions}</p>}
                  {total != null && (
                    <p className="text-xs font-medium">{t('publicBooking.amountToPay')}: {formatCurrency(total, locale, currency)}</p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p className="text-xs font-medium text-text-secondary">{t('publicBooking.proofUpload.title')}</p>
      <div className="flex flex-wrap gap-2">
        {receiptWaNumber && (
          <Button asChild size="sm" variant="outline">
            <a
              href={`https://wa.me/${toWaDigits(receiptWaNumber)}?text=${encodeURIComponent(
                t('publicBooking.receiptWaMessage', {
                  club: clubName,
                  bookingRef: bookingRef ?? '',
                  amount: total != null ? formatCurrency(total, locale, currency) : '',
                }),
              )}`}
              target="_blank"
              rel="noreferrer"
            >
              <MessageCircle className="me-1 size-4" /> {t('publicBooking.sendReceiptWhatsapp')}
            </a>
          </Button>
        )}
        <PaymentProofUpload bookingId={bookingId} clubId={clubId} amount={total} />
      </div>
    </div>
  )
}
