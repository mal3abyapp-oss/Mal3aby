import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translateSupabaseError } from '@/lib/errors'

// Safe Messaging / Anti-Abuse Control Layer -- Part S (admin safety
// settings) and Part T (diagnostics), combined in one card since both
// live under Settings -> الإشعارات and share the same data (a club's
// messaging_safety_settings row + the whatsapp_queue_diagnostics view).
//
// Part W: this UI must never claim "ban-proof" or a guaranteed-safe
// send volume -- every label here says "delivery controls" /
// "messaging safety", never "anti-ban", and no number is presented as
// a guarantee.

interface CategorySetting {
  category: string
  enabled: boolean
}

const CATEGORY_ORDER = [
  'booking_confirmations',
  'booking_reminders',
  'payment_confirmations',
  'refund_notifications',
  'academy_notifications',
  'subscription_reminders',
]

interface SafetySettings {
  whatsappNotificationsEnabled: boolean
  quietHoursEnabled: boolean
  quietHoursStart: string
  quietHoursEnd: string
  quietHoursBypassCritical: boolean
  maxSendsPerMinute: number
  maxSendsPerHour: number
  minMinutesBetweenRecipientSends: number
  circuitBreakerEnabled: boolean
  defaultLanguage: 'ar' | 'en'
}

interface Diagnostics {
  pendingCount: number
  retryingCount: number
  expiredCount: number
  failedCount: number
  sentCount: number
  oldestPendingCreatedAt: string | null
}

interface AccountHealth {
  status: string
  lastSuccessfulSendAt: string | null
  lastError: string | null
  circuitBreakerOpenUntil: string | null
  circuitBreakerReason: string | null
}

async function fetchCategorySettings(clubId: string): Promise<CategorySetting[]> {
  const { data, error } = await supabase
    .from('notification_category_settings')
    .select('category, enabled')
    .eq('club_id', clubId)
    .eq('channel', 'whatsapp')
  if (error) throw error
  const byCategory = new Map((data ?? []).map((r) => [r.category, r.enabled]))
  // Missing row = enabled by default (existing convention, task #92) --
  // every category the UI offers is shown even if no row exists yet.
  return CATEGORY_ORDER.map((category) => ({
    category,
    enabled: byCategory.get(category) ?? true,
  }))
}

async function fetchSafetySettings(clubId: string): Promise<SafetySettings> {
  const { data, error } = await supabase
    .from('messaging_safety_settings')
    .select(
      'quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_bypass_critical, max_sends_per_minute_per_account, max_sends_per_hour_per_account, min_minutes_between_recipient_sends, circuit_breaker_enabled, default_language',
    )
    .eq('club_id', clubId)
    .maybeSingle()
  if (error) throw error
  return {
    whatsappNotificationsEnabled: true, // no global kill switch column yet -- category toggles are the granular control; see comment below.
    quietHoursEnabled: data?.quiet_hours_enabled ?? true,
    quietHoursStart: data?.quiet_hours_start?.slice(0, 5) ?? '22:00',
    quietHoursEnd: data?.quiet_hours_end?.slice(0, 5) ?? '08:00',
    quietHoursBypassCritical: data?.quiet_hours_bypass_critical ?? true,
    maxSendsPerMinute: data?.max_sends_per_minute_per_account ?? 6,
    maxSendsPerHour: data?.max_sends_per_hour_per_account ?? 120,
    minMinutesBetweenRecipientSends: data?.min_minutes_between_recipient_sends ?? 5,
    circuitBreakerEnabled: data?.circuit_breaker_enabled ?? true,
    defaultLanguage: (data?.default_language as 'ar' | 'en') ?? 'ar',
  }
}

