import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Upload, CheckCircle2, XCircle, Clock } from 'lucide-react'

/**
 * PaymentProofUpload -- directive Part XII: "UPLOAD RECEIPT INSIDE
 * MAL3ABY" as one of the two receipt options (alongside WhatsApp,
 * already on PaymentMethodsPanel). Uploads directly to the private
 * payment-proofs Storage bucket (anon-safe INSERT policy), then
 * records the metadata via record_payment_proof_upload() -- the RPC
 * validates the storage path actually belongs to this booking/club
 * before accepting it (see that RPC's own doc comment).
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'application/pdf']

async function fetchProofStatus(bookingId: string) {
  const { data, error } = await supabase.rpc('get_public_payment_proof_status', { p_booking_id: bookingId })
  if (error) throw error
  return data?.[0] ?? null
}

export function PaymentProofUpload({
  bookingId,
  clubId,
  amount,
  paymentMethodConfigId,
}: {
  bookingId: string
  clubId: string
  amount: number | null
  paymentMethodConfigId?: string
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: proofStatus } = useQuery({
    queryKey: ['public-proof-status', bookingId],
    queryFn: () => fetchProofStatus(bookingId),
    refetchInterval: 15000,
  })

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        throw new Error(t('publicBooking.proofUpload.invalidType'))
      }
      if (file.size > MAX_FILE_BYTES) {
        throw new Error(t('publicBooking.proofUpload.tooLarge'))
      }
      const ext = file.name.split('.').pop() ?? 'bin'
      const path = `${clubId}/${bookingId}/${Date.now()}.${ext}`
      const { error: uploadError } = await supabase.storage.from('payment-proofs').upload(path, file, {
        contentType: file.type,
        upsert: false,
      })
      if (uploadError) throw uploadError

      const { error: rpcError } = await supabase.rpc('record_payment_proof_upload', {
        p_booking_id: bookingId,
        p_amount: amount ?? 0,
        p_storage_path: path,
        p_mime_type: file.type,
        p_file_size_bytes: file.size,
        p_payment_method_config_id: paymentMethodConfigId,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['public-proof-status', bookingId] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : t('publicBooking.proofUpload.uploadError')),
  })

  if (proofStatus?.status === 'pending_review') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-status-warning/40 bg-status-warning/5 p-3 text-sm text-status-warning">
        <Clock className="size-4 shrink-0" />
        {t('publicBooking.proofUpload.pendingReview')}
      </div>
    )
  }
  if (proofStatus?.status === 'approved') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-status-success/40 bg-status-success/5 p-3 text-sm text-status-success">
        <CheckCircle2 className="size-4 shrink-0" />
        {t('publicBooking.proofUpload.approved')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {proofStatus?.status === 'rejected' && (
        <div className="flex items-start gap-2 rounded-lg border border-status-danger/40 bg-status-danger/5 p-3 text-sm text-status-danger">
          <XCircle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{t('publicBooking.proofUpload.rejected')}</p>
            {proofStatus.rejection_reason && <p className="text-xs">{proofStatus.rejection_reason}</p>}
            <p className="mt-1 text-xs">{t('publicBooking.proofUpload.rejectedRetry')}</p>
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) uploadMutation.mutate(file)
          e.target.value = ''
        }}
      />
      <Button
        size="sm"
        variant="outline"
        className="w-fit"
        disabled={uploadMutation.isPending}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="me-1 size-4" />
        {uploadMutation.isPending ? t('publicBooking.proofUpload.uploading') : t('publicBooking.proofUpload.uploadButton')}
      </Button>
      {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
    </div>
  )
}
