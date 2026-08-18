import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ProgramsGroupsSection } from '@/features/academy/ProgramsGroupsSection'
import { EnrollmentSection } from '@/features/academy/EnrollmentSection'
import { CoachTodayView } from '@/features/academy/CoachTodayView'
import { AcademyOverview } from '@/features/academy/AcademyOverview'
import { PlayerStatusPanel } from '@/features/academy/PlayerStatusPanel'
import type { PlayerRow, GuardianLinkRow } from '@/lib/domain/people'

// Player Profile lives under /app/academy per SCREEN_MAP.md. Full
// Programs/Groups/Sessions/Enrollment is Phase 10-12's scope -- this is
// the concrete Phase 4 deliverable (player CRUD + guardian linking UI)
// placed on its documented route ahead of the rest of the phase.
async function fetchPlayers(clubId: string, search: string) {
  let query = supabase
    .from('players_safe')
    .select('id, full_name, date_of_birth, gender, status')
    .eq('club_id', clubId)
    .order('full_name')
    .limit(50)

  if (search.trim()) {
    query = query.ilike('full_name', `%${search}%`)
  }

  const { data, error } = await query
  if (error) throw error

  return (data ?? [])
    .filter((row): row is typeof row & { id: string; full_name: string; status: string } => !!row.id && !!row.full_name && !!row.status)
    .map<PlayerRow>((row) => ({
      id: row.id,
      fullName: row.full_name,
      dateOfBirth: row.date_of_birth,
      gender: row.gender,
      status: row.status,
    }))
}

async function fetchGuardianLinks(playerId: string) {
  const { data, error } = await supabase
    .from('guardian_links')
    .select('id, customer_id, player_id, relationship, is_primary, customers(full_name)')
    .eq('player_id', playerId)

  if (error) throw error

  return (data ?? []).map<GuardianLinkRow>((row) => ({
    id: row.id,
    customerId: row.customer_id,
    playerId: row.player_id,
    customerName: (row.customers as unknown as { full_name: string } | null)?.full_name ?? '—',
    relationship: row.relationship,
    isPrimary: row.is_primary,
  }))
}

async function searchCustomers(clubId: string, search: string) {
  if (!search.trim()) return []
  const { data, error } = await supabase
    .from('customers')
    .select('id, full_name, mobile_display')
    .eq('club_id', clubId)
    .ilike('full_name', `%${search}%`)
    .limit(10)
  if (error) throw error
  return data ?? []
}

