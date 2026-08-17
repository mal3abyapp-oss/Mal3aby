import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
      <PageHeader title="الإعدادات" description="القيم الافتراضية على مستوى المنصة بالكامل" />

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">التجربة المجانية وفترة السماح</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <p className="text-sm text-text-secondary">جارٍ التحميل...</p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="trial-days" className="text-sm font-medium text-text-secondary">مدة التجربة المجانية الافتراضية (أيام)</label>
                <Input
                  id="trial-days"
                  type="number"
                  min={1}
                  value={effectiveTrialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                />
                <p className="text-xs text-text-secondary">
                  تُستخدم عند بدء أي نادٍ جديد لتجربة مجانية تلقائية أو يدوية، ما لم تُحدَّد مدة مختلفة صراحةً.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="grace-days" className="text-sm font-medium text-text-secondary">فترة السماح الافتراضية (أيام)</label>
                <Input
                  id="grace-days"
                  type="number"
                  min={0}
                  value={effectiveGraceDays}
                  onChange={(e) => setGraceDays(e.target.value)}
                />
                <p className="text-xs text-text-secondary">
                  المدة الافتراضية عند بدء اشتراك جديد. يمكن تمديدها لاشتراك محدد لاحقًا من صفحة تفاصيل النادي.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  disabled={mutation.isPending || (!trialDays && !graceDays)}
                  onClick={() => mutation.mutate()}
                >
                  {mutation.isPending ? 'جارٍ الحفظ...' : 'حفظ'}
                </Button>
                {saved && <span className="text-sm text-status-success">تم الحفظ</span>}
                {mutation.isError && <span className="text-sm text-status-danger">تعذّر الحفظ، حاول مرة أخرى</span>}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
