import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
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
import {
  PERMISSION_GROUPS,
  ALL_CATALOG_KEYS,
  resolveDependencyClosure,
  resolveDependents,
  type PermissionGroupKey,
} from '@/lib/domain/permissionCatalog'
import { canSeeNavDomain, type NavDomain } from '@/lib/domain/navigation'

// STAFF ACCESS CONTROL & CUSTOM ROLES (2026-08-25) -- Stage 6.
//
// Roles list (system roles + this club's custom roles) -> Role Editor,
// matching the phase directive's exact requested shape: list shows
// Name / Employees count / Permissions count / Scope / System-or-custom
// / Active; the editor is groups-on-one-side, permissions-in-the-
// middle, live access summary alongside.
//
// Every mutation re-validates nothing client-side that the server
// doesn't ALSO enforce (escalation, tenant scope, name requirements) --
// this UI is a convenience layer, never the security boundary, per this
// whole phase's own explicit repeated instruction.

interface RoleRow {
  id: string
  nameAr: string
  nameEn: string
  description: string | null
  isActive: boolean
  isSystem: boolean
  employeeCount: number
  permissionCount: number
}

async function fetchRoles(clubId: string): Promise<RoleRow[]> {
  const { data, error } = await supabase.rpc('list_club_roles', { p_club_id: clubId })
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

async function fetchRolePermissions(roleId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc('get_club_role_permissions', { p_club_role_id: roleId })
  if (error) throw error
  return (data ?? []).map((row) => (typeof row === 'string' ? row : (row as { key: string }).key))
}

export function RolesPage() {
  const { t, i18n } = useTranslation()
  const { currentClubId, currentMembership } = useAuth()
  const queryClient = useQueryClient()
  const locale = i18n.language

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null)
  const [copyingRole, setCopyingRole] = useState<RoleRow | null>(null)
  const [copyName, setCopyName] = useState({ ar: '', en: '' })

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ['club-roles', currentClubId],
    queryFn: () => fetchRoles(currentClubId!),
    enabled: !!currentClubId,
  })

  const callerPermissions = useMemo(() => new Set(currentMembership?.permissionKeys ?? []), [currentMembership])

  const deleteMutation = useMutation({
    mutationFn: async (roleId: string) => {
      const { error } = await supabase.rpc('delete_club_role', { p_club_role_id: roleId })
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['club-roles', currentClubId] }),
  })

  const copyMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('copy_club_role', {
        p_club_role_id: copyingRole!.id,
        p_new_name_ar: copyName.ar,
        p_new_name_en: copyName.en,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setCopyingRole(null)
      setCopyName({ ar: '', en: '' })
      void queryClient.invalidateQueries({ queryKey: ['club-roles', currentClubId] })
    },
  })

  const [deleteError, setDeleteError] = useState<string | null>(null)

  function handleDelete(role: RoleRow) {
    setDeleteError(null)
    if (role.employeeCount > 0) {
      setDeleteError(t('roles.deleteBlockedInUse', { count: role.employeeCount }))
      return
    }
    deleteMutation.mutate(role.id, { onError: () => setDeleteError(t('roles.deleteError')) })
  }

  const columns: DataTableColumn<RoleRow>[] = [
    {
      key: 'name',
      header: t('roles.columns.name'),
      render: (r) => (
        <button
          className="text-accent-foreground hover:underline"
          onClick={() => {
            setEditingRoleId(r.isSystem ? null : r.id)
            if (!r.isSystem) setEditorOpen(true)
          }}
          disabled={r.isSystem}
        >
          {locale === 'en' ? r.nameEn : r.nameAr}
        </button>
      ),
    },
    {
      key: 'scope',
      header: t('roles.columns.scope'),
      render: (r) => (
        <Badge variant={r.isSystem ? 'secondary' : 'outline'}>
          {r.isSystem ? t('roles.scopeSystem') : t('roles.scopeCustom')}
        </Badge>
      ),
    },
    { key: 'employees', header: t('roles.columns.employees'), render: (r) => r.employeeCount },
    { key: 'permissions', header: t('roles.columns.permissions'), render: (r) => r.permissionCount },
    {
      key: 'status',
      header: t('roles.columns.status'),
      render: (r) =>
        r.isSystem || r.isActive ? (
          <StatusBadge tone="success" label={t('roles.active')} />
        ) : (
          <StatusBadge tone="neutral" label={t('roles.inactive')} />
        ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) =>
        r.isSystem ? null : (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setEditingRoleId(r.id); setEditorOpen(true) }}>
              {t('roles.edit')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setCopyingRole(r); setCopyName({ ar: '', en: '' }) }}>
              {t('roles.copy')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => handleDelete(r)} disabled={deleteMutation.isPending}>
              {t('roles.delete')}
            </Button>
          </div>
        ),
    },
  ]

  return (
    <div>
      <PageHeader
        title={t('roles.title')}
        description={t('roles.description')}
        actions={
          <Button onClick={() => { setEditingRoleId(null); setEditorOpen(true) }}>{t('roles.createRole')}</Button>
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
        emptyTitle={t('roles.emptyTitle')}
        emptyDescription={t('roles.emptyDescription')}
      />

      {editorOpen && (
        <RoleEditorDialog
          clubId={currentClubId!}
          roleId={editingRoleId}
          callerPermissions={callerPermissions}
          onClose={() => { setEditorOpen(false); setEditingRoleId(null) }}
          onSaved={() => {
            setEditorOpen(false)
            setEditingRoleId(null)
            void queryClient.invalidateQueries({ queryKey: ['club-roles', currentClubId] })
          }}
        />
      )}

      <Dialog open={!!copyingRole} onOpenChange={(open) => { if (!open) setCopyingRole(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('roles.copyDialogTitle', { name: copyingRole ? (locale === 'en' ? copyingRole.nameEn : copyingRole.nameAr) : '' })}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => { e.preventDefault(); copyMutation.mutate() }}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('roles.nameArLabel')}</label>
              <Input required value={copyName.ar} onChange={(e) => setCopyName((c) => ({ ...c, ar: e.target.value }))} dir="rtl" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('roles.nameEnLabel')}</label>
              <Input required value={copyName.en} onChange={(e) => setCopyName((c) => ({ ...c, en: e.target.value }))} dir="ltr" />
            </div>
            {copyMutation.isError && <p role="alert" className="text-sm text-status-danger">{t('roles.copyError')}</p>}
            <Button type="submit" disabled={copyMutation.isPending}>
              {copyMutation.isPending ? t('roles.saving') : t('roles.copy')}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// -----------------------------------------------------------------------
// Role Editor: groups on the side, permission checkboxes in the middle,
// a live access summary alongside. On mobile this collapses to a
// tabbed/stacked layout instead of forcing a 3-column squeeze (Section
// 22 of the phase directive) -- see the `md:grid-cols-[...]` breakpoint
// below, single column under it.
// -----------------------------------------------------------------------

function RoleEditorDialog({
  clubId,
  roleId,
  callerPermissions,
  onClose,
  onSaved,
}: {
  clubId: string
  roleId: string | null
  callerPermissions: ReadonlySet<string>
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const isEditing = !!roleId

  const { data: existingPermissions } = useQuery({
    queryKey: ['club-role-permissions', roleId],
    queryFn: () => fetchRolePermissions(roleId!),
    enabled: !!roleId,
  })
  const { data: existingRoles } = useQuery({
    queryKey: ['club-roles', clubId],
    queryFn: () => fetchRoles(clubId),
    enabled: !!roleId,
  })
  const existingRole = existingRoles?.find((r) => r.id === roleId) ?? null

  const [nameAr, setNameAr] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [initialized, setInitialized] = useState(false)
  const [activeGroup, setActiveGroup] = useState<PermissionGroupKey>('bookings')
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
      if (checked) {
        next.add(key)
        for (const dep of resolveDependencyClosure(next, key)) next.add(dep)
      } else {
        next.delete(key)
        for (const dependent of resolveDependents(next, key)) next.delete(dependent)
      }
      return next
    })
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const keys = Array.from(selected)
      if (isEditing) {
        const { error: err } = await supabase.rpc('update_club_role', {
          p_club_role_id: roleId!,
          p_name_ar: nameAr,
          p_name_en: nameEn,
          p_description: description,
          p_permission_keys: keys,
          p_is_active: true,
        })
        if (err) throw err
      } else {
        const { error: err } = await supabase.rpc('create_club_role', {
          p_club_id: clubId,
          p_name_ar: nameAr,
          p_name_en: nameEn,
          p_description: description,
          p_permission_keys: keys,
        })
        if (err) throw err
      }
    },
    onSuccess: onSaved,
    onError: () => setError(t('roles.saveError')),
  })

  function handleSubmit() {
    setError(null)
    if (!nameAr.trim() || !nameEn.trim()) {
      setError(t('roles.nameRequired'))
      return
    }
    saveMutation.mutate()
  }

  const activeGroupDef = PERMISSION_GROUPS.find((g) => g.key === activeGroup)!
  const selectedPermissionCount = ALL_CATALOG_KEYS.filter((k) => selected.has(k)).length

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? t('roles.editRole') : t('roles.createRole')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('roles.nameArLabel')}</label>
              <Input required value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('roles.nameEnLabel')}</label>
              <Input required value={nameEn} onChange={(e) => setNameEn(e.target.value)} dir="ltr" />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('roles.descriptionLabel')}</label>
            <textarea
              className="min-h-16 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>

          {/* Mobile: stacked group tabs (horizontal scroll) above the
              permission list, instead of a squeezed 3-column layout. */}
          <div className="flex gap-2 overflow-x-auto border-b border-border pb-2 md:hidden">
            {PERMISSION_GROUPS.filter((g) => g.permissions.length > 0).map((g) => (
              <button
                key={g.key}
                onClick={() => setActiveGroup(g.key)}
                className={`shrink-0 rounded-md px-3 py-1.5 text-sm ${activeGroup === g.key ? 'bg-accent text-accent-foreground' : 'bg-muted text-text-secondary'}`}
              >
                {t(`roles.groups.${g.key}`)}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-[180px_1fr_220px]">
            {/* Desktop: group nav column */}
            <div className="hidden flex-col gap-1 md:flex">
              {PERMISSION_GROUPS.filter((g) => g.permissions.length > 0).map((g) => {
                const groupSelectedCount = g.permissions.filter((p) => selected.has(p.key)).length
                return (
                  <button
                    key={g.key}
                    onClick={() => setActiveGroup(g.key)}
                    className={`flex items-center justify-between rounded-md px-3 py-2 text-start text-sm ${activeGroup === g.key ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'}`}
                  >
                    <span>{t(`roles.groups.${g.key}`)}</span>
                    {groupSelectedCount > 0 && (
                      <span className="text-xs text-text-secondary">{groupSelectedCount}</span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Middle: checkboxes for the active group */}
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{t(`roles.groups.${activeGroup}`)}</h3>
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    className="text-accent-foreground hover:underline"
                    onClick={() => {
                      const ownable = activeGroupDef.permissions.filter((p) => callerPermissions.has(p.key)).map((p) => p.key)
                      setSelected((current) => new Set([...current, ...ownable]))
                    }}
                  >
                    {t('roles.selectAllGroup')}
                  </button>
                  <button
                    type="button"
                    className="text-text-secondary hover:underline"
                    onClick={() => {
                      const groupKeys = new Set(activeGroupDef.permissions.map((p) => p.key))
                      setSelected((current) => new Set(Array.from(current).filter((k) => !groupKeys.has(k))))
                    }}
                  >
                    {t('roles.clearGroup')}
                  </button>
                </div>
              </div>
              {activeGroupDef.permissions.length === 0 && (
                <p className="text-sm text-text-secondary">{t('roles.groupEmpty')}</p>
              )}
              {activeGroupDef.permissions.map((perm) => {
                const ownedByCaller = callerPermissions.has(perm.key)
                return (
                  <label
                    key={perm.key}
                    className={`flex items-start gap-2 rounded-md p-2 text-sm ${ownedByCaller ? 'hover:bg-muted' : 'opacity-50'}`}
                    title={!ownedByCaller ? t('roles.cannotGrantHint') : undefined}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selected.has(perm.key)}
                      disabled={!ownedByCaller}
                      onChange={(e) => togglePermission(perm.key, e.target.checked)}
                    />
                    <span className="flex flex-col">
                      <span className="flex items-center gap-1.5">
                        {t(`permissions.${perm.key}.label`)}
                        {perm.sensitive && (
                          <Badge variant="destructive" className="text-[10px]">
                            {t('roles.sensitive')}
                          </Badge>
                        )}
                      </span>
                      <span className="text-xs text-text-secondary">{t(`permissions.${perm.key}.description`)}</span>
                      {!ownedByCaller && (
                        <span className="text-xs text-status-danger">{t('roles.cannotGrantHint')}</span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>

            {/* Right: live access summary */}
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <h3 className="text-sm font-semibold">{t('roles.summaryTitle')}</h3>
              <p className="text-sm text-text-secondary">
                {t('roles.summaryPermissionCount', { count: selectedPermissionCount })}
              </p>
              <div className="flex flex-col gap-1">
                {PERMISSION_GROUPS.filter((g) => g.permissions.some((p) => selected.has(p.key))).map((g) => (
                  <div key={g.key} className="text-xs">
                    <span className="font-medium">{t(`roles.groups.${g.key}`)}</span>
                    {': '}
                    <span className="text-text-secondary">
                      {g.permissions.filter((p) => selected.has(p.key)).length}/{g.permissions.length}
                    </span>
                  </div>
                ))}
              </div>
              {Array.from(selected).some((k) => PERMISSION_GROUPS.some((g) => g.permissions.some((p) => p.key === k && p.sensitive))) && (
                <div className="mt-2 rounded-md bg-status-danger/10 p-2 text-xs text-status-danger">
                  {t('roles.summarySensitiveWarning')}
                </div>
              )}
              <div className="mt-2 text-xs text-text-secondary">
                {t('roles.summaryNavHint')}
                {/* Uses the exact same canSeeNavDomain() derivation the
                    real app nav uses (navigation.ts) -- a live,
                    accurate preview of what this role would actually
                    see, not a second hand-maintained mapping that could
                    drift out of sync with it (Section 13 of the phase
                    directive: deterministic preview from the real
                    permission set, not a separate guess). */}
                <ul className="mt-1 list-inside list-disc">
                  {(['bookings', 'customers', 'academy', 'finance', 'reports', 'staff', 'settings', 'scan'] satisfies NavDomain[])
                    .filter((domain) => canSeeNavDomain(Array.from(selected), domain))
                    .map((domain) => (
                      <li key={domain}>{t(`roles.navDomains.${domain}`)}</li>
                    ))}
                </ul>
                {(['bookings', 'customers', 'academy', 'finance', 'reports', 'staff', 'settings', 'scan'] satisfies NavDomain[])
                  .every((domain) => !canSeeNavDomain(Array.from(selected), domain)) && (
                  <p className="mt-1 italic">{t('roles.summaryNoNavAccess')}</p>
                )}
              </div>
            </div>
          </div>

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
              {saveMutation.isPending ? t('roles.saving') : t('roles.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
