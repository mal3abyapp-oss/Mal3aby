import { useState } from 'react'
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Government / Ministry Collection Compliance directive, sections 4/8:
// "لا تخفِ هذه Policy بعد Onboarding" -- a real Finance & Compliance
// settings surface, not a one-time onboarding question that's never
// visible again. Club-level policy only here; branch/field overrides
// (section 6/60) are managed from BranchesFieldsPage per-field, not
// duplicated in this card.

const AUTHORITY_TYPES = [
  'MINISTRY_YOUTH_AND_SPORTS', 'YOUTH_CENTER', 'GOVERNMENT_CLUB', 'GOVERNMENT_FACILITY', 'OTHER',
] as const

const ALL_METHODS = ['cash', 'card', 'bank_transfer', 'wallet', 'other'] as const

interface PolicyRow {
  enabled: boolean
  authority_type: string | null
  official_receipt_required: boolean
  required_payment_methods: string[]
  receipt_book_enabled: boolean
  receipt_series_enabled: boolean
  receipt_date_required: boolean
  receipt_image_required: boolean
}

async function fetchClubPolicy(clubId: string): Promise<PolicyRow | null> {
  const { data, error } = await supabase
    .from('government_collection_policies')
    .select('enabled, authority_type, official_receipt_required, required_payment_methods, receipt_book_enabled, receipt_series_enabled, receipt_date_required, receipt_image_required')
    .eq('club_id', clubId)
    .is('branch_id', null)
    .is('field_id', null)
    .maybeSingle()
  if (error) throw error
  return data
}

