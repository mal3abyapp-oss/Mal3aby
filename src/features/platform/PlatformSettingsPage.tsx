import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

// IA restructuring (Phase 4): this was a permanent placeholder
// ("لا توجد إعدادات على مستوى المنصة... غير مُتاحة كشاشة مستقلة في هذا
// الإصدار") even though its own note named exactly what belongs here --
// platform_settings.default_trial_days / default_grace_period_days.
// Confirmed live: the table exists, is writable by platform_owner via
// RLS (platform_settings_platform_owner_write), and until now the only
// way to change the grace-period default was the hardcoded "تمديد فترة
// السماح (14 يوم)" button on PlatformClubDetailPage -- a PER-SUBSCRIPTION
// action with a hardcoded day count, not a way to change the platform
// DEFAULT. This screen is that missing global-default control.

interface PlatformSettingsRow {
  default_trial_days: number
  default_grace_period_days: number
}

async function fetchSettings(): Promise<PlatformSettingsRow> {
  const { data, error } = await supabase
    .from('platform_settings')
    .select('default_trial_days, default_grace_period_days')
    .single()
  if (error) throw error
  return data
}

async function updateSettings(values: PlatformSettingsRow) {
  const { error } = await supabase
    .from('platform_settings')
    .update({ default_trial_days: values.default_trial_days, default_grace_period_days: values.default_grace_period_days, updated_at: new Date().toISOString() })
    .eq('id', true)
  if (error) throw error
}

export function PlatformSettingsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['platform-settings'], queryFn: fetchSettings })
  const [trialDays, setTrialDays] = useState<string>('')
  const [graceDays, setGraceDays] = useState<string>('')
  const [saved, setSaved] = useState(false)

  const effectiveTrialDays = trialDays || String(data?.default_trial_days ?? '')
  const effectiveGraceDays = graceDays || String(data?.default_grace_period_days ?? '')

  const mutation = useMutation({
    mutationFn: () =>
      updateSettings({
        default_trial_days: Number(effectiveTrialDays),
        default_grace_period_days: Number(effectiveGraceDays),
      }),
    onSuccess: () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      void queryClient.invalidateQueries({ queryKey: ['platform-settings'] })
    },
  })

  return (
    <div>
      <PageHeader title={t('platform.settingsPage.title')} description={t('platform.settingsPage.description')} />

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">{t('platform.settingsPage.cardTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <p className="text-sm text-text-secondary">{t('platform.settingsPage.loading')}</p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="trial-days" className="text-sm font-medium text-text-secondary">{t('platform.settingsPage.trialDaysLabel')}</label>
                <Input
                  id="trial-days"
                  type="number"
                  min={1}
                  value={effectiveTrialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                />
                <p className="text-xs text-text-secondary">
                  {t('platform.settingsPage.trialDaysHint')}
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="grace-days" className="text-sm font-medium text-text-secondary">{t('platform.settingsPage.graceDaysLabel')}</label>
                <Input
                  id="grace-days"
                  type="number"
                  min={0}
                  value={effectiveGraceDays}
                  onChange={(e) => setGraceDays(e.target.value)}
                />
                <p className="text-xs text-text-secondary">
                  {t('platform.settingsPage.graceDaysHint')}
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  disabled={mutation.isPending || (!trialDays && !graceDays)}
                  onClick={() => mutation.mutate()}
                >
                  {mutation.isPending ? t('platform.settingsPage.saving') : t('platform.settingsPage.save')}
                </Button>
                {saved && <span className="text-sm text-status-success">{t('platform.settingsPage.saved')}</span>}
                {mutation.isError && <span className="text-sm text-status-danger">{t('platform.settingsPage.saveError')}</span>}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
