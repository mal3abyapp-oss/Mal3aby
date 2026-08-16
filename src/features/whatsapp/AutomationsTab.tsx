import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { translateSupabaseError } from '@/lib/errors'

// Gate 8 — Automations: maps an event to a template + delivery policy.
// Doc 3 examples: booking-confirmed -> send confirmation, 24h-before-
// booking -> send reminder, payment-received -> send receipt,
// subscription-approaching-expiry -> send reminder.
const EVENT_OPTIONS = [
  { key: 'booking.created', label: 'إنشاء حجز' },
  { key: 'booking.confirmed', label: 'تأكيد حجز' },
  { key: 'booking.reminder', label: 'تذكير بالحجز (قبل 24 ساعة)' },
  { key: 'payment.received', label: 'استلام دفعة' },
  { key: 'subscription.expiring', label: 'اقتراب انتهاء الاشتراك' },
  { key: 'enrollment.confirmed', label: 'تأكيد تسجيل الأكاديمية' },
  { key: 'session.reminder', label: 'تذكير بجلسة الأكاديمية' },
]

interface AutomationRow {
  id: string
  event_type: string
  template_event_key: string
  enabled: boolean
  delay_minutes: number
  audience: string
  dedup_window_minutes: number
}

async function fetchAutomations(clubId: string): Promise<AutomationRow[]> {
  const { data, error } = await supabase
    .from('whatsapp_automations')
    .select('id, event_type, template_event_key, enabled, delay_minutes, audience, dedup_window_minutes')
    .eq('club_id', clubId)
    .order('event_type')
  if (error) throw error
  return data ?? []
}

export function AutomationsTab() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [eventType, setEventType] = useState('')
  const [delayMinutes, setDelayMinutes] = useState('0')
  const [audience, setAudience] = useState<'customer' | 'guardian' | 'staff'>('customer')
  const [formError, setFormError] = useState<string | null>(null)

  const { data: automations = [], isLoading } = useQuery({
    queryKey: ['whatsapp-automations', currentClubId],
    queryFn: () => fetchAutomations(currentClubId!),
    enabled: !!currentClubId,
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('whatsapp_automations').upsert(
        {
          club_id: currentClubId,
          event_type: eventType,
          template_event_key: eventType,
          delay_minutes: Number(delayMinutes) || 0,
          audience,
        },
        { onConflict: 'club_id,event_type' },
      )
      if (error) throw error
    },
    onSuccess: () => {
      setDialogOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-automations', currentClubId] })
    },
    onError: (error) => setFormError(translateSupabaseError(error, 'تعذّر حفظ القاعدة.')),
  })

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase.from('whatsapp_automations').update({ enabled }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['whatsapp-automations', currentClubId] }),
  })

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex justify-end">
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => { setEventType(''); setDelayMinutes('0'); setAudience('customer'); setFormError(null); setDialogOpen(true) }}>
              قاعدة جديدة
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>قاعدة تنبيه تلقائي</DialogTitle></DialogHeader>
            <form onSubmit={(e) => { e.preventDefault(); setFormError(null); saveMutation.mutate() }} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">الحدث</label>
                <Select value={eventType} onValueChange={setEventType}>
                  <SelectTrigger><SelectValue placeholder="اختر الحدث..." /></SelectTrigger>
                  <SelectContent>
                    {EVENT_OPTIONS.map((e) => (
                      <SelectItem key={e.key} value={e.key}>{e.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">التأخير (بالدقائق)</label>
                <Input type="number" min={0} value={delayMinutes} onChange={(e) => setDelayMinutes(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">الجمهور</label>
                <Select value={audience} onValueChange={(v) => setAudience(v as typeof audience)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="customer">العميل</SelectItem>
                    <SelectItem value="guardian">ولي الأمر</SelectItem>
                    <SelectItem value="staff">الموظفون</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {formError && <p role="alert" className="text-sm text-status-danger">{formError}</p>}

              <Button type="submit" disabled={!eventType || saveMutation.isPending}>
                {saveMutation.isPending ? 'جارٍ الحفظ...' : 'حفظ القاعدة'}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {!isLoading && automations.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">لا توجد قواعد بعد.</p>
      )}

      <div className="flex flex-col gap-2">
        {automations.map((a) => (
          <div key={a.id} className="flex items-center justify-between rounded-lg border border-border bg-surface p-3">
            <div>
              <p className="font-medium">{EVENT_OPTIONS.find((e) => e.key === a.event_type)?.label ?? a.event_type}</p>
              <p className="text-xs text-text-secondary">
                {a.delay_minutes > 0 ? `بعد ${a.delay_minutes} دقيقة` : 'فوري'} — {a.audience === 'customer' ? 'العميل' : a.audience === 'guardian' ? 'ولي الأمر' : 'الموظفون'}
              </p>
            </div>
            <Button
              size="sm"
              variant={a.enabled ? 'default' : 'outline'}
              onClick={() => toggleMutation.mutate({ id: a.id, enabled: !a.enabled })}
            >
              {a.enabled ? 'مفعّل' : 'معطّل'}
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}
