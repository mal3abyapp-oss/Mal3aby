import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { RentalSettings } from './types'
import { Field } from './Field'

// Club-level rental automation (run daily by the rental-daily-jobs cron):
// auto-issue each period's rent invoice N days before it is due, add a
// late fee once an installment stays unpaid past the grace days, and
// send WhatsApp reminders before the due date / when overdue.

export function RentalSettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const [form, setForm] = useState<RentalSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['rental-settings', currentClubId],
    queryFn: async () => {
      const { data: d, error: rpcError } = await supabase.rpc('get_rental_settings', { p_club_id: currentClubId! })
      if (rpcError) throw rpcError
      return d as unknown as RentalSettings
    },
    enabled: !!currentClubId,
  })

  useEffect(() => {
    if (data && !form) setForm(data)
  }, [data, form])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!form) return
      const { error: rpcError } = await supabase.rpc('update_rental_settings', {
        p_club_id: currentClubId!,
        p_auto_issue_invoices: form.auto_issue_invoices,
        p_issue_days_before: Number(form.issue_days_before),
        p_late_fee_type: form.late_fee_type,
        p_late_fee_value: Number(form.late_fee_value || 0),
        p_late_fee_grace_days: Number(form.late_fee_grace_days),
        p_whatsapp_reminders_enabled: form.whatsapp_reminders_enabled,
        p_reminder_days_before: Number(form.reminder_days_before),
        p_vat_rate: Number(form.vat_rate || 0),
        p_expiry_alert_days: Number(form.expiry_alert_days),
      })
      if (rpcError) throw rpcError
    },
    onSuccess: onClose,
    onError: (err) => setError(translateSupabaseError(err, t('rentals.settings.saveError'))),
  })

  function set<K extends keyof RentalSettings>(key: K, value: RentalSettings[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('rentals.settings.title')}</DialogTitle></DialogHeader>
        {isLoading || !form ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={form.auto_issue_invoices} onChange={(e) => set('auto_issue_invoices', e.target.checked)} />
                {t('rentals.settings.autoIssue')}
              </label>
              {form.auto_issue_invoices && (
                <Field label={t('rentals.settings.issueDaysBefore')}>
                  <Input type="number" min={0} max={60} value={form.issue_days_before} onChange={(e) => set('issue_days_before', Number(e.target.value))} />
                </Field>
              )}
              <p className="text-xs text-text-secondary">{t('rentals.settings.autoIssueHint')}</p>
            </section>

            <section className="flex flex-col gap-2 border-t border-border pt-3">
              <p className="text-sm font-medium">{t('rentals.settings.lateFees')}</p>
              <div className="flex gap-2">
                <Field label={t('rentals.settings.lateFeeType')} className="flex-1">
                  <Select value={form.late_fee_type} onValueChange={(v) => set('late_fee_type', v as RentalSettings['late_fee_type'])}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(['none', 'fixed', 'percent'] as const).map((k) => (
                        <SelectItem key={k} value={k}>{t(`rentals.settings.lateFeeTypes.${k}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {form.late_fee_type !== 'none' && (
                  <Field label={form.late_fee_type === 'percent' ? t('rentals.settings.lateFeePercent') : t('rentals.settings.lateFeeAmount')} className="flex-1">
                    <Input type="number" min={0} max={form.late_fee_type === 'percent' ? 100 : undefined} value={form.late_fee_value} onChange={(e) => set('late_fee_value', Number(e.target.value))} />
                  </Field>
                )}
              </div>
              {form.late_fee_type !== 'none' && (
                <Field label={t('rentals.settings.graceDays')}>
                  <Input type="number" min={0} max={90} value={form.late_fee_grace_days} onChange={(e) => set('late_fee_grace_days', Number(e.target.value))} />
                </Field>
              )}
              <p className="text-xs text-text-secondary">{t('rentals.settings.lateFeeHint')}</p>
            </section>

            <section className="flex flex-col gap-2 border-t border-border pt-3">
              <div className="flex gap-2">
                <Field label={t('rentals.settings.vatRate')} className="flex-1">
                  <Input type="number" min={0} max={100} step="0.5" value={form.vat_rate} onChange={(e) => set('vat_rate', Number(e.target.value))} />
                </Field>
                <Field label={t('rentals.settings.expiryAlertDays')} className="flex-1">
                  <Input type="number" min={0} max={180} value={form.expiry_alert_days} onChange={(e) => set('expiry_alert_days', Number(e.target.value))} />
                </Field>
              </div>
              <p className="text-xs text-text-secondary">{t('rentals.settings.vatHint')}</p>
            </section>

            <section className="flex flex-col gap-2 border-t border-border pt-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={form.whatsapp_reminders_enabled} onChange={(e) => set('whatsapp_reminders_enabled', e.target.checked)} />
                {t('rentals.settings.whatsapp')}
              </label>
              {form.whatsapp_reminders_enabled && (
                <Field label={t('rentals.settings.reminderDaysBefore')}>
                  <Input type="number" min={0} max={30} value={form.reminder_days_before} onChange={(e) => set('reminder_days_before', Number(e.target.value))} />
                </Field>
              )}
              <p className="text-xs text-text-secondary">{t('rentals.settings.whatsappHint')}</p>
              {!form.whatsapp_templates_live && (
                <p className="rounded-md border border-status-warning/40 bg-status-warning/5 p-2 text-xs text-status-warning">{t('rentals.settings.whatsappPending')}</p>
              )}
            </section>

            {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
            <Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
              {saveMutation.isPending ? t('rentals.saving') : t('rentals.save')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
