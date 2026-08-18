import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
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
  { key: 'club_manager', labelKey: 'staff.roles.club_manager' },
  { key: 'branch_manager', labelKey: 'staff.roles.branch_manager' },
  { key: 'receptionist', labelKey: 'staff.roles.receptionist' },
  { key: 'accountant', labelKey: 'staff.roles.accountant' },
  { key: 'academy_manager', labelKey: 'staff.roles.academy_manager' },
  { key: 'coach', labelKey: 'staff.roles.coach' },
  { key: 'scanner', labelKey: 'staff.roles.scanner' },
]

// V1 Critical Fix Pass (2026-08-16): fetchStaff previously left-embedded
// `profiles` on the same select() as `roles`/`membership_branches`. A
// membership whose user has no profiles row yet (pre-trigger test data,
// or any future edge case where handle_new_user didn't run) makes
// PostgREST's embed resolve to null for that relation -- which is
// correct and should NOT drop the row -- but there is no guarantee
// every future embed stays that lenient, and a missing name silently
// rendering as "—" with no visible explanation reads as "the staff
// member I just added isn't there." Fetch profiles separately and merge
// client-side so a missing profile can never hide a real membership row,
// and show a clear placeholder instead of a bare dash.
async function fetchStaff(clubId: string): Promise<StaffRow[]> {
  const { data, error } = await supabase
    .from('club_memberships')
    .select(
      'id, user_id, status, roles(key, name_ar), membership_branches(branches(name))',
    )
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })

  if (error) throw error

  const userIds = (data ?? []).map((row) => row.user_id)
  const profileByUserId = new Map<string, string | null>()
  if (userIds.length > 0) {
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('user_id, full_name')
      .in('user_id', userIds)
    if (profilesError) throw profilesError
    for (const p of profiles ?? []) profileByUserId.set(p.user_id, p.full_name)
  }

  return (data ?? []).map((row) => {
    const roles = row.roles as unknown as { key: string; name_ar: string } | null
    const branchRows = (row.membership_branches ?? []) as unknown as Array<{
      branches: { name: string } | null
    }>
    return {
      membershipId: row.id,
      userId: row.user_id,
      fullName: profileByUserId.get(row.user_id) ?? null,
      roleKey: roles?.key ?? '',
      roleNameAr: roles?.name_ar ?? '',
      status: row.status,
      branchNames: branchRows.map((b) => b.branches?.name).filter((n): n is string => !!n),
    }
  })
}

export function StaffPage() {
  const { t } = useTranslation()
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
      setFormError(t('staff.inviteError'))
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
    {
      key: 'name',
      header: t('staff.columns.name'),
      render: (r) =>
        r.fullName ?? <span className="text-text-secondary">{t('staff.notLoggedInYet')}</span>,
    },
    { key: 'role', header: t('staff.columns.role'), render: (r) => r.roleNameAr },
    {
      key: 'branches',
      header: t('staff.columns.branchScope'),
      render: (r) => (r.branchNames.length === 0 ? t('staff.allBranches') : r.branchNames.join(t('staff.branchListSeparator'))),
    },
    {
      key: 'status',
      header: t('staff.columns.status'),
      render: (r) =>
        r.status === 'active' ? (
          <StatusBadge tone="success" label={t('staff.statusActive')} />
        ) : (
          <StatusBadge tone="neutral" label={t('staff.statusInactive')} />
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
            {t('staff.deactivate')}
          </Button>
        ) : null,
    },
  ]

  return (
    <div>
      <PageHeader
        title={t('staff.title')}
        description={t('staff.description')}
        actions={
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>{t('staff.addStaff')}</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('staff.addStaff')}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleInviteSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="staff-email" className="text-sm font-medium text-text-secondary">
                    {t('staff.emailLabel')}
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
                  <label className="text-sm font-medium text-text-secondary">{t('staff.roleLabel')}</label>
                  <Select value={roleKey} onValueChange={setRoleKey}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ASSIGNABLE_ROLES.map((r) => (
                        <SelectItem key={r.key} value={r.key}>
                          {t(r.labelKey)}
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
                  {inviteMutation.isPending ? t('staff.adding') : t('staff.addStaff')}
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
        emptyTitle={t('staff.emptyTitle')}
        emptyDescription={t('staff.emptyDescription')}
      />
    </div>
  )
}
