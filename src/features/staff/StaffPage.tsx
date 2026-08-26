import { useState, type FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { Badge } from '@/components/ui/badge'
import { MoneyDisplay } from '@/components/ui/money-display'
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
// to auth.users). The person must already have a Mal3aby account.
const ASSIGNABLE_ROLES = [
  { key: 'club_manager', labelKey: 'staff.roles.club_manager' },
  { key: 'branch_manager', labelKey: 'staff.roles.branch_manager' },
  { key: 'receptionist', labelKey: 'staff.roles.receptionist' },
  { key: 'accountant', labelKey: 'staff.roles.accountant' },
  { key: 'academy_manager', labelKey: 'staff.roles.academy_manager' },
  { key: 'coach', labelKey: 'staff.roles.coach' },
  { key: 'scanner', labelKey: 'staff.roles.scanner' },
]

interface BranchOption {
  id: string
  name: string
}

async function fetchBranches(clubId: string): Promise<BranchOption[]> {
  const { data, error } = await supabase
    .from('branches')
    .select('id, name')
    .eq('club_id', clubId)
    .eq('status', 'active')
    .order('created_at')
  if (error) throw error
  return data ?? []
}

// STAFF ACCESS CONTROL & CUSTOM ROLES (2026-08-25): active custom
// roles for this club, so the invite dialog can offer them alongside
// the fixed system-role list. Only fetched while the dialog is open
// (same lazy-load pattern as fetchBranches above).
interface CustomRoleOption {
  id: string
  nameAr: string
  nameEn: string
}

async function fetchActiveCustomRoles(clubId: string): Promise<CustomRoleOption[]> {
  const { data, error } = await supabase
    .from('club_roles')
    .select('id, name_ar, name_en')
    .eq('club_id', clubId)
    .eq('is_active', true)
    .order('name_ar')
  if (error) throw error
  return (data ?? []).map((r) => ({ id: r.id, nameAr: r.name_ar, nameEn: r.name_en }))
}

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
  // STAFF ACCESS CONTROL & CUSTOM ROLES (2026-08-25): a membership now
  // has EITHER `roles` OR `club_roles` set -- embedding only `roles`
  // silently showed a blank role for every custom-role staff member
  // (roles?.key ?? '' resolved to '', with no fallback).
  const { data, error } = await supabase
    .from('club_memberships')
    .select(
      'id, user_id, status, has_cash_custody, roles(key, name_ar), club_roles(id, name_ar), membership_branches(branches(name))',
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

  // FINAL PRODUCT COMPLETENESS ROUND (2026-08-25) -- Club Owner
  // persona: batched in one extra query for the whole list (same
  // pattern as the profiles batch above), never per-row.
  const liabilityByUserId = new Map<string, number>()
  if (userIds.length > 0) {
    const { data: liabilities, error: liabilitiesError } = await supabase
      .from('employee_cash_liabilities')
      .select('employee_id, outstanding')
      .eq('club_id', clubId)
      .eq('status', 'outstanding')
      .in('employee_id', userIds)
    if (liabilitiesError) throw liabilitiesError
    for (const l of liabilities ?? []) {
      liabilityByUserId.set(l.employee_id, (liabilityByUserId.get(l.employee_id) ?? 0) + Number(l.outstanding))
    }
  }

  return (data ?? []).map((row) => {
    const roles = row.roles as unknown as { key: string; name_ar: string } | null
    const customRole = row.club_roles as unknown as { id: string; name_ar: string } | null
    const branchRows = (row.membership_branches ?? []) as unknown as Array<{
      branches: { name: string } | null
    }>
    return {
      membershipId: row.id,
      userId: row.user_id,
      fullName: profileByUserId.get(row.user_id) ?? null,
      roleKey: roles?.key ?? '',
      roleNameAr: roles?.name_ar ?? customRole?.name_ar ?? '',
      isCustomRole: !!customRole,
      status: row.status,
      branchNames: branchRows.map((b) => b.branches?.name).filter((n): n is string => !!n),
      hasCashCustody: row.has_cash_custody,
      outstandingLiability: liabilityByUserId.get(row.user_id) ?? 0,
    }
  })
}

export function StaffPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [email, setEmail] = useState('')
  // STAFF ACCESS CONTROL & CUSTOM ROLES (2026-08-25): "roleSelection" is
  // either a system-role key (e.g. "receptionist") or "custom:<uuid>" --
  // a single <Select> covering both lists rather than a second control,
  // matching the phase directive's own request for the invite flow to
  // offer custom roles "alongside" the existing ones, not as a
  // secondary step.
  const [roleSelection, setRoleSelection] = useState('receptionist')
  const [allBranches, setAllBranches] = useState(false)
  const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>([])
  const [formError, setFormError] = useState<string | null>(null)

  const { data: staff = [], isLoading } = useQuery({
    queryKey: ['staff', currentClubId],
    queryFn: () => fetchStaff(currentClubId!),
    enabled: !!currentClubId,
  })
  const { data: branches = [] } = useQuery({
    queryKey: ['staff-assignable-branches', currentClubId],
    queryFn: () => fetchBranches(currentClubId!),
    enabled: !!currentClubId && dialogOpen,
  })
  const { data: customRoles = [] } = useQuery({
    queryKey: ['staff-assignable-custom-roles', currentClubId],
    queryFn: () => fetchActiveCustomRoles(currentClubId!),
    enabled: !!currentClubId && dialogOpen,
  })

  const inviteMutation = useMutation({
    mutationFn: async () => {
      const isCustom = roleSelection.startsWith('custom:')
      const { error } = await supabase.rpc('invite_staff_member', {
        p_club_id: currentClubId as string,
        p_email: email,
        p_role_key: isCustom ? undefined : roleSelection,
        p_custom_role_id: isCustom ? roleSelection.slice('custom:'.length) : undefined,
        p_branch_ids: allBranches ? [] : selectedBranchIds,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setDialogOpen(false)
      setEmail('')
      setRoleSelection('receptionist')
      setAllBranches(false)
      setSelectedBranchIds([])
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

  // Phase D (D1): explicit per-person cash-handling authorization,
  // independent of role -- owner/manager-only server-side (staff.update).
  const setCustodyMutation = useMutation({
    mutationFn: async ({ membershipId, hasCustody }: { membershipId: string; hasCustody: boolean }) => {
      const { error } = await supabase.rpc('set_staff_cash_custody', {
        p_membership_id: membershipId,
        p_has_custody: hasCustody,
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
    if (!allBranches && selectedBranchIds.length === 0) {
      setFormError(t('staff.branchRequired'))
      return
    }
    inviteMutation.mutate()
  }

  const columns: DataTableColumn<StaffRow>[] = [
    {
      key: 'name',
      header: t('staff.columns.name'),
      render: (r) => (
        <button className="text-accent-foreground hover:underline" onClick={() => navigate(`/app/staff/${r.membershipId}`)}>
          {r.fullName ?? <span className="text-text-secondary">{t('staff.notLoggedInYet')}</span>}
        </button>
      ),
    },
    {
      key: 'role',
      header: t('staff.columns.role'),
      render: (r) =>
        r.isCustomRole ? (
          <span className="inline-flex items-center gap-1">
            {r.roleNameAr}
            <Badge variant="outline" className="text-[10px]">{t('staff.customRoleBadge')}</Badge>
          </span>
        ) : (
          t(`staff.roles.${r.roleKey}`, { defaultValue: r.roleNameAr })
        ),
    },
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
      key: 'cashCustody',
      header: t('staff.columns.cashCustody'),
      render: (r) => (
        <Button
          variant={r.hasCashCustody ? 'default' : 'outline'}
          size="sm"
          onClick={() => setCustodyMutation.mutate({ membershipId: r.membershipId, hasCustody: !r.hasCashCustody })}
          disabled={setCustodyMutation.isPending}
        >
          {r.hasCashCustody ? t('staff.custodyEnabled') : t('staff.custodyDisabled')}
        </Button>
      ),
    },
    {
      // FINAL PRODUCT COMPLETENESS ROUND (2026-08-25) -- Club Owner
      // persona, explicit question: "هل هناك مبالغ بعهدته؟" -- real,
      // existing employee_cash_liabilities data, batched once for the
      // whole list. Only shown when non-zero (matches this app's own
      // exception-first convention elsewhere) rather than a permanent
      // "0 EGP" column for staff who never carry cash.
      key: 'liability',
      header: t('staff.columns.outstandingLiability'),
      render: (r) => (r.outstandingLiability > 0 ? <MoneyDisplay amount={r.outstandingLiability} size="sm" tone="danger" /> : '—'),
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
        // AUTH ACCESS HOTFIX (2026-08-26): Roles & Permissions was fully
        // built (RolesPage.tsx, route /app/staff/roles, correct
        // RequireNavDomain="staff" guard already allowing any staff-
        // domain-visible user through) but had exactly ONE entry point in
        // the whole app -- a small text link buried inside the "Add
        // Staff" invite dialog's role dropdown, only ever seen by someone
        // already mid-invite. A club owner just wanting to review/edit
        // roles had no discoverable path and no reason to know the direct
        // URL. This adds a real, top-level "Manage roles" button next to
        // "Add Staff" on the Staff page itself -- the existing invite-
        // dialog link is left in place unchanged (still useful mid-invite,
        // now simply a second path to the same already-correct page,
        // never a duplicate ROUTE or component).
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/app/staff/roles">{t('staff.manageRolesLink')}</Link>
            </Button>
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
                  <Select value={roleSelection} onValueChange={setRoleSelection}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ASSIGNABLE_ROLES.map((r) => (
                        <SelectItem key={r.key} value={r.key}>
                          {t(r.labelKey)}
                        </SelectItem>
                      ))}
                      {customRoles.map((r) => (
                        <SelectItem key={r.id} value={`custom:${r.id}`}>
                          {t('staff.customRoleOption', { name: r.nameAr })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Link to="/app/staff/roles" className="text-xs text-accent-foreground hover:underline">
                    {t('staff.manageRolesLink')}
                  </Link>
                </div>
                <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <legend className="px-1 text-sm font-medium text-text-secondary">{t('staff.branchScopeLabel')}</legend>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={allBranches}
                      onChange={(e) => {
                        setAllBranches(e.target.checked)
                        if (e.target.checked) setSelectedBranchIds([])
                      }}
                    />
                    {t('staff.allBranches')}
                  </label>
                  {!allBranches && branches.map((branch) => (
                    <label key={branch.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedBranchIds.includes(branch.id)}
                        onChange={(e) => setSelectedBranchIds((current) => (
                          e.target.checked
                            ? [...current, branch.id]
                            : current.filter((id) => id !== branch.id)
                        ))}
                      />
                      {branch.name}
                    </label>
                  ))}
                </fieldset>
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
          </>
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
