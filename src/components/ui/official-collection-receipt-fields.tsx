import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Upload, CheckCircle2 } from 'lucide-react'

/**
 * Government / Ministry Collection Compliance -- Phase B directive
 * (2026-08-20): "لا تنشئ تطبيقات مختلفة للمنطق نفسه" (do not build
 * separate implementations of the same logic). This is the ONE shared
 * receipt-entry surface for every payment-recording path in the app --
 * QuickBookingSheet's "pay now", BookingDetailSheet's collect-existing-
 * balance form, and BillingPage's split-payment form all use this same
 * hook + component pair, so behavior can never drift between them the
 * way the underlying enforcement already doesn't drift between
 * record_payment() and _create_booking_internal() (see the 2026-08-20
 * migration that closed that server-side gap).
 *
 * useOfficialReceipt() owns:
 * - fetching the effective policy (field -> branch -> club, identical
 *   resolution to the server-side guard, via get_effective_government_policy)
 * - whether a receipt is required for the CURRENTLY SELECTED payment
 *   method (not a static UI assumption -- this recomputes if the method
 *   changes, satisfying "لا تفرض إذا لم يكن الإيصال مطلوبًا")
 * - all receipt field state (serial/date/book/series/notes/image)
 * - image upload to the private official-receipts bucket
 * - a single isValid + a single getPayload() the caller passes straight
 *   into record_payment_with_official_receipt() / create_booking()
 * - reset() for cancel/retry/payment-method-change flows
 *
 * <OfficialCollectionReceiptFields> owns only rendering -- it shows
 * nothing at all when the policy doesn't require a receipt for the
 * given method (requirement 6: never complicate the UI when it's not
 * needed), and shows exactly the fields the policy has actually enabled
 * (book/series/image are each independently toggleable per policy --
 * requirement 7: driven by the effective policy, never hardcoded).
 */

export interface EffectiveGovernmentPolicy {
  enabled: boolean
  official_receipt_required: boolean
  required_payment_methods: string[] | null
  receipt_book_enabled: boolean
  receipt_series_enabled: boolean
  receipt_image_required: boolean
}

const MAX_FILE_BYTES = 10 * 1024 * 1024
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'application/pdf']

async function fetchEffectivePolicy(clubId: string, branchId: string | null | undefined, fieldId: string | null | undefined): Promise<EffectiveGovernmentPolicy | null> {
  const { data, error } = await supabase.rpc('get_effective_government_policy', {
    p_club_id: clubId,
    p_branch_id: branchId ?? undefined,
    p_field_id: fieldId ?? undefined,
  })
  if (error) throw error
  return data ?? null
}

export function useOfficialReceipt({
  clubId,
  branchId,
  fieldId,
  method,
  enabled = true,
}: {
  clubId: string | null | undefined
  branchId?: string | null
  fieldId?: string | null
  method: string
  /** Set false to skip the policy fetch entirely (e.g. dialog not open yet). */
  enabled?: boolean
}) {
  const { t } = useTranslation()

  const { data: policy, isLoading: policyLoading } = useQuery({
    queryKey: ['government-policy', clubId, branchId, fieldId],
    queryFn: () => fetchEffectivePolicy(clubId!, branchId, fieldId),
    enabled: enabled && !!clubId,
  })

  const required = !!policy?.enabled && !!policy.official_receipt_required
    && (policy.required_payment_methods ?? []).includes(method)

  const [serial, setSerial] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [book, setBook] = useState('')
  const [series, setSeries] = useState('')
  const [notes, setNotes] = useState('')
  const [imagePath, setImagePath] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const imageUploadMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!clubId) throw new Error('no club')
      if (!ACCEPTED_TYPES.includes(file.type)) {
        throw new Error(t('governmentCompliance.receiptImageInvalidType'))
      }
      if (file.size > MAX_FILE_BYTES) {
        throw new Error(t('governmentCompliance.receiptImageTooLarge'))
      }
      const ext = file.name.split('.').pop() ?? 'bin'
      // Path convention (official_receipts_bucket_insert policy):
      // club_id/<key>/filename -- the key only needs to be a stable
      // per-upload folder, not the eventual receipt row's real id
      // (that id doesn't exist yet at upload time; the RPC links the
      // path to the receipt row afterwards via p_receipt_image_path).
      const path = `${clubId}/${crypto.randomUUID()}/${Date.now()}.${ext}`
      const { error } = await supabase.storage.from('official-receipts').upload(path, file, {
        contentType: file.type,
        upsert: false,
      })
      if (error) throw error
      return path
    },
    onSuccess: (path) => {
      setImagePath(path)
      setImageError(null)
    },
    onError: (error) => setImageError(error instanceof Error ? error.message : t('governmentCompliance.receiptImageUploadError')),
  })

  function reset() {
    setSerial('')
    setDate(new Date().toISOString().slice(0, 10))
    setBook('')
    setSeries('')
    setNotes('')
    setImagePath(null)
    setImageError(null)
    imageUploadMutation.reset()
  }

  const missingSerial = required && !serial.trim()
  const missingDate = required && !date
  const missingImage = required && !!policy?.receipt_image_required && !imagePath
  const isValid = !required || (!missingSerial && !missingDate && !missingImage)

  // Field name is p_receipt_notes to match create_booking()'s
  // parameter name (its own p_notes param already means the booking's
  // general notes, so the receipt-specific one needed a distinct name).
  // record_payment_with_official_receipt() calls its equivalent
  // parameter p_notes -- callers targeting that RPC should read
  // getPayload().p_receipt_notes and pass it as p_notes themselves
  // rather than this hook guessing which RPC it will be sent to.
  function getPayload() {
    if (!required) return null
    return {
      p_receipt_serial: serial.trim(),
      p_receipt_date: date,
      p_receipt_book: book.trim() || undefined,
      p_receipt_series: series.trim() || undefined,
      p_receipt_image_path: imagePath ?? undefined,
      p_receipt_notes: notes.trim() || undefined,
    }
  }

  return {
    policy,
    policyLoading,
    required,
    serial, setSerial,
    date, setDate,
    book, setBook,
    series, setSeries,
    notes, setNotes,
    imagePath,
    imageError,
    fileInputRef,
    uploadImage: (file: File) => imageUploadMutation.mutate(file),
    isUploadingImage: imageUploadMutation.isPending,
    missingSerial,
    missingDate,
    missingImage,
    isValid,
    getPayload,
    reset,
  }
}

