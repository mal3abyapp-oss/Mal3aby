import { useState } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CheckCircle2 } from 'lucide-react'
import { normalizePhone } from '@/lib/domain/phone'

// 4-step wizard: Business Type -> Basic Details -> First Branch -> Trial
// Activation confirmation. Requires only an authenticated session — never
// gated on "no existing membership" (a returning owner can create another
// club). See docs/ARCHITECTURE.md#signup--onboarding-strategy and
// docs/DECISIONS.md ADR-042/ADR-043.
// NOTE: values sent to the backend RPC stay in Arabic (p_business_type is
// stored/compared as-is server-side) -- only the displayed label is
// localized via t().
const BUSINESS_TYPES = [
  { value: 'نادي', labelKey: 'onboarding.businessTypes.club' },
  { value: 'أكاديمية', labelKey: 'onboarding.businessTypes.academy' },
  { value: 'ملاعب', labelKey: 'onboarding.businessTypes.fields' },
  { value: 'مركز رياضي', labelKey: 'onboarding.businessTypes.sportsCenter' },
]

export function OnboardingPage() {
  const { t } = useTranslation()
  const { session, setCurrentClubId, refreshMemberships } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [businessType, setBusinessType] = useState('نادي')
  const [clubNameAr, setClubNameAr] = useState('')
  const [clubNameEn, setClubNameEn] = useState('')
  const [branchName, setBranchName] = useState(t('onboarding.defaultBranchName'))
  const [city, setCity] = useState('')
  const [phone, setPhone] = useState('')
  const [phoneCountry, setPhoneCountry] = useState<CountryCode>('EG')
  const [phoneValid, setPhoneValid] = useState(false)
  // Government / Ministry Collection Compliance directive, section 3/47:
  // asked at onboarding, defaults unanswered (no pre-selected YES/NO) so
  // an ordinary commercial club isn't nudged toward a compliance
  // workflow it doesn't need -- "NO" behaves identically to never
  // asking, per section 48 (zero regression for non-government clubs).
  const [governmentAffiliated, setGovernmentAffiliated] = useState<boolean | null>(null)
  const [result, setResult] = useState<{ clubId: string; trialGranted: boolean } | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const onboardMutation = useMutation({
    mutationFn: async () => {
      // P0 Phone Identity directive: the club's default country
      // (section 3/4) and the branch phone's canonical E.164 form are
      // both established at the same moment -- no club can exist with
      // country unset while accepting local phone numbers elsewhere.
      const phoneResult = normalizePhone(phone, phoneCountry)
      if (!phoneResult.valid || !phoneResult.e164) {
        throw new Error(t('phoneInput.invalidError'))
      }

      const { data, error } = await supabase.rpc('complete_new_club_onboarding', {
        p_business_type: businessType,
        p_club_name: clubNameEn || clubNameAr,
        p_club_name_ar: clubNameAr,
        p_branch_name: branchName,
        p_city: city,
        p_phone: phone,
        p_owner_email: session?.user.email ?? '',
        p_owner_mobile: phone,
        p_government_affiliated: governmentAffiliated === true,
        p_country: phoneCountry,
        p_phone_e164: phoneResult.e164,
      })
      if (error) throw error
      const row = data?.[0]
      if (!row) throw new Error('no result')
      return { clubId: row.club_id as string, trialGranted: row.trial_granted as boolean }
    },
    onSuccess: async (r) => {
      setResult({ clubId: r.clubId, trialGranted: r.trialGranted })
      await refreshMemberships()
      setCurrentClubId(r.clubId)
      setStep(4)
    },
    onError: (error: unknown) =>
      setSubmitError(error instanceof Error && error.message === t('phoneInput.invalidError') ? error.message : t('onboarding.createError')),
  })

  if (!session) {
    return (
      <div className="mx-auto max-w-md px-4 py-12 text-center">
        <p className="text-text-secondary">{t('onboarding.loginRequired')}</p>
      </div>
    )
  }

  if (result) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-md items-center justify-center px-4 py-12">
        <Card className="w-full text-center">
          <CardContent className="flex flex-col items-center gap-4 pt-8">
            <CheckCircle2 className="size-12 text-status-success" />
            {result.trialGranted ? (
              <>
                <h2 className="text-xl font-bold">{t('onboarding.success.titleWithTrial')}</h2>
                <p className="text-text-secondary">{t('onboarding.success.trialActivated')}</p>
              </>
            ) : (
              // Gate 13 (task #53): trial_granted=false here specifically
              // means this owner already has an active trial-entitlement
              // record on another club (complete_new_club_onboarding()
              // enforces one automatic trial per owner). This is expected,
              // routine behavior for a second/later club, not an error —
              // the message must say so plainly rather than the previous
              // vague "contact us to activate," which read as if something
              // had gone wrong.
              <>
                <h2 className="text-xl font-bold">{t('onboarding.success.titleNoTrial')}</h2>
                <p className="text-text-secondary">
                  {t('onboarding.success.noTrialMessage')}
                </p>
              </>
            )}
            <Button onClick={() => navigate('/app', { replace: true })} className="mt-2">
              {t('onboarding.success.goToDashboard')}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>{t('onboarding.wizard.titleWithStep', { step })}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {step === 1 && (
            <>
              <label className="text-sm font-medium text-text-secondary">{t('onboarding.wizard.step1.businessTypeLabel')}</label>
              <Select value={businessType} onValueChange={setBusinessType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {BUSINESS_TYPES.map((bt) => (
                    <SelectItem key={bt.value} value={bt.value}>{t(bt.labelKey)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={() => setStep(2)}>{t('onboarding.wizard.step1.next')}</Button>
            </>
          )}

          {step === 2 && (
            <>
              <label className="text-sm font-medium text-text-secondary">{t('onboarding.wizard.step2.clubNameArLabel')}</label>
              <Input required value={clubNameAr} onChange={(e) => setClubNameAr(e.target.value)} />
              <label className="text-sm font-medium text-text-secondary">{t('onboarding.wizard.step2.clubNameEnLabel')}</label>
              <Input value={clubNameEn} onChange={(e) => setClubNameEn(e.target.value)} />
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(1)}>{t('onboarding.wizard.step2.back')}</Button>
                <Button onClick={() => setStep(3)} disabled={!clubNameAr.trim()}>{t('onboarding.wizard.step2.next')}</Button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <label className="text-sm font-medium text-text-secondary">{t('onboarding.wizard.step3.branchNameLabel')}</label>
              <Input required value={branchName} onChange={(e) => setBranchName(e.target.value)} />
              <label className="text-sm font-medium text-text-secondary">{t('onboarding.wizard.step3.cityLabel')}</label>
              <Input required value={city} onChange={(e) => setCity(e.target.value)} />
              <PhoneInput
                label={t('onboarding.wizard.step3.phoneLabel')}
                required
                value={{ raw: phone, country: phoneCountry }}
                onChange={(v) => {
                  setPhone(v.raw)
                  setPhoneCountry(v.country)
                }}
                onValidChange={(r) => setPhoneValid(r.valid)}
              />

              {/* Government / Ministry Collection Compliance directive,
                  section 3: asked at every club creation, but never
                  blocks or complicates onboarding for a "no" answer. */}
              <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
                <label className="text-sm font-medium text-text-secondary">
                  {t('onboarding.wizard.step3.governmentAffiliatedLabel')}
                </label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={governmentAffiliated === true ? 'default' : 'outline'}
                    onClick={() => setGovernmentAffiliated(true)}
                  >
                    {t('onboarding.wizard.step3.yes')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={governmentAffiliated === false ? 'default' : 'outline'}
                    onClick={() => setGovernmentAffiliated(false)}
                  >
                    {t('onboarding.wizard.step3.no')}
                  </Button>
                </div>
              </div>

              {submitError && (
                <p role="alert" className="text-sm text-status-danger">
                  {submitError}
                </p>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(2)}>{t('onboarding.wizard.step3.back')}</Button>
                <Button
                  onClick={() => onboardMutation.mutate()}
                  disabled={onboardMutation.isPending || !branchName.trim() || !city.trim() || !phone.trim() || !phoneValid || governmentAffiliated === null}
                >
                  {onboardMutation.isPending ? t('onboarding.wizard.step3.submitting') : t('onboarding.wizard.step3.submit')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
