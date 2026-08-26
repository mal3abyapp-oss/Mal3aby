import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// PLATFORM ROLES & PERMISSIONS (2026-08-26) -- the platform-side twin of
// src/features/staff/RolesPage.tsx, deliberately kept as a SEPARATE
// screen/authorization domain (directive Section 1/23: platform roles
// must never be mixed with club roles, and this domain routes entirely
// through has_platform_permission()/the platform_roles/
// platform_custom_roles tables -- never has_permission()/club_roles).
// The overall UI shape (list -> editor dialog, groups-on-the-side +
// checkboxes-in-the-middle + live summary) intentionally mirrors
// RolesPage.tsx's own already-accepted pattern for consistency, but is
// its own independent component -- not a shared/parameterized one --
// since the underlying RPCs, permission catalog shape, and system-role
// protection story all genuinely differ (platform roles have no
// club_id, no branch scope, no custom-role-vs-system split via
// club_memberships.custom_role_id).

const PLATFORM_PERMISSION_GROUPS = ['clubs', 'staff', 'roles', 'finance', 'support', 'audit', 'settings'] as const
type PlatformPermissionGroupKey = (typeof PLATFORM_PERMISSION_GROUPS)[number]

interface PlatformRoleRow {
  id: string
  nameAr: string
  nameEn: string
  description: string | null
  isActive: boolean
  isSystem: boolean
  employeeCount: number
  permissionCount: number
}

interface PlatformPermissionRow {
  key: string
  groupKey: PlatformPermissionGroupKey
}

async function fetchPlatformRoles(): Promise<PlatformRoleRow[]> {
  const { data, error } = await supabase.rpc('list_platform_roles')
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    description: r.description,
    isActive: r.is_active,
    isSystem: r.is_system,
    employeeCount: Number(r.employee_count),
    permissionCount: Number(r.permission_count),
  }))
}

async function fetchPlatformRolePermissions(roleId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc('get_platform_role_permissions', { p_role_id: roleId })
  if (error) throw error
  return (data ?? []).map((row) => (typeof row === 'string' ? row : (row as { key: string }).key))
}

async function fetchPlatformPermissionCatalog(): Promise<PlatformPermissionRow[]> {
  const { data, error } = await supabase.from('platform_permissions').select('key, group_key')
  if (error) throw error
  return (data ?? []).map((p) => ({ key: p.key, groupKey: p.group_key as PlatformPermissionGroupKey }))
}

async function fetchCallerPlatformPermissionKeys(): Promise<string[]> {
  const { data, error } = await supabase.rpc('caller_platform_permission_keys')
  if (error) throw error
  return (data ?? []).map((row) => (typeof row === 'string' ? row : (row as { key: string }).key))
}

