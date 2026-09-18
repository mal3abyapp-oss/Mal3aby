import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translateSupabaseError } from '@/lib/errors'

// Ban-protection hardening (2026-09-12): the Platform WhatsApp domain's
// counterpart to MessagingSafetyCard.tsx (tenant domain). The
// underlying table (platform_whatsapp_safety_settings) already existed
// with sane defaults since PR #28 -- this is the first owner-facing
// control surface for it, closing the gap the independent review
// flagged ("Platform Owner cannot tune platform_whatsapp_safety_settings
// from the UI, unlike the tenant side").
//
// Same "never claim ban-proof" discipline as MessagingSafetyCard.tsx's
// own Part W comment -- every label here says "delivery controls" /
// "ban-protection settings" as a volume/pacing control, never a
// guarantee.

interface PlatformSafetySettings {
  maxSendsPerMinute: number
  maxSendsPerHour: number
  maxSendsPerDay: number
  minMinutesBetweenRecipientSends: number
  maxSendsPerDayPerRecipient: number
  circuitBreakerEnabled: boolean
  warmUpEnabled: boolean
  warmUpDays: number
}

async function fetchSafetySettings(): Promise<PlatformSafetySettings> {
  const { data, error } = await supabase.rpc('get_platform_whatsapp_safety_settings')
  if (error) throw error
  const row = data as unknown as {
    max_sends_per_minute: number
    max_sends_per_hour: number
    max_sends_per_day: number
    min_minutes_between_recipient_sends: number
    max_sends_per_day_per_recipient: number
    circuit_breaker_enabled: boolean
    warm_up_enabled: boolean
    warm_up_days: number
  } | null
  return {
    maxSendsPerMinute: row?.max_sends_per_minute ?? 3,
    maxSendsPerHour: row?.max_sends_per_hour ?? 30,
    maxSendsPerDay: row?.max_sends_per_day ?? 100,
    minMinutesBetweenRecipientSends: row?.min_minutes_between_recipient_sends ?? 60,
    maxSendsPerDayPerRecipient: row?.max_sends_per_day_per_recipient ?? 1,
    circuitBreakerEnabled: row?.circuit_breaker_enabled ?? true,
    warmUpEnabled: row?.warm_up_enabled ?? true,
    warmUpDays: row?.warm_up_days ?? 7,
  }
}

export function PlatformWhatsAppSafetyCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [formError, setFormError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<PlatformSafetySettings>>({})

  const { data: settings, isLoading } = useQuery({
    queryKey: ['platform-whatsapp-safety-settings'],
    queryFn: fetchSafetySettings,
  })

  const effective = settings ? { ...settings, ...draft } : undefined

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!effective) return
      const { error } = await supabase.rpc('update_platform_whatsapp_safety_settings', {
        p_max_sends_per_minute: effective.maxSendsPerMinute,
        p_max_sends_per_hour: effective.maxSendsPerHour,
        p_max_sends_per_day: effective.maxSendsPerDay,
        p_min_minutes_between_recipient_sends: effective.minMinutesBetweenRecipientSends,
        p_max_sends_per_day_per_recipient: effective.maxSendsPerDayPerRecipient,
        p_circuit_breaker_enabled: effective.circuitBreakerEnabled,
        p_warm_up_enabled: effective.warmUpEnabled,
        p_warm_up_days: effective.warmUpDays,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setFormError(null)
      setDraft({})
      queryClient.invalidateQueries({ queryKey: ['platform-whatsapp-safety-settings'] })
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, t('platform.safetyCard.saveError'))),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('platform.safetyCard.title')}</CardTitle>
        <p className="text-xs text-text-secondary">{t('platform.safetyCard.description')}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading && <p className="text-sm text-text-secondary">{t('platform.safetyCard.loading')}</p>}
        {formError && <p role="alert" className="text-sm text-status-danger">{formError}</p>}

        {effective && (
          <>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('platform.safetyCard.rateLimitHeading')}</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="platform-safety-max-per-minute" className="text-xs text-text-secondary">
                    {t('platform.safetyCard.maxPerMinuteLabel')}
                  </label>
                  <Input
                    id="platform-safety-max-per-minute"
                    type="number"
                    min={1}
                    value={effective.maxSendsPerMinute}
                    onChange={(e) => setDraft((d) => ({ ...d, maxSendsPerMinute: Number(e.target.value) }))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="platform-safety-max-per-hour" className="text-xs text-text-secondary">
                    {t('platform.safetyCard.maxPerHourLabel')}
                  </label>
                  <Input
                    id="platform-safety-max-per-hour"
                    type="number"
                    min={1}
                    value={effective.maxSendsPerHour}
                    onChange={(e) => setDraft((d) => ({ ...d, maxSendsPerHour: Number(e.target.value) }))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="platform-safety-max-per-day" className="text-xs text-text-secondary">
                    {t('platform.safetyCard.maxPerDayLabel')}
                  </label>
                  <Input
                    id="platform-safety-max-per-day"
                    type="number"
                    min={1}
                    value={effective.maxSendsPerDay}
                    onChange={(e) => setDraft((d) => ({ ...d, maxSendsPerDay: Number(e.target.value) }))}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="platform-safety-min-minutes" className="text-xs text-text-secondary">
                    {t('platform.safetyCard.minMinutesBetweenSendsLabel')}
                  </label>
                  <Input
                    id="platform-safety-min-minutes"
                    type="number"
                    min={0}
                    value={effective.minMinutesBetweenRecipientSends}
                    onChange={(e) => setDraft((d) => ({ ...d, minMinutesBetweenRecipientSends: Number(e.target.value) }))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="platform-safety-max-per-day-per-recipient" className="text-xs text-text-secondary">
                    {t('platform.safetyCard.maxPerDayPerRecipientLabel')}
                  </label>
                  <Input
                    id="platform-safety-max-per-day-per-recipient"
                    type="number"
                    min={1}
                    value={effective.maxSendsPerDayPerRecipient}
                    onChange={(e) => setDraft((d) => ({ ...d, maxSendsPerDayPerRecipient: Number(e.target.value) }))}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={effective.circuitBreakerEnabled}
                  onChange={(e) => setDraft((d) => ({ ...d, circuitBreakerEnabled: e.target.checked }))}
                  className="size-4"
                />
                {t('platform.safetyCard.circuitBreakerLabel')}
              </label>
            </div>

            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-medium">{t('platform.safetyCard.warmUpHeading')}</h3>
              <p className="text-xs text-text-secondary">{t('platform.safetyCard.warmUpHint')}</p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={effective.warmUpEnabled}
                  onChange={(e) => setDraft((d) => ({ ...d, warmUpEnabled: e.target.checked }))}
                  className="size-4"
                />
                {t('platform.safetyCard.warmUpEnabledLabel')}
              </label>
              {effective.warmUpEnabled && (
                <div className="flex flex-col gap-1">
                  <label htmlFor="platform-safety-warmup-days" className="text-xs text-text-secondary">
                    {t('platform.safetyCard.warmUpDaysLabel')}
                  </label>
                  <Input
                    id="platform-safety-warmup-days"
                    type="number"
                    min={0}
                    value={effective.warmUpDays}
                    onChange={(e) => setDraft((d) => ({ ...d, warmUpDays: Number(e.target.value) }))}
                  />
                </div>
              )}
            </div>

            <Button
              size="sm"
              className="self-start"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || Object.keys(draft).length === 0}
            >
              {t('platform.safetyCard.saveButton')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
