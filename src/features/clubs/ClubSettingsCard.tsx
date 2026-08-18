import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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

// V1 Implementation Gap Audit (2026-08-16), narrowed in the P1-7
// Settings restructure: club identity only (name/currency/timezone +
// read-only status). Branch fields moved out to BranchesCard.tsx, which
// covers the full branch list rather than only the first branch.
const CURRENCIES = ['EGP', 'SAR', 'AED', 'USD']
const TIMEZONES = ['Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai']

interface ClubSettings {
  id: string
  name: string
  nameAr: string
  nameEn: string | null
  currency: string
  timezone: string
  status: string
}

async function fetchClub(clubId: string): Promise<ClubSettings> {
  const { data, error } = await supabase.from('clubs').select('id, name, name_ar, name_en, currency, timezone, status').eq('id', clubId).single()
  if (error) throw error
  return { id: data.id, name: data.name, nameAr: data.name_ar, nameEn: data.name_en, currency: data.currency, timezone: data.timezone, status: data.status }
}

export function ClubSettingsCard() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()

  const { data: club } = useQuery({ queryKey: ['club-settings', currentClubId], queryFn: () => fetchClub(currentClubId!), enabled: !!currentClubId })

  const [nameAr, setNameAr] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [currency, setCurrency] = useState('EGP')
  const [timezone, setTimezone] = useState('Africa/Cairo')
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (club) {
      setNameAr(club.nameAr)
      setNameEn(club.nameEn ?? '')
      setCurrency(club.currency)
      setTimezone(club.timezone)
    }
  }, [club])

  const saveClubMutation = useMutation({
    mutationFn: async () => {
      if (!currentClubId) throw new Error('no club')
      const { error } = await supabase
        .from('clubs')
        .update({ name_ar: nameAr, name_en: nameEn || null, currency, timezone })
        .eq('id', currentClubId)
      if (error) throw error
    },
    onSuccess: () => {
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['club-settings', currentClubId] })
    },
    onError: (error) => setFormError(translateSupabaseError(error, t('clubs.clubSettingsCard.saveError'))),
  })

  if (!club) return null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t('clubs.clubSettingsCard.title')}</CardTitle>
        <StatusBadge tone={club.status === 'active' ? 'success' : 'danger'} label={t(`clubs.clubSettingsCard.statusLabels.${club.status}`, { defaultValue: club.status })} />
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('clubs.clubSettingsCard.nameArLabel')}</label>
          <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('clubs.clubSettingsCard.nameEnLabel')}</label>
          <Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('clubs.clubSettingsCard.currencyLabel')}</label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('clubs.clubSettingsCard.timezoneLabel')}</label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        {formError && <p role="alert" className="text-sm text-status-danger">{formError}</p>}
        <Button size="sm" className="w-fit" disabled={!nameAr.trim() || saveClubMutation.isPending} onClick={() => saveClubMutation.mutate()}>
          {saveClubMutation.isPending ? t('clubs.clubSettingsCard.saving') : t('clubs.clubSettingsCard.save')}
        </Button>
        <p className="text-xs text-text-secondary">{t('clubs.clubSettingsCard.statusHint')}</p>
      </CardContent>
    </Card>
  )
}
