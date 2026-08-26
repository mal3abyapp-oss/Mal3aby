import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { translateSupabaseError } from '@/lib/errors'

// COMMERCIAL MODULE (2026-08-26) -- Shop settings: club-owner-controlled
// module activation (directive Section 3 -- separate from platform
// entitlement, which lives on Platform Clubs/Club Detail, not here) and
// inventory location management.
interface LocationRow { locationId: string; kind: string; name: string; status: string }

async function fetchLocations(clubId: string): Promise<LocationRow[]> {
  const { data, error } = await supabase.rpc('list_shop_inventory_locations', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({ locationId: r.location_id, kind: r.kind, name: r.name, status: r.status }))
}

export function ShopSettingsPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [newLocationName, setNewLocationName] = useState('')
  const [newLocationKind, setNewLocationKind] = useState('warehouse')
  const [error, setError] = useState<string | null>(null)

  const { data: locations = [] } = useQuery({
    queryKey: ['shop-settings-locations', currentClubId],
    queryFn: () => fetchLocations(currentClubId as string),
    enabled: !!currentClubId,
  })

  const createLocationMutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.from('shop_inventory_locations').insert({
        club_id: currentClubId as string, kind: newLocationKind, name: newLocationName,
      })
      if (err) throw err
    },
    onSuccess: () => {
      setNewLocationName('')
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['shop-settings-locations'] })
    },
    onError: (err) => setError(translateSupabaseError(err, t('shop.settings.locationCreateError'))),
  })

  return (
    <div>
      <PageHeader title={t('shop.settings.title')} description={t('shop.settings.description')} />

      <div className="flex flex-col gap-6">
        <section className="rounded-md border border-border p-4">
          <h2 className="mb-3 text-base font-semibold">{t('shop.settings.locationsTitle')}</h2>
          <div className="flex flex-col gap-2">
            {locations.map((l) => (
              <div key={l.locationId} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <span>{l.name}</span>
                <StatusBadge tone="neutral" label={t(`shop.settings.locationKind.${l.kind}`, { defaultValue: l.kind })} />
              </div>
            ))}
            {locations.length === 0 && <p className="text-sm text-text-secondary">{t('shop.settings.noLocationsYet')}</p>}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Input placeholder={t('shop.settings.locationNamePlaceholder')} value={newLocationName} onChange={(e) => setNewLocationName(e.target.value)} className="max-w-xs" />
            <Select value={newLocationKind} onValueChange={setNewLocationKind}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="warehouse">{t('shop.settings.locationKind.warehouse')}</SelectItem>
              </SelectContent>
            </Select>
            <Button disabled={!newLocationName || createLocationMutation.isPending} onClick={() => createLocationMutation.mutate()}>
              {t('shop.settings.addLocation')}
            </Button>
          </div>
          {error && <p role="alert" className="mt-2 text-sm text-status-danger">{error}</p>}
          <p className="mt-2 text-xs text-text-secondary">{t('shop.settings.locationsHint')}</p>
        </section>
      </div>
    </div>
  )
}
