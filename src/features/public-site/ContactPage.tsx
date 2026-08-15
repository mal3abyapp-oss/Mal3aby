import { useState, type FormEvent } from 'react'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

// contact_requests: anon INSERT only, no SELECT — a submitter can never
// read back other submissions (see DATABASE_BLUEPRINT.md#contact_requests).
export function ContactPage() {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    const { error: insertError } = await supabase.from('contact_requests').insert({
      name,
      phone,
      email: email || null,
      business_name: businessName || null,
      message: message || null,
    })

    setSubmitting(false)

    if (insertError) {
      setError('تعذّر إرسال الطلب، حاول مرة أخرى.')
      return
    }

    setSubmitted(true)
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <PageHeader title="تواصل معنا" description="سنرد عليك في أقرب وقت ممكن" />
      <Card>
        <CardContent className="pt-6">
          {submitted ? (
            <p className="text-center text-status-success">تم إرسال طلبك بنجاح، سنتواصل معك قريبًا.</p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <Input placeholder="الاسم" required value={name} onChange={(e) => setName(e.target.value)} />
              <Input placeholder="رقم الهاتف" required value={phone} onChange={(e) => setPhone(e.target.value)} />
              <Input
                placeholder="البريد الإلكتروني (اختياري)"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input
                placeholder="اسم النادي/الأكاديمية (اختياري)"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
              />
              <textarea
                placeholder="رسالتك (اختياري)"
                className="min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              {error && (
                <p role="alert" className="text-sm text-status-danger">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={submitting}>
                {submitting ? 'جارٍ الإرسال...' : 'إرسال'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
