import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Inbox } from 'lucide-react'
import { addHoursToTime } from '@/lib/domain/rental'
import { useBookingRequests, useInvalidateRentals, useRentalPermissions } from './hooks'
import { ContractDetailDialog } from './ContractDetailDialog'

// Online hall booking requests sent from the customer portal. Staff
// approve (creates the hourly booking + its invoice through the normal
// contract path, overlap-checked again at that moment) or reject with a
// note the customer sees in the portal.

const STATUS_TONE = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' } as const

export function BookingRequestsSection() {
  const { t } = useTranslation()
  const { canCreateContracts } = useRentalPermissions()
  const invalidate = useInvalidateRentals()
  const [status, setStatus] = useState('pending')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [openContract, setOpenContract] = useState<string | null>(null)
  const { data: requests = [], isLoading, isError, error: loadError, refetch } = useBookingRequests(status)

  const decide = useMutation({
    mutationFn: async ({ id, approve }: { id: string; approve: boolean }) => {
      const { data, error: rpcError } = await supabase.rpc('decide_rental_booking_request', {
        p_request_id: id,
        p_approve: approve,
        p_note: notes[id]?.trim() || undefined,
      })
      if (rpcError) throw rpcError
      return data as string | null
    },
    onSuccess: (contractId) => {
      setError(null)
      void refetch()
      invalidate()
      if (contractId) setOpenContract(contractId)
    },
    onError: (err) => setError(translateSupabaseError(err, t('rentals.requests.decideError'))),
  })

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">{t('rentals.requests.description')}</p>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(['pending', 'approved', 'rejected', 'cancelled', 'all'] as const).map((s) => (
              <SelectItem key={s} value={s}>{t(`rentals.requests.status.${s}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      {isLoading && <Skeleton className="h-24 w-full" />}
      {isError && <ErrorState message={translateSupabaseError(loadError, t('rentals.requests.loadError'))} onRetry={() => void refetch()} />}
      {!isLoading && !isError && requests.length === 0 && (
        <EmptyState icon={Inbox} title={t('rentals.requests.empty')} description={t('rentals.requests.emptyHint')} />
      )}

      <ul className="flex flex-col gap-3">
        {requests.map((r) => {
          const total = Number(r.hourly_rate ?? 0) * r.hours
          return (
            <li key={r.id} className="rounded-lg border border-border p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{r.customer_name} <span className="text-text-secondary"><bdi>{r.customer_mobile ?? ''}</bdi></span></p>
                  <p className="tabular-nums">
                    {r.space_name} · <bdi>{r.booking_date} {r.start_time.slice(0, 5)}–{addHoursToTime(r.start_time.slice(0, 5), r.hours) ?? '24:00'}</bdi>
                    {' '}· {t('rentals.contracts.hoursValue', { count: r.hours })}
                  </p>
                  {r.notes && <p className="text-xs text-text-secondary">{r.notes}</p>}
                  {r.decision_note && <p className="text-xs text-text-secondary">{t('rentals.requests.decisionNote')}: {r.decision_note}</p>}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusBadge tone={STATUS_TONE[r.status]} label={t(`rentals.requests.status.${r.status}`)} />
                  <MoneyDisplay amount={total} size="sm" />
                </div>
              </div>
              {r.status === 'pending' && r.conflict && (
                <p className="mt-2 text-xs text-status-danger">{t('rentals.requests.conflict')}</p>
              )}
              {r.status === 'pending' && canCreateContracts && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Input
                    className="max-w-xs"
                    placeholder={t('rentals.requests.notePlaceholder')}
                    value={notes[r.id] ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                  />
                  <Button size="sm" disabled={decide.isPending || r.conflict} onClick={() => decide.mutate({ id: r.id, approve: true })}>
                    {t('rentals.requests.approve')}
                  </Button>
                  <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, approve: false })}>
                    {t('rentals.requests.reject')}
                  </Button>
                </div>
              )}
              {r.contract_id && (
                <button type="button" className="mt-2 text-xs text-accent-foreground hover:underline" onClick={() => setOpenContract(r.contract_id)}>
                  {t('rentals.requests.openBooking')}
                </button>
              )}
            </li>
          )
        })}
      </ul>

      {openContract && <ContractDetailDialog contractId={openContract} onClose={() => setOpenContract(null)} onChanged={invalidate} />}
    </div>
  )
}
