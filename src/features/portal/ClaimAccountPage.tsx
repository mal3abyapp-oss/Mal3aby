import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { translateSupabaseError } from '@/lib/errors'

// Gate 3 — self-service account linking. A person may already have a
// staff-created customer record (from booking a field or enrolling a
// child in person) before they ever create a login. This screen lets
// them find and claim that exact record explicitly -- never a silent
// auto-match by phone/email, which would let anyone claim a stranger's
// financial history just by knowing their phone number. The match is
// shown to the user for confirmation before claiming (see
// claim_customer_self_service()'s own doc comment in the migration).

interface ClubOption {
  id: string
  name_ar: string
}

interface MatchResult {
  id: string
  full_name: string
  mobile_display: string | null
  club_id: string
}

async function fetchClubs(): Promise<ClubOption[]> {
  const { data, error } = await supabase.from('clubs').select('id, name_ar').order('name_ar')
  if (error) throw error
  return data ?? []
}

export function ClaimAccountPage({ onClaimed }: { onClaimed: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [clubId, setClubId] = useState('')
  const [mobile, setMobile] = useState('')
  const [matches, setMatches] = useState<MatchResult[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [claimError, setClaimError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  const { data: clubs = [] } = useQuery({ queryKey: ['portal-clubs'], queryFn: fetchClubs })

  // Search only ever returns rows the caller could see via staff RLS if
  // they had permission -- but they don't, so this relies on a narrow,
  // dedicated lookup RPC-free path: we search by exact normalized
  // mobile within the chosen club, which PostgREST still blocks unless
  // a policy allows it. Real lookup happens through the club's own
  // reception staff in practice; this screen instead asks the person to
  // enter the mobile number staff has on file so they see only the
  // masked confirmation, never a browsable list. Search is implemented
  // via a minimal SECURITY DEFINER RPC-free approach: attempt the claim
  // directly and let the RPC's own not-found error guide the user,
  // rather than exposing a searchable customers endpoint to anon/authenticated.
  async function handleSearch() {
    setSearchError(null)
    setMatches(null)
    if (!clubId || !mobile.trim()) {
      setSearchError(t('portal.claimAccountPage.missingFieldsError'))
      return
    }
    setSearching(true)
    const normalized = mobile.replace(/\D/g, '').replace(/^0+/, '')
    // find_claimable_customer is a narrow SECURITY DEFINER RPC (added
    // alongside this screen) that returns only a minimal confirmation
    // shape (name + masked mobile) for an UNCLAIMED customer matching
    // this exact club + normalized mobile -- never a searchable list,
    // never any financial/contact detail beyond what confirms identity.
    const { data, error } = await supabase.rpc('find_claimable_customer', {
      p_club_id: clubId,
      p_normalized_mobile: normalized,
    })
    setSearching(false)
    if (error) {
      setSearchError(translateSupabaseError(error, t('portal.claimAccountPage.searchGenericError')))
      return
    }
    setMatches(data ?? [])
    if (!data || data.length === 0) {
      setSearchError(t('portal.claimAccountPage.noMatchError'))
    }
  }

  const claimMutation = useMutation({
    mutationFn: async (customerId: string) => {
      // SECURITY FIX (2026-08-31): claim_customer_self_service() now
      // re-verifies the same phone corroboration find_claimable_customer
      // already checked, independently of this UI's own lookup step --
      // closes a live-confirmed account-takeover gap where the claim RPC
      // trusted any caller-supplied p_customer_id with no verification of
      // its own. Recompute the same normalization handleSearch() uses,
      // since the raw mobile input (not the normalized form) is what's
      // held in component state.
      const normalized = mobile.replace(/\D/g, '').replace(/^0+/, '')
      const { error } = await supabase.rpc('claim_customer_self_service', {
        p_club_id: clubId,
        p_customer_id: customerId,
        p_normalized_mobile: normalized,
      })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portal'] })
      onClaimed()
    },
    onError: (error) => setClaimError(translateSupabaseError(error, t('portal.claimAccountPage.claimGenericError'))),
  })

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center gap-4 px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle className="text-center text-lg">{t('portal.claimAccountPage.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-center text-sm text-text-secondary">
            {t('portal.claimAccountPage.description')}
          </p>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('portal.claimAccountPage.clubLabel')}</label>
            <select
              className="h-10 rounded-md border border-border bg-background px-3 text-sm"
              value={clubId}
              onChange={(e) => {
                setClubId(e.target.value)
                setMatches(null)
                setSearchError(null)
              }}
            >
              <option value="">{t('portal.claimAccountPage.clubPlaceholder')}</option>
              {clubs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_ar}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('portal.claimAccountPage.mobileLabel')}</label>
            <Input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder={t('portal.claimAccountPage.mobilePlaceholder')} />
          </div>

          {searchError && <p className="text-sm text-status-danger">{searchError}</p>}

          <Button onClick={handleSearch} disabled={searching}>
            {searching ? t('portal.claimAccountPage.searching') : t('portal.claimAccountPage.search')}
          </Button>

          {matches && matches.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <p className="text-sm text-text-secondary">{t('portal.claimAccountPage.isThisYou')}</p>
              {matches.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-2 rounded-md bg-muted/30 p-2">
                  <div>
                    <p className="font-medium">{m.full_name}</p>
                    {/* QA acceptance fix (2026-08-31): same RTL bidi bug class as
                        PortalProfilePage.tsx's WhatsApp field -- mobile_display can
                        carry a leading '+' (E164 display), which reverses under this
                        page's default RTL context without an explicit direction. */}
                    <p dir="ltr" className="text-xs text-text-secondary tabular-nums">{m.mobile_display}</p>
                  </div>
                  <Button size="sm" onClick={() => claimMutation.mutate(m.id)} disabled={claimMutation.isPending}>
                    {claimMutation.isPending ? t('portal.claimAccountPage.claiming') : t('portal.claimAccountPage.confirmClaim')}
                  </Button>
                </div>
              ))}
              {claimError && <p className="text-sm text-status-danger">{claimError}</p>}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
