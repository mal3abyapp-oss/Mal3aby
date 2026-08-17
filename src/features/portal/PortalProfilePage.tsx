import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { translateSupabaseError } from '@/lib/errors'

// Gate 3 — "My Account": contact-preference self-service edit (the
// columns protect_customer_identity_columns() explicitly allows a
// self-service customer to change). Name/photo/national_id are
// deliberately NOT editable here -- name/national_id require staff
// (identity data), photo goes through the request_customer_photo_update
// re-approval flow instead of a direct edit.
//
// IA restructuring (Phase 10): confirmed silent-data-drop bug --
// `records[0]` silently picked only the FIRST linked customer record.
// A guardian linked at more than one club (a real, supported state --
// the same phone number can be a customer of two different clubs) had
// every club after the first completely inaccessible here, with no
// indication a second record even existed. Now fetches club_id/name
// alongside each record and offers a club selector whenever more than
// one linked record exists; a single-club guardian sees no selector at
// all (same experience as before for the common case).
interface MyCustomerRecord {
  id: string
  full_name: string
  mobile_display: string | null
  email: string | null
  whatsapp: string | null
  club_id: string
  clubs: { name_ar: string } | null
}

async function fetchMyCustomerRecords(): Promise<MyCustomerRecord[]> {
  const { data, error } = await supabase
    .from('customers')
    .select('id, full_name, mobile_display, email, whatsapp, club_id, clubs(name_ar)')
  if (error) throw error
  return (data ?? []) as unknown as MyCustomerRecord[]
}

export function PortalProfilePage() {
  const queryClient = useQueryClient()
  const { data: records = [], isLoading } = useQuery({ queryKey: ['portal', 'my-customer-records'], queryFn: fetchMyCustomerRecords })
  const [selectedClubId, setSelectedClubId] = useState<string | null>(null)
  const record = records.find((r) => r.club_id === selectedClubId) ?? records[0]

  const [mobile, setMobile] = useState(record?.mobile_display ?? '')
  const [email, setEmail] = useState(record?.email ?? '')
  const [whatsapp, setWhatsapp] = useState(record?.whatsapp ?? '')
  const [initializedForId, setInitializedForId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Re-initialize the form fields whenever the effective record changes
  // (first load, or the guardian switches clubs via the selector) --
  // keyed on record.id so switching clubs always re-syncs to that
  // club's own data instead of carrying over the previous club's
  // edited-but-unsaved field values.
  if (record && initializedForId !== record.id) {
    setMobile(record.mobile_display ?? '')
    setEmail(record.email ?? '')
    setWhatsapp(record.whatsapp ?? '')
    setInitializedForId(record.id)
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

      {records.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">النادي</label>
          <Select value={record?.club_id ?? ''} onValueChange={setSelectedClubId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {records.map((r) => (
                <SelectItem key={r.club_id} value={r.club_id}>{r.clubs?.name_ar ?? r.club_id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-text-secondary">حسابك مرتبط بأكثر من نادي -- اختر النادي لتعديل بياناتك فيه.</p>
        </div>
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
