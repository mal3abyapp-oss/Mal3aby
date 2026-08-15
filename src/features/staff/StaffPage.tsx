import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  DialogTrigger,
} from '@/components/ui/dialog'
import type { StaffRow } from '@/lib/domain/staff'

// Phase 3 — Staff & Permissions Management.
// "Invite" only attaches an EXISTING auth.users account to this club (via
// invite_staff_member RPC) — there is no invitation-token/signup-by-email
// mechanism in the approved schema (club_memberships.user_id is a hard FK
// to auth.users). The person must already have a Mala3by account.
const ASSIGNABLE_ROLES = [
  { key: 'club_manager', labelAr: 'مدير النادي' },
  { key: 'branch_manager', labelAr: 'مدير الفرع' },
  { key: 'receptionist', labelAr: 'موظف استقبال' },
  { key: 'accountant', labelAr: 'محاسب' },
  { key: 'academy_manager', labelAr: 'مدير الأكاديمية' },
  { key: 'coach', labelAr: 'مدرب' },
  { key: 'scanner', labelAr: 'ماسح QR' },
]

async function fetchStaff(clubId: string): Promise<StaffRow[]> {
  const { data, error } = await supabase
    .from('club_memberships')
    .select(
      'id, user_id, status, roles(key, name_ar), profiles:user_id(full_name), membership_branches(branches(name))',
    )
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })

  if (error) throw error

  return (data ?? []).map((row) => {
    const roles = row.roles as unknown as { key: string; name_ar: string } | null
    // profiles is joined via user_id -> profiles.user_id; Supabase returns
    // it as an array-or-object depending on relationship inference, handle both.
    const profilesRaw = row.profiles as unknown
    const profile = Array.isArray(profilesRaw) ? profilesRaw[0] : profilesRaw
    const branchRows = (row.membership_branches ?? []) as unknown as Array<{
      branches: { name: string } | null
    }>
    return {
      membershipId: row.id,
      userId: row.user_id,
      fullName: (profile as { full_name: string | null } | undefined)?.full_name ?? null,
      roleKey: roles?.key ?? '',
      roleNameAr: roles?.name_ar ?? '',
      status: row.status,
      branchNames: branchRows.map((b) => b.branches?.name).filter((n): n is string => !!n),
    }
  })
}

export function StaffPage() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [roleKey, setRoleKey] = useState('receptionist')
  const [formError, setFormError] = useState<string | null>(null)

  const { data: staff = [], isLoading } = useQuery({
    queryKey: ['staff', currentClubId],
    queryFn: () => fetchStaff(currentClubId!),
    enabled: !!currentClubId,
  })

  const inviteMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('invite_staff_member', {
        p_club_id: currentClubId as string,
        p_email: email,
        p_role_key: roleKey,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setDialogOpen(false)
      setEmail('')
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['staff', currentClubId] })
    },
    onError: () => {
      // Never surface the raw RPC error string to the user.
      setFormError('تعذّرت الإضافة — تأكد من أن البريد الإلكتروني يخص حسابًا مسجّلاً بالفعل في ملعبي.')
    },
  })

  const deactivateMutation = useMutation({
    mutationFn: async (membershipId: string) => {
      const { error } = await supabase.rpc('deactivate_staff_member', {
        p_membership_id: membershipId,
      })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['staff', currentClubId] })
    },
  })

  function handleInviteSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    inviteMutation.mutate()
  }

  const columns: DataTableColumn<StaffRow>[] = [
    { key: 'name', header: 'الاسم', render: (r) => r.fullName ?? '—' },
    { key: 'role', header: 'الدور', render: (r) => r.roleNameAr },
    {
      key: 'branches',
      header: 'نطاق الفروع',
      render: (r) => (r.branchNames.length === 0 ? 'كل الفروع' : r.branchNames.join('، ')),
    },
    {
      key: 'status',
      header: 'الحالة',
      render: (r) =>
        r.status === 'active' ? (
          <StatusBadge tone="success" label="نشط" />
        ) : (
          <StatusBadge tone="neutral" label="غير نشط" />
        ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) =>
        r.status === 'active' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => deactivateMutation.mutate(r.membershipId)}
            disabled={deactivateMutation.isPending}
          >
            إلغاء التفعيل
          </Button>
        ) : null,
    },
  ]

  return (
    <div>
      <PageHeader
        title="الموظفون"
        description="إدارة موظفي النادي وأدوارهم ونطاق الفروع"
        actions={
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>إضافة موظف</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>إضافة موظف</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleInviteSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="staff-email" className="text-sm font-medium text-text-secondary">
                    البريد الإلكتروني (لحساب موجود بالفعل)
                  </label>
                  <Input
                    id="staff-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">الدور</label>
                  <Select value={roleKey} onValueChange={setRoleKey}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ASSIGNABLE_ROLES.map((r) => (
                        <SelectItem key={r.key} value={r.key}>
                          {r.labelAr}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {formError && (
                  <p role="alert" className="text-sm text-status-danger">
                    {formError}
                  </p>
                )}
                <Button type="submit" disabled={inviteMutation.isPending}>
                  {inviteMutation.isPending ? 'جارٍ الإضافة...' : 'إضافة'}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        }
      />

      <DataTable
        columns={columns}
        rows={staff}
        rowKey={(r) => r.membershipId}
        isLoading={isLoading}
        emptyTitle="لا يوجد موظفون بعد"
        emptyDescription="أضف أول موظف لبدء إدارة صلاحيات النادي"
      />
    </div>
  )
}
