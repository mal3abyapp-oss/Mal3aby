import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CheckCircle2 } from 'lucide-react'

// 4-step wizard: Business Type -> Basic Details -> First Branch -> Trial
// Activation confirmation. Requires only an authenticated session — never
// gated on "no existing membership" (a returning owner can create another
// club). See docs/ARCHITECTURE.md#signup--onboarding-strategy and
// docs/DECISIONS.md ADR-042/ADR-043.
const BUSINESS_TYPES = [
  { value: 'نادي', label: 'نادي' },
  { value: 'أكاديمية', label: 'أكاديمية' },
  { value: 'ملاعب', label: 'ملاعب' },
  { value: 'مركز رياضي', label: 'مركز رياضي' },
]

export function OnboardingPage() {
  const { session, setCurrentClubId, refreshMemberships } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [businessType, setBusinessType] = useState('نادي')
  const [clubNameAr, setClubNameAr] = useState('')
  const [clubNameEn, setClubNameEn] = useState('')
  const [branchName, setBranchName] = useState('الفرع الرئيسي')
  const [city, setCity] = useState('')
  const [phone, setPhone] = useState('')
  const [result, setResult] = useState<{ clubId: string; trialGranted: boolean } | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const onboardMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('complete_new_club_onboarding', {
        p_business_type: businessType,
        p_club_name: clubNameEn || clubNameAr,
        p_club_name_ar: clubNameAr,
        p_branch_name: branchName,
        p_city: city,
        p_phone: phone,
        p_owner_email: session?.user.email ?? '',
        p_owner_mobile: phone,
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
    onError: () => setSubmitError('تعذّر إنشاء النادي. حاول مرة أخرى.'),
  })

  if (!session) {
    return (
      <div className="mx-auto max-w-md px-4 py-12 text-center">
        <p className="text-text-secondary">يجب تسجيل الدخول أولاً لإعداد ناديك.</p>
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
                <h2 className="text-xl font-bold">تم إنشاء ناديك بنجاح!</h2>
                <p className="text-text-secondary">تم تفعيل التجربة المجانية لمدة 7 أيام.</p>
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
                <h2 className="text-xl font-bold">تم إنشاء النادي</h2>
                <p className="text-text-secondary">
                  هذا ناديك الإضافي، لذلك لم يُفعَّل له اشتراك تجريبي تلقائي — الأندية الإضافية تحتاج موافقة فريق منصة ملعبي أولًا. سنتواصل معك بمجرد المراجعة، ويمكنك متابعة حالة الاشتراك من صفحة الإعدادات.
                </p>
              </>
            )}
            <Button onClick={() => navigate('/app', { replace: true })} className="mt-2">
              الذهاب إلى لوحة التحكم
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
          <CardTitle>إعداد ناديك — الخطوة {step} من 3</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {step === 1 && (
            <>
              <label className="text-sm font-medium text-text-secondary">نوع النشاط</label>
              <Select value={businessType} onValueChange={setBusinessType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {BUSINESS_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={() => setStep(2)}>التالي</Button>
            </>
          )}

          {step === 2 && (
            <>
              <label className="text-sm font-medium text-text-secondary">اسم النادي (بالعربية)</label>
              <Input required value={clubNameAr} onChange={(e) => setClubNameAr(e.target.value)} />
              <label className="text-sm font-medium text-text-secondary">اسم النادي (بالإنجليزية، اختياري)</label>
              <Input value={clubNameEn} onChange={(e) => setClubNameEn(e.target.value)} />
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(1)}>السابق</Button>
                <Button onClick={() => setStep(3)} disabled={!clubNameAr.trim()}>التالي</Button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <label className="text-sm font-medium text-text-secondary">اسم الفرع الأول</label>
              <Input required value={branchName} onChange={(e) => setBranchName(e.target.value)} />
              <label className="text-sm font-medium text-text-secondary">المدينة</label>
              <Input required value={city} onChange={(e) => setCity(e.target.value)} />
              <label className="text-sm font-medium text-text-secondary">رقم الهاتف</label>
              <Input required value={phone} onChange={(e) => setPhone(e.target.value)} />
              {submitError && (
                <p role="alert" className="text-sm text-status-danger">
                  {submitError}
                </p>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(2)}>السابق</Button>
                <Button
                  onClick={() => onboardMutation.mutate()}
                  disabled={onboardMutation.isPending || !branchName.trim() || !city.trim() || !phone.trim()}
                >
                  {onboardMutation.isPending ? 'جارٍ الإنشاء...' : 'إنشاء النادي وبدء التجربة المجانية'}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
