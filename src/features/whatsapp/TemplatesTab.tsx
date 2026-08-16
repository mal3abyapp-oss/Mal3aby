import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { translateSupabaseError } from '@/lib/errors'

// Gate 8 — Templates: one per core event, Arabic/English separately
// editable, variable-validated server-side (see
// validate_whatsapp_template_variables() trigger -- an edit that
// breaks substitution is rejected, not silently allowed).
const EVENT_OPTIONS = [
  { key: 'booking.created', label: 'إنشاء حجز' },
  { key: 'booking.confirmed', label: 'تأكيد حجز' },
  { key: 'booking.reminder', label: 'تذكير بالحجز' },
  { key: 'booking.changed', label: 'تعديل حجز' },
  { key: 'booking.cancelled', label: 'إلغاء حجز' },
  { key: 'payment.received', label: 'استلام دفعة' },
  { key: 'payment.partial', label: 'دفعة جزئية' },
  { key: 'refund.completed', label: 'إتمام استرجاع' },
  { key: 'enrollment.confirmed', label: 'تأكيد تسجيل الأكاديمية' },
  { key: 'subscription.activated', label: 'تفعيل اشتراك' },
  { key: 'subscription.expiring', label: 'اقتراب انتهاء الاشتراك' },
  { key: 'subscription.expired', label: 'انتهاء الاشتراك' },
  { key: 'subscription.frozen', label: 'تجميد الاشتراك' },
  { key: 'subscription.reactivated', label: 'إعادة تفعيل الاشتراك' },
  { key: 'session.reminder', label: 'تذكير بجلسة الأكاديمية' },
]

interface TemplateRow {
  id: string
  event_key: string
  language: string
  body: string
  variables: string[]
  is_active: boolean
  updated_at: string
}

async function fetchTemplates(clubId: string): Promise<TemplateRow[]> {
  const { data, error } = await supabase
    .from('whatsapp_templates')
    .select('id, event_key, language, body, variables, is_active, updated_at')
    .eq('club_id', clubId)
    .order('event_key')
  if (error) throw error
  return data ?? []
}

export function TemplatesTab() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [eventKey, setEventKey] = useState('')
  const [language, setLanguage] = useState<'ar' | 'en'>('ar')
  const [body, setBody] = useState('')
  const [variablesInput, setVariablesInput] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['whatsapp-templates', currentClubId],
    queryFn: () => fetchTemplates(currentClubId!),
    enabled: !!currentClubId,
  })

  function openCreateDialog() {
    setEventKey('')
    setLanguage('ar')
    setBody('')
    setVariablesInput('')
    setFormError(null)
    setDialogOpen(true)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const variables = variablesInput.split(',').map((v) => v.trim()).filter(Boolean)
      const { error } = await supabase.from('whatsapp_templates').upsert(
        { club_id: currentClubId, event_key: eventKey, language, body, variables },
        { onConflict: 'club_id,event_key,language' },
      )
      if (error) throw error
    },
    onSuccess: () => {
      setDialogOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-templates', currentClubId] })
    },
    onError: (error) => setFormError(translateSupabaseError(error, 'تعذّر حفظ القالب — تأكد من أن المتغيرات المستخدمة في النص معرّفة.')),
  })

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex justify-end">
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreateDialog}>قالب جديد</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>قالب رسالة</DialogTitle></DialogHeader>
            <form onSubmit={(e) => { e.preventDefault(); setFormError(null); saveMutation.mutate() }} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">الحدث</label>
                <Select value={eventKey} onValueChange={setEventKey}>
                  <SelectTrigger><SelectValue placeholder="اختر الحدث..." /></SelectTrigger>
                  <SelectContent>
                    {EVENT_OPTIONS.map((e) => (
                      <SelectItem key={e.key} value={e.key}>{e.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">اللغة</label>
                <Select value={language} onValueChange={(v) => setLanguage(v as 'ar' | 'en')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ar">العربية</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">نص الرسالة</label>
                <textarea
                  className="min-h-24 rounded-md border border-border bg-background p-2 text-sm"
                  placeholder="مرحبا {{customer_name}}، حجزك في {{field_name}} يوم {{date}} الساعة {{time}} مؤكد."
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
                <p className="text-xs text-text-secondary">استخدم {'{{'}اسم_المتغير{'}}'}  للمتغيرات — يجب تعريفها في الحقل التالي</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">المتغيرات (مفصولة بفاصلة)</label>
                <Input placeholder="customer_name, field_name, date, time" value={variablesInput} onChange={(e) => setVariablesInput(e.target.value)} />
              </div>

              {formError && <p role="alert" className="text-sm text-status-danger">{formError}</p>}

              <Button type="submit" disabled={!eventKey || !body.trim() || saveMutation.isPending}>
                {saveMutation.isPending ? 'جارٍ الحفظ...' : 'حفظ القالب'}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {!isLoading && templates.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">لا توجد قوالب بعد.</p>
      )}

      <div className="flex flex-col gap-2">
        {templates.map((t) => (
          <div key={t.id} className="rounded-lg border border-border bg-surface p-3">
            <div className="flex items-center justify-between">
              <p className="font-medium">{EVENT_OPTIONS.find((e) => e.key === t.event_key)?.label ?? t.event_key}</p>
              <span className="text-xs text-text-secondary">{t.language === 'ar' ? 'العربية' : 'English'}</span>
            </div>
            <p className="mt-1 text-sm text-text-secondary">{t.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