export function AcademyPage() {
  const { t } = useTranslation()
  const { currentClubId, currentMembership } = useAuth()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<'overview' | 'players' | 'structure' | 'enrollments'>('overview')
  const [search, setSearch] = useState('')
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [playerName, setPlayerName] = useState('')
  const [playerDob, setPlayerDob] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const [selectedPlayer, setSelectedPlayer] = useState<PlayerRow | null>(null)
  const [playerQrDataUrl, setPlayerQrDataUrl] = useState<string | null>(null)
  const [guardianSearch, setGuardianSearch] = useState('')
  const [selectedGuardianId, setSelectedGuardianId] = useState('')
  const [relationship, setRelationship] = useState('father')

  const RELATIONSHIP_LABELS: Record<string, string> = {
    father: t('academy.relationshipLabels.father'),
    mother: t('academy.relationshipLabels.mother'),
    guardian: t('academy.relationshipLabels.guardian'),
    other: t('academy.relationshipLabels.other'),
  }

  // V1 Implementation Gap Audit (2026-08-16): the player detail dialog
  // showed only guardians + QR -- no way to correct a player's own name/
  // DOB/gender, or reactivate one marked inactive. Editable fields
  // populated from selectedPlayer whenever it changes (see the dialog's
  // onOpenChange below).
  const [editName, setEditName] = useState('')
  const [editDob, setEditDob] = useState('')
  const [editGender, setEditGender] = useState('')
  const [editStatus, setEditStatus] = useState('active')

  const { data: players = [], isLoading } = useQuery({
    queryKey: ['players', currentClubId, search],
    queryFn: () => fetchPlayers(currentClubId!, search),
    enabled: !!currentClubId,
  })

  const { data: guardianLinks = [] } = useQuery({
    queryKey: ['guardian-links', selectedPlayer?.id],
    queryFn: () => fetchGuardianLinks(selectedPlayer!.id),
    enabled: !!selectedPlayer,
  })

  const { data: guardianCandidates = [] } = useQuery({
    queryKey: ['guardian-candidates', currentClubId, guardianSearch],
    queryFn: () => searchCustomers(currentClubId!, guardianSearch),
    enabled: !!currentClubId && guardianSearch.trim().length > 0,
  })

  const createPlayerMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('players').insert({
        club_id: currentClubId as string,
        full_name: playerName,
        date_of_birth: playerDob || null,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setCreateDialogOpen(false)
      setPlayerName('')
      setPlayerDob('')
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['players', currentClubId] })
    },
    onError: () => setFormError(t('academy.players.addError')),
  })

  const linkGuardianMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPlayer || !selectedGuardianId) throw new Error('missing input')
      const { error } = await supabase.from('guardian_links').insert({
        customer_id: selectedGuardianId,
        player_id: selectedPlayer.id,
        relationship,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setGuardianSearch('')
      setSelectedGuardianId('')
      void queryClient.invalidateQueries({ queryKey: ['guardian-links', selectedPlayer?.id] })
    },
  })

  const updatePlayerMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPlayer) throw new Error('no player selected')
      const { error } = await supabase
        .from('players')
        .update({
          full_name: editName,
          date_of_birth: editDob || null,
          gender: editGender || null,
          status: editStatus,
        })
        .eq('id', selectedPlayer.id)
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['players', currentClubId] })
      setSelectedPlayer(null)
    },
  })

  const playerQrMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPlayer) throw new Error('no player selected')
      const { data, error } = await supabase.rpc('ensure_player_qr', { p_player_id: selectedPlayer.id })
      if (error) throw error
      return data as string
    },
    onSuccess: async (rawToken) => {
      const dataUrl = await QRCode.toDataURL(rawToken, { width: 220, margin: 1 })
      setPlayerQrDataUrl(dataUrl)
    },
  })

  function handleCreateSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    createPlayerMutation.mutate()
  }

  const columns: DataTableColumn<PlayerRow>[] = [
    {
      key: 'name',
      header: t('common.name'),
      render: (p) => (
        <button
          className="text-accent-foreground hover:underline"
          onClick={() => {
            setSelectedPlayer(p)
            setEditName(p.fullName)
            setEditDob(p.dateOfBirth ?? '')
            setEditGender(p.gender ?? '')
            setEditStatus(p.status)
          }}
        >
          {p.fullName}
        </button>
      ),
    },
    { key: 'dob', header: t('academy.players.dateOfBirth'), render: (p) => p.dateOfBirth ?? '—' },
    { key: 'status', header: t('academy.players.status'), render: (p) => (p.status === 'active' ? t('academy.players.statusActive') : t('academy.players.statusInactive')) },
  ]

  if (currentMembership?.roleKey === 'coach') {
    return <CoachTodayView />
  }

  return (
    <div>
      <PageHeader title={t('academy.title')} description={t('academy.description')} />

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList>
          <TabsTrigger value="overview">{t('academy.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="players">{t('academy.tabs.players')}</TabsTrigger>
          <TabsTrigger value="structure">{t('academy.tabs.structure')}</TabsTrigger>
          <TabsTrigger value="enrollments">{t('academy.tabs.enrollments')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <AcademyOverview onNavigateTab={(tab) => setActiveTab(tab)} />
        </TabsContent>

        <TabsContent value="players">
          <div className="mb-4 mt-4 flex items-center justify-between gap-3">
            <Input
              placeholder={t('academy.players.searchByName')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-sm"
            />
            <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button>{t('academy.players.addPlayer')}</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t('academy.players.addPlayer')}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleCreateSubmit} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium text-text-secondary">{t('academy.players.fullName')}</label>
                    <Input required value={playerName} onChange={(e) => setPlayerName(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium text-text-secondary">{t('academy.players.dateOfBirth')}</label>
                    <Input type="date" value={playerDob} onChange={(e) => setPlayerDob(e.target.value)} />
                  </div>
                  {formError && (
                    <p role="alert" className="text-sm text-status-danger">
                      {formError}
                    </p>
                  )}
                  <Button type="submit" disabled={createPlayerMutation.isPending}>
                    {createPlayerMutation.isPending ? t('academy.players.adding') : t('academy.players.add')}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          </div>

          <DataTable
            columns={columns}
            rows={players}
            rowKey={(p) => p.id}
            isLoading={isLoading}
            emptyTitle={t('academy.players.emptyTitle')}
            emptyDescription={t('academy.players.emptyDescription')}
          />

          <Dialog
            open={!!selectedPlayer}
            onOpenChange={(open) => {
              if (!open) {
                setSelectedPlayer(null)
                setPlayerQrDataUrl(null)
              }
            }}
          >
            <DialogContent className="max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{selectedPlayer?.fullName}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-4">
                {selectedPlayer && (
                  <div className="border-b border-border pb-4">
                    <PlayerStatusPanel playerId={selectedPlayer.id} />
                  </div>
                )}
                <div className="flex flex-col gap-2 border-b border-border pb-4">
                  <label className="text-sm font-medium text-text-secondary">{t('academy.players.fullName')}</label>
                  <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
                  <div className="flex gap-2">
                    <div className="flex flex-1 flex-col gap-1">
                      <label className="text-xs text-text-secondary">{t('academy.players.dateOfBirth')}</label>
                      <Input type="date" value={editDob} onChange={(e) => setEditDob(e.target.value)} />
                    </div>
                    <div className="flex flex-1 flex-col gap-1">
                      <label className="text-xs text-text-secondary">{t('academy.players.gender')}</label>
                      <Select value={editGender || 'unspecified'} onValueChange={(v) => setEditGender(v === 'unspecified' ? '' : v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unspecified">{t('academy.players.genderUnspecified')}</SelectItem>
                          <SelectItem value="male">{t('academy.players.genderMale')}</SelectItem>
                          <SelectItem value="female">{t('academy.players.genderFemale')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <Select value={editStatus} onValueChange={setEditStatus}>
                      <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">{t('academy.players.statusActive')}</SelectItem>
                        <SelectItem value="inactive">{t('academy.players.statusInactive')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button size="sm" disabled={!editName.trim() || updatePlayerMutation.isPending} onClick={() => updatePlayerMutation.mutate()}>
                      {updatePlayerMutation.isPending ? t('academy.players.saving') : t('academy.players.save')}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col items-center gap-2 border-b border-border pb-4">
                  {playerQrDataUrl ? (
                    <img src={playerQrDataUrl} alt={t('academy.players.qrAlt')} className="size-40" />
                  ) : (
                    <Button variant="outline" size="sm" disabled={playerQrMutation.isPending} onClick={() => playerQrMutation.mutate()}>
                      {playerQrMutation.isPending ? t('academy.players.generatingQr') : t('academy.players.viewQr')}
                    </Button>
                  )}
                </div>
                <p className="text-sm font-medium text-text-secondary">{t('academy.players.guardians')}</p>
                {guardianLinks.length === 0 ? (
                  <p className="text-sm text-text-secondary">{t('academy.players.noGuardians')}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {guardianLinks.map((g) => (
                      <li key={g.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                        <span>{g.customerName}</span>
                        <span className="text-text-secondary">
                          {RELATIONSHIP_LABELS[g.relationship] ?? g.relationship}
                          {g.isPrimary && ` ${t('academy.players.primary')}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex flex-col gap-2 border-t border-border pt-4">
                  <label className="text-sm font-medium text-text-secondary">{t('academy.players.linkNewGuardian')}</label>
                  <Input
                    placeholder={t('academy.players.searchCustomerByName')}
                    value={guardianSearch}
                    onChange={(e) => {
                      setGuardianSearch(e.target.value)
                      setSelectedGuardianId('')
                    }}
                  />
                  {guardianCandidates.length > 0 && (
                    <Select value={selectedGuardianId} onValueChange={setSelectedGuardianId}>
                      <SelectTrigger><SelectValue placeholder={t('academy.players.chooseCustomer')} /></SelectTrigger>
                      <SelectContent>
                        {guardianCandidates.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.full_name} {c.mobile_display ? `(${c.mobile_display})` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Select value={relationship} onValueChange={setRelationship}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(RELATIONSHIP_LABELS).map(([key, label]) => (
                        <SelectItem key={key} value={key}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    disabled={!selectedGuardianId || linkGuardianMutation.isPending}
                    onClick={() => linkGuardianMutation.mutate()}
                  >
                    {t('academy.players.link')}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </TabsContent>

        <TabsContent value="structure">
          <ProgramsGroupsSection />
        </TabsContent>

        <TabsContent value="enrollments">
          {/* IA restructuring (Phase 5): ActivationPolicySetting used to
              be mounted here AND inside SettingsPage -- the exact same
              component, two places (confirmed duplicate in
              MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md). Settings is now
              the single home for that control; a link out replaces the
              duplicate mount so the policy stays discoverable from the
              enrollment workflow without re-rendering it here. */}
          <p className="mt-4 text-sm text-text-secondary">
            {t('academy.enrollments.activationPolicyManagedFrom')}{' '}
            <Link to="/app/settings" className="text-accent-foreground hover:underline">
              {t('academy.enrollments.settingsPage')}
            </Link>
            .
          </p>
          <EnrollmentSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}
