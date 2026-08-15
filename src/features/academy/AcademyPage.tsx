import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { PlaceholderPage } from '@/components/ui/placeholder-page'
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
import type { PlayerRow, GuardianLinkRow } from '@/lib/domain/people'

// Player Profile lives under /app/academy per SCREEN_MAP.md. Full
// Programs/Groups/Sessions/Enrollment is Phase 10-12's scope -- this is
// the concrete Phase 4 deliverable (player CRUD + guardian linking UI)
// placed on its documented route ahead of the rest of the phase.
const RELATIONSHIP_LABELS: Record<string, string> = {
  father: 'الأب',
  mother: 'الأم',
  guardian: 'ولي أمر',
  other: 'أخرى',
}

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
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [playerName, setPlayerName] = useState('')
  const [playerDob, setPlayerDob] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const [selectedPlayer, setSelectedPlayer] = useState<PlayerRow | null>(null)
  const [guardianSearch, setGuardianSearch] = useState('')
  const [selectedGuardianId, setSelectedGuardianId] = useState('')
  const [relationship, setRelationship] = useState('father')

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
    onError: () => setFormError('تعذّرت الإضافة، حاول مرة أخرى.'),
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

  function handleCreateSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    createPlayerMutation.mutate()
  }

  const columns: DataTableColumn<PlayerRow>[] = [
    {
      key: 'name',
      header: 'الاسم',
      render: (p) => (
        <button className="text-accent-foreground hover:underline" onClick={() => setSelectedPlayer(p)}>
          {p.fullName}
        </button>
      ),
    },
    { key: 'dob', header: 'تاريخ الميلاد', render: (p) => p.dateOfBirth ?? '—' },
    { key: 'status', header: 'الحالة', render: (p) => (p.status === 'active' ? 'نشط' : 'غير نشط') },
  ]

  return (
    <div>
      <PageHeader
        title="الأكاديمية"
        description="إدارة اللاعبين وأولياء الأمور"
        actions={
          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button>إضافة لاعب</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>إضافة لاعب</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreateSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">الاسم الكامل</label>
                  <Input required value={playerName} onChange={(e) => setPlayerName(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">تاريخ الميلاد</label>
                  <Input type="date" value={playerDob} onChange={(e) => setPlayerDob(e.target.value)} />
                </div>
                {formError && (
                  <p role="alert" className="text-sm text-status-danger">
                    {formError}
                  </p>
                )}
                <Button type="submit" disabled={createPlayerMutation.isPending}>
                  {createPlayerMutation.isPending ? 'جارٍ الإضافة...' : 'إضافة'}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="mb-4">
        <Input
          placeholder="بحث بالاسم"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
      </div>

      <DataTable
        columns={columns}
        rows={players}
        rowKey={(p) => p.id}
        isLoading={isLoading}
        emptyTitle="لا يوجد لاعبون"
        emptyDescription="أضف أول لاعب لبدء إدارة الأكاديمية"
      />

      <Dialog open={!!selectedPlayer} onOpenChange={(open) => !open && setSelectedPlayer(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>أولياء أمر {selectedPlayer?.fullName}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {guardianLinks.length === 0 ? (
              <p className="text-sm text-text-secondary">لا يوجد أولياء أمور مرتبطون بعد.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {guardianLinks.map((g) => (
                  <li key={g.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                    <span>{g.customerName}</span>
                    <span className="text-text-secondary">
                      {RELATIONSHIP_LABELS[g.relationship] ?? g.relationship}
                      {g.isPrimary && ' (أساسي)'}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <label className="text-sm font-medium text-text-secondary">ربط ولي أمر جديد</label>
              <Input
                placeholder="بحث عن عميل بالاسم"
                value={guardianSearch}
                onChange={(e) => {
                  setGuardianSearch(e.target.value)
                  setSelectedGuardianId('')
                }}
              />
              {guardianCandidates.length > 0 && (
                <Select value={selectedGuardianId} onValueChange={setSelectedGuardianId}>
                  <SelectTrigger><SelectValue placeholder="اختر عميلاً" /></SelectTrigger>
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
                ربط
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="mt-6">
        <PlaceholderPage title="البرامج والمجموعات والجلسات" phase="Phase 10-12" />
      </div>
    </div>
  )
}
