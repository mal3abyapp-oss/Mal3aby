import { useState, type FormEvent } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { translateSupabaseError } from '@/lib/errors'
import { normalizePhone } from '@/lib/domain/phone'

// P1-7 (critical usability fix pass, 2026-08-16): Settings previously
// only exposed the FIRST branch's fields for editing, with no branch
// list and no way to add a second branch through the product -- a real
// gap for any club with more than one location (the QA dataset itself
// has two). This is a real branch list + add + edit, matching Section
// P1-7's "BRANCHES: branch list / add branch / edit branch / branch
// code / branch details supported by schema" requirement.

interface BranchRow {
  id: string
  name: string
  branchCode: string
  address: string | null
  phone: string | null
  status: string
}

async function fetchBranches(clubId: string): Promise<BranchRow[]> {
  const { data, error } = await supabase
    .from('branches')
    .select('id, name, branch_code, address, phone, status')
    .eq('club_id', clubId)
    .order('created_at')
  if (error) throw error
  return (data ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    branchCode: b.branch_code,
    address: b.address,
    phone: b.phone,
    status: b.status,
  }))
}

async function fetchClubCountry(clubId: string): Promise<CountryCode | null> {
  const { data, error } = await supabase.from('clubs').select('country').eq('id', clubId).single()
  if (error) return null
  return (data?.country as CountryCode | null) ?? null
}

export function BranchesCard() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [editingBranch, setEditingBranch] = useState<BranchRow | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [branchCode, setBranchCode] = useState('')
  const [address, setAddress] = useState('')
  const [phone, setPhone] = useState('')
  const [phoneCountry, setPhoneCountry] = useState<CountryCode>('EG')
  const [status, setStatus] = useState<'active' | 'inactive'>('active')

  const { data: branches = [], isLoading } = useQuery({
    queryKey: ['branches-settings', currentClubId],
    queryFn: () => fetchBranches(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: clubCountry } = useQuery({
    queryKey: ['club-country', currentClubId],
    queryFn: () => fetchClubCountry(currentClubId!),
    enabled: !!currentClubId,
  })

  function openEdit(b: BranchRow) {
    setEditingBranch(b)
    setName(b.name)
    setBranchCode(b.branchCode)
    setAddress(b.address ?? '')
    setPhone(b.phone ?? '')
    setPhoneCountry((clubCountry as CountryCode) ?? 'EG')
    setFormError(null)
    setStatus(b.status === 'inactive' ? 'inactive' : 'active')
  }

  function openCreate() {
    setCreateOpen(true)
    setName('')
    setBranchCode('')
    setAddress('')
    setPhone('')
    setPhoneCountry((clubCountry as CountryCode) ?? 'EG')
    setFormError(null)
    setStatus('active')
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      let phoneE164: string | null = null
      if (phone.trim()) {
        const result = normalizePhone(phone, phoneCountry)
        if (!result.valid || !result.e164) {
          throw new Error(t('phoneInput.invalidError'))
        }
        phoneE164 = result.e164
      }

      const { error } = await supabase.rpc('manage_branch', {
        // manage_branch(p_branch_id, ...) has no SQL DEFAULT (positional
        // required param), so the generated types mark it non-nullable
        // `string` -- but the function body explicitly branches on
        // `if p_branch_id is null` to decide create-vs-update, so null
        // is a genuine, intended value here, not a type error.
        p_branch_id: (editingBranch?.id ?? null) as unknown as string,
        p_club_id: currentClubId as string,
        p_name: name,
        p_branch_code: branchCode,
        p_address: address,
        p_phone: phone,
        p_phone_e164: phoneE164 ?? '',
        p_status: status,
        p_reason: editingBranch ? 'Branch master data updated' : 'Branch created',
      })
      if (error) throw error
    },
    onSuccess: () => {
      setEditingBranch(null)
      setCreateOpen(false)
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['branches-settings', currentClubId] })
      void queryClient.invalidateQueries({ queryKey: ['branches-for-bookings', currentClubId] })
      void queryClient.invalidateQueries({ queryKey: ['branches-for-fields', currentClubId] })
    },
    onError: (error) => setFormError(translateSupabaseError(error, t('clubs.branchesCard.saveError'))),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    saveMutation.mutate()
  }

  const formFields = (
    <>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-secondary">{t('clubs.branchesCard.nameLabel')}</label>
        <Input required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-secondary">{t('clubs.branchesCard.codeLabel')}</label>
        <Input required value={branchCode} onChange={(e) => setBranchCode(e.target.value.toUpperCase())} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-secondary">{t('clubs.branchesCard.addressLabel')}</label>
        <Input value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>
      <PhoneInput
        label={t('clubs.branchesCard.phoneLabel')}
        value={{ raw: phone, country: phoneCountry }}
        onChange={(v) => {
          setPhone(v.raw)
          setPhoneCountry(v.country)
        }}
      />
      {editingBranch && (
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('clubs.branchesCard.statusLabel')}</label>
          <select className="h-10 rounded-md border border-border bg-surface px-3 text-sm" value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}>
            <option value="active">{t('clubs.branchesCard.active')}</option>
            <option value="inactive">{t('clubs.branchesCard.inactive')}</option>
          </select>
          {status === 'inactive' && <p className="text-xs text-status-warning">{t('clubs.branchesCard.deactivateHint')}</p>}
        </div>
      )}
      {formError && <p role="alert" className="text-sm text-status-danger">{formError}</p>}
      <Button type="submit" disabled={!name.trim() || !branchCode.trim() || saveMutation.isPending}>
        {saveMutation.isPending ? t('clubs.branchesCard.saving') : t('clubs.branchesCard.save')}
      </Button>
    </>
  )

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t('clubs.branchesCard.title')}</CardTitle>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm" onClick={openCreate}>{t('clubs.branchesCard.addBranch')}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{t('clubs.branchesCard.addBranch')}</DialogTitle></DialogHeader>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">{formFields}</form>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {isLoading && <p className="text-sm text-text-secondary">{t('clubs.branchesCard.loading')}</p>}
        {!isLoading && branches.length === 0 && <p className="text-sm text-text-secondary">{t('clubs.branchesCard.noBranches')}</p>}
        {branches.map((b) => (
          <button
            key={b.id}
            onClick={() => openEdit(b)}
            className="flex items-center justify-between rounded-md border border-border p-3 text-start text-sm hover:bg-muted/40"
          >
            <div>
              <p className="font-medium">{b.name} <span className="text-xs text-text-secondary">({b.branchCode})</span></p>
              {b.address && <p className="text-xs text-text-secondary">{b.address}</p>}
            </div>
            <StatusBadge tone={b.status === 'active' ? 'success' : 'neutral'} label={b.status === 'active' ? t('clubs.branchesCard.active') : b.status} />
          </button>
        ))}
      </CardContent>

      <Dialog open={!!editingBranch} onOpenChange={(open) => !open && setEditingBranch(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('clubs.branchesCard.editTitle', { name: editingBranch?.name })}</DialogTitle></DialogHeader>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">{formFields}</form>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