export function PlatformRolesPage() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const locale = i18n.language

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null)
  const [viewingSystemRole, setViewingSystemRole] = useState<PlatformRoleRow | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ['platform-roles'],
    queryFn: fetchPlatformRoles,
  })
  const { data: callerKeys = [] } = useQuery({
    queryKey: ['caller-platform-permission-keys'],
    queryFn: fetchCallerPlatformPermissionKeys,
  })
  const callerPermissions = useMemo(() => new Set(callerKeys), [callerKeys])

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['platform-roles'] })
  }

  const deleteMutation = useMutation({
    mutationFn: async (roleId: string) => {
      const { error } = await supabase.rpc('delete_platform_custom_role', { p_role_id: roleId })
      if (error) throw error
    },
    onSuccess: invalidate,
  })

  function handleDelete(role: PlatformRoleRow) {
    setDeleteError(null)
    if (role.employeeCount > 0) {
      setDeleteError(t('platformRoles.deleteBlockedInUse', { count: role.employeeCount }))
      return
    }
    deleteMutation.mutate(role.id, { onError: () => setDeleteError(t('platformRoles.deleteError')) })
  }

  const columns: DataTableColumn<PlatformRoleRow>[] = [
    {
      key: 'name',
      header: t('platformRoles.columns.name'),
      render: (r) => (
        <button
          className="text-accent-foreground hover:underline"
          onClick={() => {
            if (r.isSystem) {
              setViewingSystemRole(r)
            } else {
              setEditingRoleId(r.id)
              setEditorOpen(true)
            }
          }}
        >
          {locale === 'en' ? r.nameEn : r.nameAr}
        </button>
      ),
    },
    {
      key: 'scope',
      header: t('platformRoles.columns.scope'),
      render: (r) => (
        <Badge variant={r.isSystem ? 'secondary' : 'outline'}>
          {r.isSystem ? t('platformRoles.scopeSystem') : t('platformRoles.scopeCustom')}
        </Badge>
      ),
    },
    { key: 'employees', header: t('platformRoles.columns.employees'), render: (r) => r.employeeCount },
    { key: 'permissions', header: t('platformRoles.columns.permissions'), render: (r) => r.permissionCount },
    {
      key: 'status',
      header: t('platformRoles.columns.status'),
      render: (r) =>
        r.isSystem || r.isActive ? (
          <StatusBadge tone="success" label={t('platformRoles.active')} />
        ) : (
          <StatusBadge tone="neutral" label={t('platformRoles.inactive')} />
        ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) =>
        r.isSystem ? (
          <Button variant="ghost" size="sm" onClick={() => setViewingSystemRole(r)}>
            {t('platformRoles.view')}
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setEditingRoleId(r.id); setEditorOpen(true) }}>
              {t('platformRoles.edit')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleDelete(r)} disabled={deleteMutation.isPending}>
              {t('platformRoles.delete')}
            </Button>
          </div>
        ),
    },
  ]

  return (
    <div>
      <PageHeader
        title={t('platformRoles.title')}
        description={t('platformRoles.description')}
        actions={
          <Button onClick={() => { setEditingRoleId(null); setEditorOpen(true) }}>{t('platformRoles.createRole')}</Button>
        }
      />

      {deleteError && (
        <p role="alert" className="mb-3 text-sm text-status-danger">
          {deleteError}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={roles}
        rowKey={(r) => r.id}
        isLoading={isLoading}
        emptyTitle={t('platformRoles.emptyTitle')}
        emptyDescription={t('platformRoles.emptyDescription')}
      />

      {editorOpen && (
        <PlatformRoleEditorDialog
          roleId={editingRoleId}
          callerPermissions={callerPermissions}
          onClose={() => { setEditorOpen(false); setEditingRoleId(null) }}
          onSaved={() => {
            setEditorOpen(false)
            setEditingRoleId(null)
            invalidate()
          }}
        />
      )}

      {viewingSystemRole && (
        <PlatformSystemRoleViewDialog
          role={viewingSystemRole}
          locale={locale}
          onClose={() => setViewingSystemRole(null)}
        />
      )}
    </div>
  )
}

// Read-only view for a protected system platform role -- same rationale
// as RolesPage.tsx's SystemRoleViewDialog (a protected role must always
// explain itself, never silently do nothing when clicked). Platform
// Owner is the one role that can never be casually edited/deleted at
// all (directive Section 2/9: "Protected Platform Owner role: cannot be
// casually removed"), so unlike the club-side version there is no
// "Copy this role" CTA here -- copying platform_owner's full-access
// permission set into a new custom role would itself be a real
// escalation surface, deliberately not offered.
function PlatformSystemRoleViewDialog({
  role,
  locale,
  onClose,
}: {
  role: PlatformRoleRow
  locale: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { data: permissionKeys = [], isLoading: permsLoading } = useQuery({
    queryKey: ['platform-role-permissions', role.id],
    queryFn: () => fetchPlatformRolePermissions(role.id),
  })
  const { data: catalog = [] } = useQuery({
    queryKey: ['platform-permission-catalog'],
    queryFn: fetchPlatformPermissionCatalog,
  })
  const selected = useMemo(() => new Set(permissionKeys), [permissionKeys])
  const name = locale === 'en' ? role.nameEn : role.nameAr

  const byGroup = useMemo(() => {
    const map = new Map<PlatformPermissionGroupKey, string[]>()
    for (const p of catalog) {
      if (!selected.has(p.key)) continue
      const list = map.get(p.groupKey) ?? []
      list.push(p.key)
      map.set(p.groupKey, list)
    }
    return map
  }, [catalog, selected])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('platformRoles.systemRoleViewTitle', { name })}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-text-secondary">
            {role.nameEn === 'Platform Owner'
              ? t('platformRoles.platformOwnerProtectedExplanation')
              : t('platformRoles.systemRoleViewExplanation')}
          </div>

          {permsLoading ? (
            <p className="text-sm text-text-secondary">{t('common.loading')}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {PLATFORM_PERMISSION_GROUPS.filter((g) => (byGroup.get(g) ?? []).length > 0).map((g) => (
                <div key={g} className="rounded-md border border-border p-3">
                  <h3 className="mb-2 text-sm font-semibold">{t(`platformRoles.groups.${g}`)}</h3>
                  <ul className="flex flex-col gap-1.5">
                    {(byGroup.get(g) ?? []).map((key) => (
                      <li key={key} className="flex items-center gap-1.5 text-sm text-text-secondary">
                        <span className="size-1.5 shrink-0 rounded-full bg-accent-foreground" />
                        {t(`platformPermissions.${key}.label`)}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {selected.size === 0 && (
                <p className="text-sm text-text-secondary">{t('platformRoles.groupEmpty')}</p>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PlatformRoleEditorDialog({
  roleId,
  callerPermissions,
  onClose,
  onSaved,
}: {
  roleId: string | null
  callerPermissions: ReadonlySet<string>
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const isEditing = !!roleId

  const { data: existingPermissions } = useQuery({
    queryKey: ['platform-role-permissions', roleId],
    queryFn: () => fetchPlatformRolePermissions(roleId!),
    enabled: !!roleId,
  })
  const { data: existingRoles } = useQuery({
    queryKey: ['platform-roles'],
    queryFn: fetchPlatformRoles,
    enabled: !!roleId,
  })
  const { data: catalog = [] } = useQuery({
    queryKey: ['platform-permission-catalog'],
    queryFn: fetchPlatformPermissionCatalog,
  })
  const existingRole = existingRoles?.find((r) => r.id === roleId) ?? null

  const [nameAr, setNameAr] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [initialized, setInitialized] = useState(false)
  const [activeGroup, setActiveGroup] = useState<PlatformPermissionGroupKey>('clubs')
  const [error, setError] = useState<string | null>(null)

  if (!initialized && (!isEditing || (existingPermissions && existingRole))) {
    if (isEditing && existingRole && existingPermissions) {
      setNameAr(existingRole.nameAr)
      setNameEn(existingRole.nameEn)
      setDescription(existingRole.description ?? '')
      setSelected(new Set(existingPermissions))
    }
    setInitialized(true)
  }

  function togglePermission(key: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const keys = Array.from(selected)
      if (isEditing) {
        const { error: err } = await supabase.rpc('update_platform_custom_role', {
          p_role_id: roleId!,
          p_name_ar: nameAr,
          p_name_en: nameEn,
          p_description: description,
          p_permission_keys: keys,
          p_is_active: true,
        })
        if (err) throw err
      } else {
        const { error: err } = await supabase.rpc('create_platform_custom_role', {
          p_name_ar: nameAr,
          p_name_en: nameEn,
          p_description: description,
          p_permission_keys: keys,
        })
        if (err) throw err
      }
    },
    onSuccess: onSaved,
    onError: () => setError(t('platformRoles.saveError')),
  })

  function handleSubmit() {
    setError(null)
    if (!nameAr.trim() || !nameEn.trim()) {
      setError(t('platformRoles.nameRequired'))
      return
    }
    saveMutation.mutate()
  }

  const groupPermissions = useMemo(
    () => catalog.filter((p) => p.groupKey === activeGroup),
    [catalog, activeGroup],
  )
  const selectedPermissionCount = catalog.filter((p) => selected.has(p.key)).length

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] w-full max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? t('platformRoles.editRole') : t('platformRoles.createRole')}</DialogTitle>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('platformRoles.nameArLabel')}</label>
              <Input required value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('platformRoles.nameEnLabel')}</label>
              <Input required value={nameEn} onChange={(e) => setNameEn(e.target.value)} dir="ltr" />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('platformRoles.descriptionLabel')}</label>
            <textarea
              className="min-h-16 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>

          <div className="flex gap-2 overflow-x-auto border-b border-border pb-2 md:hidden">
            {PLATFORM_PERMISSION_GROUPS.map((g) => (
              <button
                key={g}
                onClick={() => setActiveGroup(g)}
                className={`shrink-0 rounded-md px-3 py-1.5 text-sm ${activeGroup === g ? 'bg-accent text-accent-foreground' : 'bg-muted text-text-secondary'}`}
              >
                {t(`platformRoles.groups.${g}`)}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-[180px_1fr]">
            <div className="hidden flex-col gap-1 md:flex">
              {PLATFORM_PERMISSION_GROUPS.map((g) => {
                const groupSelectedCount = catalog.filter((p) => p.groupKey === g && selected.has(p.key)).length
                return (
                  <button
                    key={g}
                    onClick={() => setActiveGroup(g)}
                    className={`flex items-center justify-between rounded-md px-3 py-2 text-start text-sm ${activeGroup === g ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`}
                  >
                    <span>{t(`platformRoles.groups.${g}`)}</span>
                    {groupSelectedCount > 0 && (
                      <span className="text-xs text-text-secondary">{groupSelectedCount}</span>
                    )}
                  </button>
                )
              })}
            </div>

            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <h3 className="text-sm font-semibold">{t(`platformRoles.groups.${activeGroup}`)}</h3>
              {groupPermissions.length === 0 && (
                <p className="text-sm text-text-secondary">{t('platformRoles.groupEmpty')}</p>
              )}
              {groupPermissions.map((perm) => {
                const ownedByCaller = callerPermissions.has(perm.key)
                return (
                  <label
                    key={perm.key}
                    className={`flex items-start gap-2 rounded-md p-2 text-sm ${ownedByCaller ? 'hover:bg-muted' : 'opacity-50'}`}
                    title={!ownedByCaller ? t('platformRoles.cannotGrantHint') : undefined}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selected.has(perm.key)}
                      disabled={!ownedByCaller}
                      onChange={(e) => togglePermission(perm.key, e.target.checked)}
                    />
                    <span className="flex flex-col">
                      <span>{t(`platformPermissions.${perm.key}.label`)}</span>
                      <span className="text-xs text-text-secondary">{t(`platformPermissions.${perm.key}.description`)}</span>
                      {!ownedByCaller && (
                        <span className="text-xs text-status-danger">{t('platformRoles.cannotGrantHint')}</span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>

          <p className="text-sm text-text-secondary">{t('platformRoles.summaryPermissionCount', { count: selectedPermissionCount })}</p>

          {error && (
            <p role="alert" className="text-sm text-status-danger">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSubmit} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? t('platformRoles.saving') : t('platformRoles.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
