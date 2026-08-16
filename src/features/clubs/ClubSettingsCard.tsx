import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// V1 Implementation Gap Audit (2026-08-16): docs/SCREEN_MAP.md explicitly
// specs "Club/Branch Settings | clubs | Desktop | Club Owner" as a locked
// V1 screen -- ClubPage.tsx's own comment admitted "full club settings
// CRUD ... not yet built". clubs.name_ar/name_en/currency/timezone and
// branches.name/address/phone all have full RLS UPDATE for club_owner
// (clubs: S,U own excl. status; branches: S,I,U per RLS_MATRIX.md) but
// no UI existed at all. This is the minimal real implementation: club
// identity + currency/timezone, and the first branch's name/address/phone
// -- a fuller multi-branch settings UI is not needed for V1 (most clubs
// launch with one branch, per ARCHITECTURE.md's pilot-club framing).
const CURRENCIES = ['EGP', 'SAR', 'AED', 'USD']
const TIMEZONES = ['Africa/Cairo', 'Asia/Riyadh', 'Asia/Dubai']

interface ClubSettings {
  id: string
  name: string
  nameAr: string
  nameEn: string | null
  currency: string
  timezone: string
}

interface BranchSettings {
  id: string
  name: string
  address: string | null
  phone: string | null
}

async function fetchClub(clubId: string): Promise<ClubSettings> {
  const { data, error } = await supabase.from('clubs').select('id, name, name_ar, name_en, currency, timezone').eq('id', clubId).single()
  if (error) throw error
  return { id: data.id, name: data.name, nameAr: data.name_ar, nameEn: data.name_en, currency: data.currency, timezone: data.timezone }
}

async function fetchFirstBranch(clubId: string): Promise<BranchSettings | null> {
  const { data, error } = await supabase.from('branches').select('id, name, address, phone').eq('club_id', clubId).order('created_at').limit(1).maybeSingle()
  if (error) throw error
  if (!data) return null
  return { id: data.id, name: data.name, address: data.address, phone: data.phone }
}

export function ClubSettingsCard() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()

  const { data: club } = useQuery({ queryKey: ['club-settings', currentClubId], queryFn: () => fetchClub(currentClubId!), enabled: !!currentClubId })
  const { data: branch } = useQuery({ queryKey: ['branch-settings', currentClubId], queryFn: () => fetchFirstBranch(currentClubId!), enabled: !!currentClubId })

  const [nameAr, setNameAr] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [currency, setCurrency] = useState('EGP')
  const [timezone, setTimezone] = useState('Africa/Cairo')
  const [branchName, setBranchName] = useState('')
  const [branchAddress, setBranchAddress] = useState('')
  const [branchPhone, setBranchPhone] = useState('')

  useEffect(() => {
    if (club) {
      setNameAr(club.nameAr)
      setNameEn(club.nameEn ?? '')
      setCurrency(club.currency)
      setTimezone(club.timezone)
    }
  }, [club])

  useEffect(() => {
    if (branch) {
      setBranchName(branch.name)
      setBranchAddress(branch.address ?? '')
      setBranchPhone(branch.phone ?? '')
    }
  }, [branch])

  const saveClubMutation = useMutation({
    mutationFn: async () => {
      if (!currentClubId) throw new Error('no club')
      const { error } = await supabase
        .from('clubs')
        .update({ name_ar: nameAr, name_en: nameEn || null, currency, timezone })
        .eq('id', currentClubId)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['club-settings', currentClubId] }),
  })

  const saveBranchMutation = useMutation({
    mutationFn: async () => {
      if (!branch) throw new Error('no branch')
      const { error } = await supabase
        .from('branches')
        .update({ name: branchName, address: branchAddress || null, phone: branchPhone || null })
        .eq('id', branch.id)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['branch-settings', currentClubId] }),
  })

  if (!club) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">إعدادات النادي</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">اسم النادي (بالعربية)</label>
            <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">اسم النادي (بالإنجليزية)</label>
            <Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">العملة</label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">المنطقة الزمنية</label>
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button size="sm" className="w-fit" disabled={!nameAr.trim() || saveClubMutation.isPending} onClick={() => saveClubMutation.mutate()}>
            {saveClubMutation.isPending ? 'جارٍ الحفظ...' : 'حفظ بيانات النادي'}
          </Button>
        </div>

        {branch && (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <p className="text-sm font-medium text-text-secondary">الفرع الرئيسي</p>
            <Input placeholder="اسم الفرع" value={branchName} onChange={(e) => setBranchName(e.target.value)} />
            <Input placeholder="العنوان" value={branchAddress} onChange={(e) => setBranchAddress(e.target.value)} />
            <Input placeholder="رقم الهاتف" value={branchPhone} onChange={(e) => setBranchPhone(e.target.value)} />
            <Button size="sm" className="w-fit" disabled={!branchName.trim() || saveBranchMutation.isPending} onClick={() => saveBranchMutation.mutate()}>
              {saveBranchMutation.isPending ? 'جارٍ الحفظ...' : 'حفظ بيانات الفرع'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
