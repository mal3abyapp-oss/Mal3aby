import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
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
} from '@/components/ui/dialog'
import { translateSupabaseError } from '@/lib/errors'

// PLATFORM STAFF (2026-08-26) -- directive Section 3/4: employees of the
// platform itself (not club staff, not customers), identity-linked to a
// real auth.users account, managed entirely separately from Club Staff
// (StaffPage.tsx) via the platform_staff_memberships table and its own
// has_platform_permission() authorization domain.
//
// Auth-user creation/email-change/password-reset genuinely require the
// Supabase Admin API (service_role) -- browser code can never do this
// directly -- so those three actions go through the platform-staff-admin
// Edge Function (mirrors this project's own existing
// activate-portal-account convention exactly: the function re-derives
// the caller's real identity from their own JWT and checks
// has_platform_permission_as() server-side before touching anything;
// this page never trusts a client-side permission check as the real
// boundary, same as every other privileged action in this app).

interface PlatformStaffRow {
  membershipId: string
  userId: string
  email: string
  fullName: string | null
  platformRoleId: string | null
  platformRoleKey: string | null
  roleNameAr: string
  roleNameEn: string
  isCustomRole: boolean
  status: string
  createdAt: string
}

interface PlatformRoleOption {
  id: string
  nameAr: string
  nameEn: string
  isSystem: boolean
}

async function fetchPlatformStaff(): Promise<PlatformStaffRow[]> {
  const { data, error } = await supabase.rpc('list_platform_staff')
  if (error) throw error
  return (data ?? []).map((r) => ({
    membershipId: r.membership_id,
    userId: r.user_id,
    email: r.email,
    fullName: r.full_name,
    platformRoleId: r.platform_role_id,
    platformRoleKey: r.platform_role_key,
    roleNameAr: r.role_name_ar,
    roleNameEn: r.role_name_en,
    isCustomRole: r.is_custom_role,
    status: r.status,
    createdAt: r.created_at,
  }))
}

async function fetchPlatformRoleOptions(): Promise<PlatformRoleOption[]> {
  const { data, error } = await supabase.rpc('list_platform_roles')
  if (error) throw error
  return (data ?? [])
    .filter((r) => r.is_active)
    .map((r) => ({ id: r.id, nameAr: r.name_ar, nameEn: r.name_en, isSystem: r.is_system }))
}

async function invokeStaffAdmin<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>('platform-staff-admin', {
    body: { action, ...body },
  })
  if (error) throw error
  if (data && 'error' in data && data.error) throw new Error(data.error)
  return data as T
}

