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
// platform_settings.default_trial_days. Confirmed live: the table exists,
// is writable by platform_owner via RLS (platform_settings_platform_owner_write).
//
// Platform Owner Phase A directive (dead setting fix): this screen used to
// also expose default_grace_period_days. Live audit + full migration grep
// proved no subscription logic ever read that column -- trials always
// hardcode grace=0 (correct: trials shouldn't have grace), and paid/
// complimentary subscriptions always use platform_plans.default_grace_period_days
// (the PER-PLAN value, set on each Plan in /platform/plans). Editing the
// old global field here was silently a no-op. Rather than wire it into new
// logic with no product justification, the column was dropped in migration
// 20260819100000 and the field removed from this screen -- grace period is
// managed per-plan only, which is the architecture that was already
// correct and already in use everywhere else.
interface PlatformSettingsRow {
  default_trial_days: number
}

async function fetchSettings(): Promise<PlatformSettingsRow> {
  const { data, error } = await supabase
    .from('platform_settings')
    .select('default_trial_days')
    .single()
  if (error) throw error
  return data
}

async function updateSettings(values: PlatformSettingsRow) {
  // Phase A directive (A5/H5): platform setting changes must be audited.
  // This used to be a bare table .update() with zero trace of who changed
  // the trial-days default or from what to what -- now routed through a
  // dedicated RPC (write_audit_log itself is intentionally internal-only,
  // not directly callable from the client) that is_platform_owner()-gates
  // and audit-logs the change, matching every other platform write.
  const { error } = await supabase.rpc('update_platform_settings', {
    p_default_trial_days: values.default_trial_days,
  })
  if (error) throw error
}

export function PlatformSettingsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['platform-settings'], queryFn: fetchSettings })
  const [trialDays, setTrialDays] = useState<string>('')
  const [saved, setSaved] = useState(false)

  const effectiveTrialDays = trialDays || String(data?.default_trial_days ?? '')

  const mutation = useMutation({
    mutationFn: () =>
      updateSettings({
        default_trial_days: Number(effectiveTrialDays),
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

              <p className="text-xs text-text-secondary">
                {t('platform.settingsPage.graceMovedHint')}
              </p>

              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  disabled={mutation.isPending || !trialDays}
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