export function GovernmentComplianceCard() {
  const { t } = useTranslation()
  const { currentClubId, currentMembership } = useAuth()
  const queryClient = useQueryClient()
  const canEdit = currentMembership?.roleKey === 'club_owner'

  const { data, isLoading } = useQuery({
    queryKey: ['government-compliance-policy', currentClubId],
    queryFn: () => fetchClubPolicy(currentClubId!),
    enabled: !!currentClubId,
  })

  const [editing, setEditing] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [authorityType, setAuthorityType] = useState<string>('GOVERNMENT_CLUB')
  const [receiptRequired, setReceiptRequired] = useState(false)
  const [methods, setMethods] = useState<string[]>(['cash'])
  const [receiptImageRequired, setReceiptImageRequired] = useState(false)
  const [receiptBookEnabled, setReceiptBookEnabled] = useState(false)
  const [receiptSeriesEnabled, setReceiptSeriesEnabled] = useState(false)

  const [showReasonDialog, setShowReasonDialog] = useState(false)
  const [reasonText, setReasonText] = useState('')

  function startEditing() {
    setEnabled(data?.enabled ?? false)
    setAuthorityType(data?.authority_type ?? 'GOVERNMENT_CLUB')
    setReceiptRequired(data?.official_receipt_required ?? false)
    setMethods(data?.required_payment_methods ?? ['cash'])
    setReceiptImageRequired(data?.receipt_image_required ?? false)
    setReceiptBookEnabled(data?.receipt_book_enabled ?? false)
    setReceiptSeriesEnabled(data?.receipt_series_enabled ?? false)
    setEditing(true)
  }

  const saveMutation = useMutation({
    mutationFn: async (reason: string | null) => {
      const { error } = await supabase.rpc('update_government_compliance_policy', {
        p_club_id: currentClubId!,
        // The generated type marks these as required `string` (from the
        // SQL function's plain `uuid` param, no SQL-level default) even
        // though passing null is the correct, supported way to target
        // the club-level policy row -- cast through unknown rather than
        // widen the whole call's arg type.
        p_branch_id: null as unknown as string,
        p_field_id: null as unknown as string,
        p_enabled: enabled,
        p_authority_type: authorityType,
        p_official_receipt_required: receiptRequired,
        p_required_payment_methods: methods,
        p_receipt_book_enabled: receiptBookEnabled,
        p_receipt_series_enabled: receiptSeriesEnabled,
        p_receipt_date_required: true,
        p_receipt_image_required: receiptImageRequired,
        p_reason: reason ?? undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['government-compliance-policy', currentClubId] })
      setEditing(false)
      setShowReasonDialog(false)
      setReasonText('')
    },
  })

  function handleSave() {
    // Directive section 34/59: disabling an already-enabled policy
    // requires a reason -- collect it via a dialog rather than saving
    // silently. (An enable, or a change while staying enabled, needs
    // no reason -- the server only enforces one when actually disabling.)
    const isDisabling = data?.enabled === true && enabled === false
    if (isDisabling) {
      setShowReasonDialog(true)
      return
    }
    saveMutation.mutate(null)
  }

  function toggleMethod(method: string) {
    setMethods((prev) => (prev.includes(method) ? prev.filter((m) => m !== method) : [...prev, method]))
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-text-secondary">{t('governmentCompliance.loading')}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t('governmentCompliance.title')}</CardTitle>
        {data?.enabled && <StatusBadge tone="warning" label={t('governmentCompliance.activeBadge')} />}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!editing ? (
          <>
            <div className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary">{t('governmentCompliance.affiliationStatus')}</span>
                <span className="font-medium">
                  {data?.enabled ? t('governmentCompliance.affiliated') : t('governmentCompliance.notAffiliated')}
                </span>
              </div>
              {data?.enabled && (
                <>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">{t('governmentCompliance.receiptRequired')}</span>
                    <span className="font-medium">
                      {data.official_receipt_required ? t('governmentCompliance.yes') : t('governmentCompliance.no')}
                    </span>
                  </div>
                  {data.official_receipt_required && (
                    <div className="flex justify-between">
                      <span className="text-text-secondary">{t('governmentCompliance.requiredMethods')}</span>
                      <span className="font-medium">
                        {data.required_payment_methods.map((m) => t(`common.paymentMethodLabels.${m}`, { defaultValue: m })).join(', ')}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
            {canEdit && (
              <Button size="sm" variant="outline" onClick={startEditing} className="self-start">
                {t('governmentCompliance.edit')}
              </Button>
            )}
            {!canEdit && data?.enabled && (
              <p className="text-xs text-text-secondary">{t('governmentCompliance.ownerOnlyHint')}</p>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <input
                id="gcp-enabled"
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="size-4"
              />
              <label htmlFor="gcp-enabled" className="text-sm font-medium">{t('governmentCompliance.enabledLabel')}</label>
            </div>

            {enabled && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">{t('governmentCompliance.authorityTypeLabel')}</label>
                  <Select value={authorityType} onValueChange={setAuthorityType}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {AUTHORITY_TYPES.map((a) => (
                        <SelectItem key={a} value={a}>{t(`governmentCompliance.authorityTypes.${a}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    id="gcp-receipt-required"
                    type="checkbox"
                    checked={receiptRequired}
                    onChange={(e) => setReceiptRequired(e.target.checked)}
                    className="size-4"
                  />
                  <label htmlFor="gcp-receipt-required" className="text-sm font-medium">{t('governmentCompliance.receiptRequiredLabel')}</label>
                </div>

                {receiptRequired && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-sm font-medium text-text-secondary">{t('governmentCompliance.methodsLabel')}</label>
                      <div className="flex flex-wrap gap-2">
                        {ALL_METHODS.map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => toggleMethod(m)}
                            className={`rounded-full border px-3 py-1 text-xs ${methods.includes(m) ? 'border-accent-foreground bg-accent-foreground/10 text-accent-foreground' : 'border-border text-text-secondary'}`}
                          >
                            {t(`common.paymentMethodLabels.${m}`, { defaultValue: m })}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        id="gcp-image-required"
                        type="checkbox"
                        checked={receiptImageRequired}
                        onChange={(e) => setReceiptImageRequired(e.target.checked)}
                        className="size-4"
                      />
                      <label htmlFor="gcp-image-required" className="text-sm">{t('governmentCompliance.imageRequiredLabel')}</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        id="gcp-book-enabled"
                        type="checkbox"
                        checked={receiptBookEnabled}
                        onChange={(e) => setReceiptBookEnabled(e.target.checked)}
                        className="size-4"
                      />
                      <label htmlFor="gcp-book-enabled" className="text-sm">{t('governmentCompliance.bookEnabledLabel')}</label>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        id="gcp-series-enabled"
                        type="checkbox"
                        checked={receiptSeriesEnabled}
                        onChange={(e) => setReceiptSeriesEnabled(e.target.checked)}
                        className="size-4"
                      />
                      <label htmlFor="gcp-series-enabled" className="text-sm">{t('governmentCompliance.seriesEnabledLabel')}</label>
                    </div>
                  </>
                )}
              </>
            )}

            {saveMutation.isError && (
              <p role="alert" className="text-sm text-status-danger">{t('governmentCompliance.saveError')}</p>
            )}

            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? t('governmentCompliance.saving') : t('governmentCompliance.save')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                {t('governmentCompliance.cancel')}
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={showReasonDialog} onOpenChange={setShowReasonDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('governmentCompliance.disableReasonTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-status-danger">{t('governmentCompliance.disableWarning')}</p>
            <Input value={reasonText} onChange={(e) => setReasonText(e.target.value)} placeholder={t('governmentCompliance.reasonPlaceholder')} />
            <Button
              variant="destructive"
              disabled={!reasonText.trim() || saveMutation.isPending}
              onClick={() => saveMutation.mutate(reasonText.trim())}
            >
              {t('governmentCompliance.confirmDisable')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