export function PlatformStaffPage() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const queryClient = useQueryClient()

  const [addOpen, setAddOpen] = useState(false)
  const [roleAssignFor, setRoleAssignFor] = useState<PlatformStaffRow | null>(null)
  const [setupLink, setSetupLink] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Finding H-2 (frozen production audit): this list previously
  // destructured only `data = [], isLoading` -- a failed fetch silently
  // rendered as "no platform staff" via DataTable's own empty state,
  // indistinguishable from a platform that genuinely has none. isError/
  // error/refetch are now surfaced.
  const { data: staff = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['platform-staff'],
    queryFn: fetchPlatformStaff,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['platform-staff'] })
  }

  const deactivateMutation = useMutation({
    mutationFn: async (membershipId: string) => {
      const { error } = await supabase.rpc('deactivate_platform_staff', { p_membership_id: membershipId })
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => setActionError(translateSupabaseError(err, t('platformStaff.deactivateError'))),
  })

  const resetPasswordMutation = useMutation({
    mutationFn: (row: PlatformStaffRow) => invokeStaffAdmin<{ reset_link: string | null }>('reset_password', { target_user_id: row.userId }),
    onSuccess: (data) => {
      if (data.reset_link) setSetupLink(data.reset_link)
    },
    onError: (err) => setActionError(translateSupabaseError(err, t('platformStaff.resetPasswordError'))),
  })

  const columns: DataTableColumn<PlatformStaffRow>[] = [
    {
      key: 'name',
      header: t('platformStaff.columns.employee'),
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-medium">{r.fullName ?? r.email}</span>
          <span className="text-xs text-text-secondary" dir="ltr">{r.email}</span>
        </div>
      ),
    },
    {
      key: 'role',
      header: t('platformStaff.columns.role'),
      render: (r) => (
        <div className="flex items-center gap-2">
          <span>{locale === 'en' ? r.roleNameEn : r.roleNameAr}</span>
          {r.isCustomRole && <StatusBadge tone="neutral" label={t('platformRoles.scopeCustom')} />}
        </div>
      ),
    },
    {
      key: 'status',
      header: t('platformStaff.columns.status'),
      render: (r) => (
        <StatusBadge
          tone={r.status === 'active' ? 'success' : 'neutral'}
          label={r.status === 'active' ? t('platformStaff.active') : t('platformStaff.inactive')}
        />
      ),
    },
    {
      key: 'createdAt',
      header: t('platformStaff.columns.createdAt'),
      render: (r) => <span className="tabular-nums"><bdi>{new Date(r.createdAt).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi></span>,
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={() => setRoleAssignFor(r)}>
            {t('platformStaff.changeRole')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={resetPasswordMutation.isPending}
            onClick={() => { setActionError(null); resetPasswordMutation.mutate(r) }}
          >
            {t('platformStaff.resetPassword')}
          </Button>
          {r.status === 'active' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={deactivateMutation.isPending}
              onClick={() => { setActionError(null); deactivateMutation.mutate(r.membershipId) }}
            >
              {t('platformStaff.deactivate')}
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title={t('platformStaff.title')}
        description={t('platformStaff.description')}
        actions={<Button onClick={() => setAddOpen(true)}>{t('platformStaff.addEmployee')}</Button>}
      />

      {actionError && (
        <p role="alert" className="mb-3 text-sm text-status-danger">{actionError}</p>
      )}

      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('platformStaff.loadError'))} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={staff}
          rowKey={(r) => r.membershipId}
          isLoading={isLoading}
          emptyTitle={t('platformStaff.emptyTitle')}
          emptyDescription={t('platformStaff.emptyDescription')}
        />
      )}

      {addOpen && (
        <AddPlatformEmployeeDialog
          onClose={() => setAddOpen(false)}
          onCreated={(link) => {
            setAddOpen(false)
            invalidate()
            if (link) setSetupLink(link)
          }}
        />
      )}

      {roleAssignFor && (
        <ChangeRoleDialog
          row={roleAssignFor}
          onClose={() => setRoleAssignFor(null)}
          onSaved={() => { setRoleAssignFor(null); invalidate() }}
        />
      )}

      {setupLink && (
        <Dialog open onOpenChange={(open) => { if (!open) setSetupLink(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('platformStaff.setupLinkTitle')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-secondary">{t('platformStaff.setupLinkHint')}</p>
              <Input readOnly dir="ltr" value={setupLink} onFocus={(e) => e.target.select()} />
              <div className="flex justify-end">
                <Button onClick={() => setSetupLink(null)}>{t('common.close', { defaultValue: t('common.cancel') })}</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function AddPlatformEmployeeDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (setupLink: string | null) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [roleId, setRoleId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const { data: roleOptions = [] } = useQuery({
    queryKey: ['platform-role-options'],
    queryFn: fetchPlatformRoleOptions,
  })

  const createMutation = useMutation({
    mutationFn: () =>
      invokeStaffAdmin<{ membership_id: string; user_id: string; setup_link: string | null }>('create', {
        email,
        full_name: fullName.trim() || undefined,
        platform_role_id: roleId,
      }),
    onSuccess: (data) => onCreated(data.setup_link),
    onError: (err) => setError(err instanceof Error ? err.message : t('platformStaff.createError')),
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('platformStaff.addEmployee')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); setError(null); createMutation.mutate() }} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('platformStaff.fullNameLabel')}</label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('platformStaff.emailLabel')}</label>
            <Input type="email" required dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('platformStaff.roleLabel')}</label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger><SelectValue placeholder={t('platformStaff.rolePlaceholder')} /></SelectTrigger>
              <SelectContent>
                {roleOptions.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {locale === 'en' ? r.nameEn : r.nameAr}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <Button type="submit" disabled={!email || !roleId || createMutation.isPending}>
            {createMutation.isPending ? t('platformStaff.creating') : t('platformStaff.addEmployee')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ChangeRoleDialog({
  row,
  onClose,
  onSaved,
}: {
  row: PlatformStaffRow
  onClose: () => void
  onSaved: () => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const [roleId, setRoleId] = useState(row.platformRoleId ?? '')
  const [error, setError] = useState<string | null>(null)

  const { data: roleOptions = [] } = useQuery({
    queryKey: ['platform-role-options'],
    queryFn: fetchPlatformRoleOptions,
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      const chosen = roleOptions.find((r) => r.id === roleId)
      const { error: err } = await supabase.rpc('set_platform_staff_role', {
        p_membership_id: row.membershipId,
        p_platform_role_id: chosen?.isSystem ? roleId : undefined,
        p_platform_custom_role_id: chosen && !chosen.isSystem ? roleId : undefined,
      })
      if (err) throw err
    },
    onSuccess: onSaved,
    onError: (err) => setError(translateSupabaseError(err, t('platformStaff.changeRoleError'))),
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('platformStaff.changeRoleTitle', { name: row.fullName ?? row.email })}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Select value={roleId} onValueChange={setRoleId}>
            <SelectTrigger><SelectValue placeholder={t('platformStaff.rolePlaceholder')} /></SelectTrigger>
            <SelectContent>
              {roleOptions.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {locale === 'en' ? r.nameEn : r.nameAr}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
            <Button disabled={!roleId || saveMutation.isPending} onClick={() => { setError(null); saveMutation.mutate() }}>
              {saveMutation.isPending ? t('platformStaff.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