async function fetchDiagnostics(clubId: string): Promise<Diagnostics | null> {
  const { data, error } = await supabase
    .from('whatsapp_queue_diagnostics')
    .select('pending_count, retrying_count, expired_count, failed_count, sent_count, oldest_pending_created_at')
    .eq('club_id', clubId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return {
    pendingCount: data.pending_count ?? 0,
    retryingCount: data.retrying_count ?? 0,
    expiredCount: data.expired_count ?? 0,
    failedCount: data.failed_count ?? 0,
    sentCount: data.sent_count ?? 0,
    oldestPendingCreatedAt: data.oldest_pending_created_at,
  }
}

async function fetchAccountHealth(clubId: string): Promise<AccountHealth | null> {
  const { data, error } = await supabase.rpc('get_whatsapp_status', { p_club_id: clubId })
  if (error) throw error
  const row = data?.[0]
  if (!row) return null
  return {
    status: row.status,
    lastSuccessfulSendAt: row.last_successful_send_at,
    lastError: row.last_error,
    circuitBreakerOpenUntil: row.circuit_breaker_open_until,
    circuitBreakerReason: row.circuit_breaker_reason,
  }
}

// Production audit finding H-1 (RTL-bidi gap): matches the same fix
// applied to WhatsAppActivityTab.tsx's/WhatsAppConnectionCard.tsx's own
// copy of this helper -- FSI/PDI isolation marks, same convention as
// formatMoney()/formatDateIsolated(). Kept as a plain string (not a
// <FormattedDate>) because some call sites here interpolate it into a
// t() string (lastSuccessfulSend), which only accepts a string.
const DATETIME_FSI = '⁦'
const DATETIME_PDI = '⁩'
function formatDateTime(iso: string | null, locale: 'ar' | 'en'): string {
  if (!iso) return '—'
  const formatted = new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG', { dateStyle: 'medium', timeStyle: 'short' })
  return `${DATETIME_FSI}${formatted}${DATETIME_PDI}`
}

export function MessagingSafetyCard() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const CATEGORY_LABELS: Record<string, string> = {
    booking_confirmations: t('whatsapp.categoryLabels.booking_confirmations'),
    booking_reminders: t('whatsapp.categoryLabels.booking_reminders'),
    payment_confirmations: t('whatsapp.categoryLabels.payment_confirmations'),
    refund_notifications: t('whatsapp.categoryLabels.refund_notifications'),
    academy_notifications: t('whatsapp.categoryLabels.academy_notifications'),
    subscription_reminders: t('whatsapp.categoryLabels.subscription_reminders'),
  }
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [formError, setFormError] = useState<string | null>(null)

  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['notification-category-settings', currentClubId],
    queryFn: () => fetchCategorySettings(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['messaging-safety-settings', currentClubId],
    queryFn: () => fetchSafetySettings(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: diagnostics } = useQuery({
    queryKey: ['whatsapp-queue-diagnostics', currentClubId],
    queryFn: () => fetchDiagnostics(currentClubId!),
    enabled: !!currentClubId,
    refetchInterval: 15000,
  })

  const { data: accountHealth } = useQuery({
    queryKey: ['whatsapp-account-health', currentClubId],
    queryFn: () => fetchAccountHealth(currentClubId!),
    enabled: !!currentClubId,
    refetchInterval: 15000,
  })

  const toggleCategoryMutation = useMutation({
    mutationFn: async ({ category, enabled }: { category: string; enabled: boolean }) => {
      const { error } = await supabase.from('notification_category_settings').upsert(
        { club_id: currentClubId!, channel: 'whatsapp', category, enabled: !enabled },
        { onConflict: 'club_id,channel,category' },
      )
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notification-category-settings', currentClubId] }),
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, t('whatsapp.messagingSafetyCard.updateCategoryError'))),
  })

  const [draft, setDraft] = useState<Partial<SafetySettings>>({})
  const effective = { ...settings, ...draft } as SafetySettings | undefined

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!effective) return
      const { error } = await supabase.from('messaging_safety_settings').upsert(
        {
          club_id: currentClubId!,
          quiet_hours_enabled: effective.quietHoursEnabled,
          quiet_hours_start: effective.quietHoursStart,
          quiet_hours_end: effective.quietHoursEnd,
          quiet_hours_bypass_critical: effective.quietHoursBypassCritical,
          max_sends_per_minute_per_account: effective.maxSendsPerMinute,
          max_sends_per_hour_per_account: effective.maxSendsPerHour,
          min_minutes_between_recipient_sends: effective.minMinutesBetweenRecipientSends,
          circuit_breaker_enabled: effective.circuitBreakerEnabled,
          default_language: effective.defaultLanguage,
        },
        { onConflict: 'club_id' },
      )
      if (error) throw error
    },
    onSuccess: () => {
      setFormError(null)
      setDraft({})
      queryClient.invalidateQueries({ queryKey: ['messaging-safety-settings', currentClubId] })
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, t('whatsapp.messagingSafetyCard.saveSettingsError'))),
  })

  const isLoading = categoriesLoading || settingsLoading

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('whatsapp.messagingSafetyCard.title')}</CardTitle>
        <p className="text-xs text-text-secondary">
          {t('whatsapp.messagingSafetyCard.description')}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {isLoading && <p className="text-sm text-text-secondary">{t('whatsapp.messagingSafetyCard.loading')}</p>}
        {formError && <p className="text-sm text-status-danger">{formError}</p>}

        {!isLoading && (
          <>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('whatsapp.messagingSafetyCard.enabledCategoriesHeading')}</h3>
              {categories.map((c) => (
                <label key={c.category} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    onChange={() => toggleCategoryMutation.mutate({ category: c.category, enabled: c.enabled })}
                    className="size-4"
                  />
                  {CATEGORY_LABELS[c.category] ?? c.category}
                </label>
              ))}
              <p className="text-xs text-text-secondary">
                {t('whatsapp.messagingSafetyCard.marketingHint')}
              </p>
            </div>

            {effective && (
              <div className="flex flex-col gap-4 border-t border-border pt-4">
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">{t('whatsapp.messagingSafetyCard.quietHoursHeading')}</h3>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={effective.quietHoursEnabled}
                      onChange={(e) => setDraft((d) => ({ ...d, quietHoursEnabled: e.target.checked }))}
                      className="size-4"
                    />
                    {t('whatsapp.messagingSafetyCard.enableQuietHours')}
                  </label>
                  {effective.quietHoursEnabled && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.quietHoursFrom')}</label>
                        <Input
                          type="time"
                          value={effective.quietHoursStart}
                          onChange={(e) => setDraft((d) => ({ ...d, quietHoursStart: e.target.value }))}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.quietHoursTo')}</label>
                        <Input
                          type="time"
                          value={effective.quietHoursEnd}
                          onChange={(e) => setDraft((d) => ({ ...d, quietHoursEnd: e.target.value }))}
                        />
                      </div>
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={effective.quietHoursBypassCritical}
                      onChange={(e) => setDraft((d) => ({ ...d, quietHoursBypassCritical: e.target.checked }))}
                      className="size-4"
                    />
                    {t('whatsapp.messagingSafetyCard.bypassCriticalLabel')}
                  </label>
                </div>

                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">{t('whatsapp.messagingSafetyCard.rateLimitHeading')}</h3>
                  <p className="text-xs text-text-secondary">
                    {t('whatsapp.messagingSafetyCard.rateLimitHint')}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.maxPerMinuteLabel')}</label>
                      <Input
                        type="number"
                        min={1}
                        value={effective.maxSendsPerMinute}
                        onChange={(e) => setDraft((d) => ({ ...d, maxSendsPerMinute: Number(e.target.value) }))}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.maxPerHourLabel')}</label>
                      <Input
                        type="number"
                        min={1}
                        value={effective.maxSendsPerHour}
                        onChange={(e) => setDraft((d) => ({ ...d, maxSendsPerHour: Number(e.target.value) }))}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.minMinutesBetweenSendsLabel')}</label>
                    <Input
                      type="number"
                      min={0}
                      value={effective.minMinutesBetweenRecipientSends}
                      onChange={(e) => setDraft((d) => ({ ...d, minMinutesBetweenRecipientSends: Number(e.target.value) }))}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={effective.circuitBreakerEnabled}
                      onChange={(e) => setDraft((d) => ({ ...d, circuitBreakerEnabled: e.target.checked }))}
                      className="size-4"
                    />
                    {t('whatsapp.messagingSafetyCard.circuitBreakerLabel')}
                  </label>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.defaultLanguageLabel')}</label>
                  <select
                    value={effective.defaultLanguage}
                    onChange={(e) => setDraft((d) => ({ ...d, defaultLanguage: e.target.value as 'ar' | 'en' }))}
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                  >
                    <option value="ar">{t('language.arabic')}</option>
                    <option value="en">{t('language.english')}</option>
                  </select>
                </div>

                <Button size="sm" className="self-start" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || Object.keys(draft).length === 0}>
                  {t('whatsapp.messagingSafetyCard.saveButton')}
                </Button>
              </div>
            )}

            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-medium">{t('whatsapp.messagingSafetyCard.diagnosticsHeading')}</h3>
              {diagnostics ? (
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                  <div className="rounded-md border border-border p-2">
                    <p className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.pending')}</p>
                    <p className="font-medium">{diagnostics.pendingCount}</p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.retrying')}</p>
                    <p className="font-medium">{diagnostics.retryingCount}</p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.expired')}</p>
                    <p className="font-medium">{diagnostics.expiredCount}</p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.failedFinal')}</p>
                    <p className="font-medium">{diagnostics.failedCount}</p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.sent')}</p>
                    <p className="font-medium">{diagnostics.sentCount}</p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.oldestPending')}</p>
                    <p className="font-medium">{formatDateTime(diagnostics.oldestPendingCreatedAt, locale)}</p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-text-secondary">{t('whatsapp.messagingSafetyCard.diagnosticsEmpty')}</p>
              )}
              {accountHealth?.circuitBreakerOpenUntil && new Date(accountHealth.circuitBreakerOpenUntil) > new Date() && (
                <p className="text-xs text-status-danger">
                  {t('whatsapp.messagingSafetyCard.circuitBreakerActivePrefix')} {formatDateTime(accountHealth.circuitBreakerOpenUntil, locale)}
                  {accountHealth.circuitBreakerReason ? ` -- ${accountHealth.circuitBreakerReason}` : ''}
                </p>
              )}
              {accountHealth?.lastSuccessfulSendAt && (
                <p className="text-xs text-text-secondary">{t('whatsapp.messagingSafetyCard.lastSuccessfulSend', { date: formatDateTime(accountHealth.lastSuccessfulSendAt, locale) })}</p>
              )}
              {accountHealth?.lastError && (
                <p className="text-xs text-status-danger">{t('whatsapp.messagingSafetyCard.lastErrorPrefix')} {accountHealth.lastError}</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