export type OfficialReceiptState = ReturnType<typeof useOfficialReceipt>

/** Translates a raw record_payment()/record_payment_with_official_receipt() error into one of the specific, actionable copy strings the directive requires (duplicate serial, already-linked, amount mismatch, not found, required-but-missing) -- falls back to the caller's own generic message for anything else. */
export function translateReceiptError(rawMessage: string, t: (key: string) => string, fallback: string): string {
  const msg = rawMessage.toLowerCase()
  if (msg.includes('unique constraint') || msg.includes('duplicate key') || msg.includes('already registered')) {
    return t('governmentCompliance.duplicateReceiptError')
  }
  if (msg.includes('already linked to a payment')) {
    return t('governmentCompliance.receiptAlreadyLinkedError')
  }
  if (msg.includes('does not match the payment amount')) {
    return t('governmentCompliance.receiptAmountMismatchError')
  }
  if (msg.includes('not found, not active') || msg.includes('does not belong to this club')) {
    return t('governmentCompliance.receiptNotFoundError')
  }
  if (msg.includes('official collection receipt required')) {
    return t('governmentCompliance.receiptRequiredError')
  }
  return fallback
}

export function OfficialCollectionReceiptFields({ state }: { state: OfficialReceiptState }) {
  const { t } = useTranslation()

  if (!state.required) return null

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
      <p className="text-xs font-medium text-warning">{t('governmentCompliance.receiptSectionTitle')}</p>
      <div className="grid grid-cols-2 gap-2">
        <Input
          required
          placeholder={t('governmentCompliance.receiptSerialLabel')}
          value={state.serial}
          onChange={(e) => state.setSerial(e.target.value)}
        />
        <Input
          required
          type="date"
          value={state.date}
          onChange={(e) => state.setDate(e.target.value)}
        />
        {state.policy?.receipt_book_enabled && (
          <Input
            placeholder={t('governmentCompliance.receiptBookLabel')}
            value={state.book}
            onChange={(e) => state.setBook(e.target.value)}
          />
        )}
        {state.policy?.receipt_series_enabled && (
          <Input
            placeholder={t('governmentCompliance.receiptSeriesLabel')}
            value={state.series}
            onChange={(e) => state.setSeries(e.target.value)}
          />
        )}
      </div>
      <Input
        placeholder={t('governmentCompliance.receiptNotesLabel')}
        value={state.notes}
        onChange={(e) => state.setNotes(e.target.value)}
      />

      {!!state.policy?.receipt_image_required && (
        <div className="flex flex-col gap-1">
          <input
            ref={state.fileInputRef}
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) state.uploadImage(file)
              e.target.value = ''
            }}
          />
          {state.imagePath ? (
            <div className="flex items-center gap-2 text-xs text-status-success">
              <CheckCircle2 className="size-3.5 shrink-0" />
              {t('governmentCompliance.receiptImageUploaded')}
              <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => state.fileInputRef.current?.click()}>
                {t('governmentCompliance.receiptImageChange')}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              disabled={state.isUploadingImage}
              onClick={() => state.fileInputRef.current?.click()}
            >
              <Upload className="me-1 size-3.5" />
              {state.isUploadingImage ? t('governmentCompliance.receiptImageUploading') : t('governmentCompliance.receiptImageUpload')}
            </Button>
          )}
          {state.imageError && <p role="alert" className="text-xs text-status-danger">{state.imageError}</p>}
          {state.missingImage && !state.imageError && (
            <p className="text-xs text-status-danger">{t('governmentCompliance.receiptImageRequired')}</p>
          )}
        </div>
      )}
    </div>
  )
}
