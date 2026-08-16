import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translateSupabaseError } from '@/lib/errors'

// Gate 3 — "My Account": contact-preference self-service edit (the
// columns protect_customer_identity_columns() explicitly allows a
// self-service customer to change). Name/photo/national_id are
// deliberately NOT editable here -- name/national_id require staff
// (identity data), photo goes through the request_customer_photo_update
// re-approval flow instead of a direct edit.
interface MyCustomerRecord {
  id: string
  full_name: string
  mobile_display: string | null
  email: string | null
  whatsapp: string | null
}

async function fetchMyCustomerRecords(): Promise<MyCustomerRecord[]> {
  const { data, error } = await supabase.from('customers').select('id, full_name, mobile_display, email, whatsapp')
  if (error) throw error
  return data ?? []
}

export function PortalProfilePage() {
  const queryClient = useQueryClient()
  const { data: records = [], isLoading } = useQuery({ queryKey: ['portal', 'my-customer-records'], queryFn: fetchMyCustomerRecords })
  const record = records[0]

  const [mobile, setMobile] = useState(record?.mobile_display ?? '')
  const [email, setEmail] = useState(record?.email ?? '')
  const [whatsapp, setWhatsapp] = useState(record?.whatsapp ?? '')
  const [initialized, setInitialized] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  if (record && !initialized) {
    setMobile(record.mobile_display ?? '')
    setEmail(record.email ?? '')
    setWhatsapp(record.whatsapp ?? '')
    setInitialized(true)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!record) return
      const { error } = await supabase
        .from('customers')
        .update({
          mobile_display: mobile || null,
          normalized_mobile: mobile ? mobile.replace(/\D/g, '').replace(/^0+/, '') : null,
          email: email || null,
          whatsapp: whatsapp || null,
        })
        .eq('id', record.id)
      if (error) throw error
    },
    onSuccess: () => {
      setSaved(true)
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['portal', 'my-customer-records'] })
      setTimeout(() => setSaved(false), 3000)
    },
    onError: (error) => setFormError(translateSupabaseError(error, 'تعذّر حفظ التعديلات.')),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    saveMutation.mutate()
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="حسابي" description="بيانات التواصل الخاصة بك" />

      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}

      {!isLoading && !record && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          لا توجد بيانات مرتبطة بحسابك.
        </p>
      )}

      {record && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <p className="text-xs text-text-secondary">الاسم</p>
            <p className="font-medium">{record.full_name}</p>
            <p className="mt-1 text-xs text-text-secondary">لتعديل الاسم، تواصل مع النادي.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">رقم الهاتف</label>
            <Input value={mobile} onChange={(e) => setMobile(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">واتساب</label>
            <Input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">البريد الإلكتروني</label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>

          {formError && <p className="text-sm text-status-danger">{formError}</p>}
          {saved && <p className="text-sm text-status-success">تم الحفظ.</p>}

          <Button type="submit" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'جارٍ الحفظ...' : 'حفظ التعديلات'}
          </Button>
        </form>
      )}
    </div>
  )
}
