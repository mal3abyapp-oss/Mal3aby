import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
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
  label: string
  enabled: boolean
}

const CATEGORY_LABELS: Record<string, string> = {
  booking_confirmations: 'تأكيدات الحجز',
  booking_reminders: 'تذكيرات الحجز',
  payment_confirmations: 'إيصالات الدفع',
  refund_notifications: 'إشعارات الاسترداد',
  academy_notifications: 'إشعارات الأكاديمية',
  subscription_reminders: 'تذكيرات الاشتراك',
}

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS)

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
    label: CATEGORY_LABELS[category] ?? category,
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

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' })
}

export function MessagingSafetyCard() {
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
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, 'تعذّر تحديث الإعداد')),
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
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, 'تعذّر حفظ الإعدادات')),
  })

  const isLoading = categoriesLoading || settingsLoading

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">ضوابط الإرسال والأمان</CardTitle>
        <p className="text-xs text-text-secondary">
          تحكم في نوع الرسائل المرسلة عبر واتساب وتوقيتها لتقليل الإزعاج والتكرار. لا يوجد رقم "آمن" مضمون لعدد الرسائل في الساعة -- هذه الإعدادات لحماية العملاء واستقرار الخدمة، وليست وسيلة للتحايل على قواعد واتساب.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
        {formError && <p className="text-sm text-status-danger">{formError}</p>}

        {!isLoading && (
          <>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">أنواع الإشعارات المفعّلة</h3>
              {categories.map((c) => (
                <label key={c.category} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    onChange={() => toggleCategoryMutation.mutate({ category: c.category, enabled: c.enabled })}
                    className="size-4"
                  />
                  {c.label}
                </label>
              ))}
              <p className="text-xs text-text-secondary">
                الرسائل التسويقية غير مدعومة في هذه المرحلة -- لا يُستخدم اتصال واتساب لإرسال رسائل جماعية.
              </p>
            </div>

            {effective && (
              <div className="flex flex-col gap-4 border-t border-border pt-4">
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">ساعات الهدوء</h3>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={effective.quietHoursEnabled}
                      onChange={(e) => setDraft((d) => ({ ...d, quietHoursEnabled: e.target.checked }))}
                      className="size-4"
                    />
                    تفعيل ساعات الهدوء (تأجيل الرسائل غير العاجلة)
                  </label>
                  {effective.quietHoursEnabled && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-text-secondary">من</label>
                        <Input
                          type="time"
                          value={effective.quietHoursStart}
                          onChange={(e) => setDraft((d) => ({ ...d, quietHoursStart: e.target.value }))}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-text-secondary">إلى</label>
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
                    السماح للإشعارات العاجلة (مثل إلغاء الحجز من النادي) بتجاوز ساعات الهدوء
                  </label>
                </div>

                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">التحكم في معدل الإرسال</h3>
                  <p className="text-xs text-text-secondary">
                    حدود تحفظ استقرار الخدمة وتمنع اندفاع الرسائل دفعة واحدة -- ليست ضمانًا لعدد "آمن" من واتساب.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-text-secondary">الحد الأقصى بالدقيقة</label>
                      <Input
                        type="number"
                        min={1}
                        value={effective.maxSendsPerMinute}
                        onChange={(e) => setDraft((d) => ({ ...d, maxSendsPerMinute: Number(e.target.value) }))}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-text-secondary">الحد الأقصى بالساعة</label>
                      <Input
                        type="number"
                        min={1}
                        value={effective.maxSendsPerHour}
                        onChange={(e) => setDraft((d) => ({ ...d, maxSendsPerHour: Number(e.target.value) }))}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-text-secondary">أقل فاصل زمني بين رسالتين لنفس العميل (بالدقائق)</label>
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
                    إيقاف الإرسال تلقائيًا مؤقتًا عند ارتفاع نسبة الفشل
                  </label>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-text-secondary">اللغة الافتراضية عند عدم تحديد لغة العميل</label>
                  <select
                    value={effective.defaultLanguage}
                    onChange={(e) => setDraft((d) => ({ ...d, defaultLanguage: e.target.value as 'ar' | 'en' }))}
                    className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                  >
                    <option value="ar">العربية</option>
                    <option value="en">English</option>
                  </select>
                </div>

                <Button size="sm" className="self-start" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || Object.keys(draft).length === 0}>
                  حفظ ضوابط الإرسال
                </Button>
              </div>
            )}

            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-medium">تشخيص قائمة الانتظار</h3>
              {diagnostics ? (
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                  <div className="rounded-md border border-border p-2">
                    <p className="text-xs text-text-secondary">قيد الانتظار</p>
                    <p className="font-medium">{diagnostics.pendingCount}</p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-xs text-text-secondary">إعادة محاولة</p>
                    <p className="font-medium">{diagnostics.retryingCount}</p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-xs text-text-secondary">منتهية الصلاحية</p>
                    <p className="font-medium">{diagnostics.expiredCount}</p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-xs text-text-secondary">فشلت نهائيًا</p>
                    <p className="font-medium">{diagnostics.failedCount}</p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-xs text-text-secondary">أُرسلت</p>
                    <p className="font-medium">{diagnostics.sentCount}</p>
                  </div>
                  <div className="rounded-md border border-border p-2">
                    <p className="text-xs text-text-secondary">أقدم رسالة منتظرة</p>
                    <p className="font-medium">{formatDateTime(diagnostics.oldestPendingCreatedAt)}</p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-text-secondary">لا توجد بيانات بعد -- لم يتم إرسال أي رسائل واتساب حتى الآن.</p>
              )}
              {accountHealth?.circuitBreakerOpenUntil && new Date(accountHealth.circuitBreakerOpenUntil) > new Date() && (
                <p className="text-xs text-status-danger">
                  الإرسال متوقف مؤقتًا (قاطع الدائرة نشط) حتى {formatDateTime(accountHealth.circuitBreakerOpenUntil)}
                  {accountHealth.circuitBreakerReason ? ` -- ${accountHealth.circuitBreakerReason}` : ''}
                </p>
              )}
              {accountHealth?.lastSuccessfulSendAt && (
                <p className="text-xs text-text-secondary">آخر إرسال ناجح: {formatDateTime(accountHealth.lastSuccessfulSendAt)}</p>
              )}
              {accountHealth?.lastError && (
                <p className="text-xs text-status-danger">آخر خطأ: {accountHealth.lastError}</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
