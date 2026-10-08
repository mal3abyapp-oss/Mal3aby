import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { FileText, Trash2, Upload } from 'lucide-react'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useRentalPermissions } from './hooks'
import type { RentalContractDocument } from './types'

// Lease documents (signed contract scan, tenant ID, check-in / check-out
// photos, receipts) in the private 'rental-documents' bucket at
// <club_id>/<contract_id>/<uuid>.<ext>. Storage policies scope reads to
// rental.view, uploads to rental.contract.create, deletes to
// rental.contract.manage; files open through short-lived signed URLs.

const BUCKET = 'rental-documents'
const DOC_TYPES = ['signed_contract', 'id_document', 'checkin_photo', 'checkout_photo', 'receipt', 'other'] as const
const MAX_BYTES = 10 * 1024 * 1024
const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,image/heic'

export function ContractDocuments({ clubId, contractId }: { clubId: string; contractId: string }) {
  const { t } = useTranslation()
  const { canCreateContracts, canManageContracts } = useRentalPermissions()
  const fileInput = useRef<HTMLInputElement>(null)
  const [docType, setDocType] = useState<(typeof DOC_TYPES)[number]>('signed_contract')
  const [error, setError] = useState<string | null>(null)

  const { data: docs = [], refetch } = useQuery({
    queryKey: ['rental-documents', contractId],
    queryFn: async () => {
      const { data, error: rpcError } = await supabase.rpc('list_rental_contract_documents', { p_contract_id: contractId })
      if (rpcError) throw rpcError
      return (data ?? []) as unknown as RentalContractDocument[]
    },
  })

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_BYTES) throw new Error(t('rentals.documents.tooLarge'))
      const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
      const path = `${clubId}/${contractId}/${crypto.randomUUID()}.${ext}`
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false })
      if (upErr) throw upErr
      const { error: rpcError } = await supabase.rpc('add_rental_contract_document', {
        p_contract_id: contractId,
        p_storage_path: path,
        p_file_name: file.name,
        p_doc_type: docType,
        p_mime_type: file.type || undefined,
        p_size_bytes: file.size,
      })
      if (rpcError) {
        await supabase.storage.from(BUCKET).remove([path])
        throw rpcError
      }
    },
    onSuccess: () => { setError(null); void refetch() },
    onError: (err) => setError(err instanceof Error && !('code' in err) ? err.message : translateSupabaseError(err, t('rentals.documents.uploadError'))),
  })

  const remove = useMutation({
    // File first, then the row: a failed storage delete leaves the
    // document listed (retryable) instead of an orphaned private file.
    mutationFn: async (doc: RentalContractDocument) => {
      const { error: storageError } = await supabase.storage.from(BUCKET).remove([doc.storage_path])
      if (storageError) throw storageError
      const { error: rpcError } = await supabase.rpc('delete_rental_contract_document', { p_document_id: doc.id })
      if (rpcError) throw rpcError
    },
    onSuccess: () => { setError(null); void refetch() },
    onError: (err) => setError(translateSupabaseError(err, t('rentals.documents.deleteError'))),
  })

  async function open(doc: RentalContractDocument) {
    const { data, error: urlError } = await supabase.storage.from(BUCKET).createSignedUrl(doc.storage_path, 300)
    if (urlError || !data?.signedUrl) {
      setError(t('rentals.documents.openError'))
      return
    }
    window.open(data.signedUrl, '_blank', 'noopener')
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-2 font-medium">{t('rentals.documents.title')}</p>
      {docs.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('rentals.documents.empty')}</p>
      ) : (
        <ul className="mb-2 flex flex-col divide-y divide-border-subtle text-sm">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 py-1.5">
              <button type="button" className="flex min-w-0 items-center gap-2 text-start hover:underline" onClick={() => void open(d)}>
                <FileText className="size-4 shrink-0" />
                <span className="truncate">{d.file_name}</span>
                <span className="shrink-0 text-xs text-text-secondary">· {t(`rentals.documents.types.${d.doc_type}`)}</span>
              </button>
              {canManageContracts && (
                <Button size="sm" variant="ghost" aria-label={t('rentals.documents.delete')} disabled={remove.isPending}
                  onClick={() => { if (window.confirm(t('rentals.documents.confirmDelete'))) remove.mutate(d) }}>
                  <Trash2 className="size-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canCreateContracts && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={docType} onValueChange={(v) => setDocType(v as (typeof DOC_TYPES)[number])}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DOC_TYPES.map((k) => <SelectItem key={k} value={k}>{t(`rentals.documents.types.${k}`)}</SelectItem>)}
            </SelectContent>
          </Select>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) upload.mutate(file)
            }}
          />
          <Button size="sm" variant="outline" disabled={upload.isPending} onClick={() => fileInput.current?.click()}>
            <Upload />{upload.isPending ? t('rentals.documents.uploading') : t('rentals.documents.upload')}
          </Button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-status-danger">{error}</p>}
    </div>
  )
}
