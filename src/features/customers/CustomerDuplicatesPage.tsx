import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import { translateSupabaseError } from '@/lib/errors'

// Customer 360 directive section on "Duplicate detection + review
// workflow": consistent dedupe UX + a duplicate-groups report + NO
// auto-merge. quarantine_duplicate_customer/unquarantine_customer
// already existed (used for the one real historical Ali/Aliiii
// cleanup) but had no discoverable UI -- staff could only quarantine a
// duplicate if they already knew its id. This page is purely a report
// + the two existing, already-audited quarantine actions; it never
// reassigns bookings/invoices/payments/players/consent between
// customer ids, matching the directive's explicit "no automatic
// merge" requirement for this phase.

interface DuplicateMember {
  id: string
  full_name: string
  mobile_display: string | null
  duplicate_review_status: string
  created_at: string
  bookings_count: number
  players_count: number
  has_invoices: boolean
}

interface DuplicateGroup {
  phone_e164: string
  customers: DuplicateMember[]
}

interface EmailDuplicateGroup {
  email: string
  customers: DuplicateMember[]
}

async function fetchDuplicateGroups(clubId: string) {
  const { data, error } = await supabase.rpc('get_customer_duplicate_groups', { p_club_id: clubId })
  if (error) throw error
  return data as unknown as { groups: DuplicateGroup[]; email_groups?: EmailDuplicateGroup[] }
}

export function CustomerDuplicatesPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['customer-duplicate-groups', currentClubId],
    queryFn: () => fetchDuplicateGroups(currentClubId!),
    enabled: !!currentClubId,
  })
  const groups = data?.groups
  const emailGroups = data?.email_groups

  const quarantineMutation = useMutation({
    mutationFn: async ({ customerId, quarantine }: { customerId: string; quarantine: boolean }) => {
      const rpc = quarantine ? 'quarantine_duplicate_customer' : 'unquarantine_customer'
      const { error } = await supabase.rpc(rpc, { p_club_id: currentClubId!, p_customer_id: customerId })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['customer-duplicate-groups', currentClubId] })
    },
  })

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('customers.duplicates.title', { defaultValue: 'Possible duplicate customers' })}
        description={t('customers.duplicates.description', { defaultValue: 'Customers in this club sharing the same phone number. Review each group and quarantine duplicates — this never deletes or merges data.' })}
      />

      {isLoading ? (
        <p className="text-sm text-text-secondary">{t('common.loading', { defaultValue: 'Loading...' })}</p>
      ) : (!groups || groups.length === 0) && (!emailGroups || emailGroups.length === 0) ? (
        <p className="text-sm text-text-secondary">{t('customers.duplicates.empty', { defaultValue: 'No duplicate phone numbers found.' })}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups?.map((group) => (
            <div key={`phone-${group.phone_e164}`} className="rounded-lg border border-border p-4">
              <p className="mb-3 text-sm font-medium text-text-secondary tabular-nums"><bdi>{group.phone_e164}</bdi></p>
              <DuplicateMemberList members={group.customers} quarantineMutation={quarantineMutation} t={t} />
              {quarantineMutation.isError && (
                <p role="alert" className="mt-2 text-sm text-status-danger">{translateSupabaseError(quarantineMutation.error, t('customers.duplicates.actionError', { defaultValue: "Couldn't update this customer." }))}</p>
              )}
            </div>
          ))}
          {emailGroups?.map((group) => (
            <div key={`email-${group.email}`} className="rounded-lg border border-border p-4">
              <div className="mb-3 flex items-center gap-2">
                <p className="text-sm font-medium text-text-secondary"><bdi>{group.email}</bdi></p>
                <StatusBadge tone="warning" label={t('customers.duplicates.emailMatch', { defaultValue: 'Shared email' })} />
              </div>
              <p className="mb-3 text-xs text-text-secondary">
                {t('customers.duplicates.emailGroupHint', { defaultValue: 'These customers share this email address. This is a softer signal than a matching phone number (e.g. family members can share an inbox), so review before quarantining.' })}
              </p>
              <DuplicateMemberList members={group.customers} quarantineMutation={quarantineMutation} t={t} />
              {quarantineMutation.isError && (
                <p role="alert" className="mt-2 text-sm text-status-danger">{translateSupabaseError(quarantineMutation.error, t('customers.duplicates.actionError', { defaultValue: "Couldn't update this customer." }))}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DuplicateMemberList({
  members,
  quarantineMutation,
  t,
}: {
  members: DuplicateMember[]
  quarantineMutation: ReturnType<typeof useMutation<void, unknown, { customerId: string; quarantine: boolean }>>
  t: ReturnType<typeof useTranslation>['t']
}) {
  return (
    <div className="flex flex-col gap-2">
      {members.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Link to={`/app/customers/${c.id}`} className="font-medium text-accent-foreground hover:underline">{c.full_name}</Link>
              <StatusBadge
                tone={c.duplicate_review_status === 'quarantined_pending_review' ? 'warning' : 'success'}
                label={c.duplicate_review_status === 'quarantined_pending_review'
                  ? t('customers.duplicates.quarantined', { defaultValue: 'Quarantined' })
                  : t('customers.duplicates.canonical', { defaultValue: 'Canonical' })}
              />
            </div>
            <p className="text-xs text-text-secondary">
              {t('customers.duplicates.activitySummary', {
                defaultValue: '{{bookings}} bookings · {{players}} players · {{invoices}}',
                bookings: c.bookings_count,
                players: c.players_count,
                invoices: c.has_invoices ? t('customers.duplicates.hasInvoices', { defaultValue: 'has invoices' }) : t('customers.duplicates.noInvoices', { defaultValue: 'no invoices' }),
              })}
            </p>
          </div>
          {c.duplicate_review_status === 'quarantined_pending_review' ? (
            <Button size="sm" variant="outline" disabled={quarantineMutation.isPending} onClick={() => quarantineMutation.mutate({ customerId: c.id, quarantine: false })}>
              {t('customers.duplicates.unquarantine', { defaultValue: 'Restore as canonical' })}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={quarantineMutation.isPending} onClick={() => quarantineMutation.mutate({ customerId: c.id, quarantine: true })}>
              {t('customers.duplicates.quarantine', { defaultValue: 'Mark as duplicate' })}
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}
