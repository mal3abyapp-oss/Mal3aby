import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
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
import {
  DAY_OF_WEEK_LABELS,
  GROUP_STATUS_LABELS,
  type AgeGroupRow,
  type GroupRow,
  type ProgramRow,
  type ScheduleSlotRow,
  type SeasonRow,
} from '@/lib/domain/academy'

// Programs/Seasons/Age Groups management + Groups creation with schedule +
// coach assignment. Placed under /app/academy per SCREEN_MAP.md (academy
// route group is a single route, not separate top-level routes).
async function fetchPrograms(clubId: string) {
  const { data, error } = await supabase.from('programs').select('id, name, name_ar, sport, status').eq('club_id', clubId).order('name')
  if (error) throw error
  return (data ?? []).map<ProgramRow>((p) => ({ id: p.id, name: p.name, nameAr: p.name_ar, sport: p.sport, status: p.status }))
}

async function fetchSeasons(clubId: string) {
  const { data, error } = await supabase.from('seasons').select('id, program_id, name, start_date, end_date').eq('club_id', clubId).order('start_date', { ascending: false })
  if (error) throw error
  return (data ?? []).map<SeasonRow>((s) => ({ id: s.id, programId: s.program_id, name: s.name, startDate: s.start_date, endDate: s.end_date }))
}

async function fetchAgeGroups(clubId: string) {
  const { data, error } = await supabase.from('age_groups').select('id, name, min_age, max_age').eq('club_id', clubId).order('name')
  if (error) throw error
  return (data ?? []).map<AgeGroupRow>((a) => ({ id: a.id, name: a.name, minAge: a.min_age, maxAge: a.max_age }))
}

async function fetchGroups(clubId: string) {
  const { data, error } = await supabase
    .from('groups')
    .select('id, branch_id, program_id, season_id, age_group_id, coach_id, assistant_coach_id, field_id, name, capacity, status, programs(name), seasons(name)')
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map<GroupRow>((g) => ({
    id: g.id,
    branchId: g.branch_id,
    programId: g.program_id,
    seasonId: g.season_id,
    ageGroupId: g.age_group_id,
    coachId: g.coach_id,
    assistantCoachId: g.assistant_coach_id,
    fieldId: g.field_id,
    name: g.name,
    capacity: g.capacity,
    status: g.status,
    programName: (g.programs as unknown as { name: string } | null)?.name,
    seasonName: (g.seasons as unknown as { name: string } | null)?.name,
  }))
}

async function fetchScheduleSlots(groupId: string) {
  const { data, error } = await supabase.from('group_schedule_slots').select('id, group_id, day_of_week, start_time, end_time').eq('group_id', groupId).order('day_of_week')
  if (error) throw error
  return (data ?? []).map<ScheduleSlotRow>((s) => ({ id: s.id, groupId: s.group_id, dayOfWeek: s.day_of_week, startTime: s.start_time, endTime: s.end_time }))
}

async function fetchBranches(clubId: string) {
  const { data, error } = await supabase.from('branches').select('id, name').eq('club_id', clubId).order('name')
  if (error) throw error
  return data ?? []
}

async function fetchFields(clubId: string) {
  const { data, error } = await supabase.from('fields').select('id, name').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

async function fetchCoaches(clubId: string) {
  const { data: memberships, error } = await supabase
    .from('club_memberships')
    .select('user_id, roles(key)')
    .eq('club_id', clubId)
    .eq('status', 'active')
  if (error) throw error

  const coachIds = (memberships ?? [])
    .filter((row) => (row.roles as unknown as { key: string } | null)?.key === 'coach')
    .map((row) => row.user_id)
  if (coachIds.length === 0) return []

  const { data: profiles, error: profilesError } = await supabase
    .from('profiles')
    .select('user_id, full_name')
    .in('user_id', coachIds)
  if (profilesError) throw profilesError

  const nameByUserId = new Map((profiles ?? []).map((p) => [p.user_id, p.full_name]))
  return coachIds.map((id) => ({ id, name: nameByUserId.get(id) ?? id }))
}

export function ProgramsGroupsSection() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()

  const [programDialogOpen, setProgramDialogOpen] = useState(false)
  const [programName, setProgramName] = useState('')
  const [programNameAr, setProgramNameAr] = useState('')

  const [seasonDialogOpen, setSeasonDialogOpen] = useState(false)
  const [seasonProgramId, setSeasonProgramId] = useState('')
  const [seasonName, setSeasonName] = useState('')
  const [seasonStart, setSeasonStart] = useState('')
  const [seasonEnd, setSeasonEnd] = useState('')

  const [ageGroupDialogOpen, setAgeGroupDialogOpen] = useState(false)
  const [ageGroupName, setAgeGroupName] = useState('')

  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupBranchId, setGroupBranchId] = useState('')
  const [groupProgramId, setGroupProgramId] = useState('')
  const [groupSeasonId, setGroupSeasonId] = useState('')
  const [groupAgeGroupId, setGroupAgeGroupId] = useState('')
  const [groupCoachId, setGroupCoachId] = useState('')
  const [groupFieldId, setGroupFieldId] = useState('')
  const [groupCapacity, setGroupCapacity] = useState('12')

  const [selectedGroup, setSelectedGroup] = useState<GroupRow | null>(null)
  const [slotDay, setSlotDay] = useState('1')
  const [slotStart, setSlotStart] = useState('16:00')
  const [slotEnd, setSlotEnd] = useState('17:30')

  const { data: programs = [] } = useQuery({ queryKey: ['programs', currentClubId], queryFn: () => fetchPrograms(currentClubId!), enabled: !!currentClubId })
  const { data: seasons = [] } = useQuery({ queryKey: ['seasons', currentClubId], queryFn: () => fetchSeasons(currentClubId!), enabled: !!currentClubId })
  const { data: ageGroups = [] } = useQuery({ queryKey: ['age-groups', currentClubId], queryFn: () => fetchAgeGroups(currentClubId!), enabled: !!currentClubId })
  const { data: groups = [], isLoading: groupsLoading } = useQuery({ queryKey: ['groups', currentClubId], queryFn: () => fetchGroups(currentClubId!), enabled: !!currentClubId })
  const { data: branches = [] } = useQuery({ queryKey: ['branches-for-academy', currentClubId], queryFn: () => fetchBranches(currentClubId!), enabled: !!currentClubId })
  const { data: fields = [] } = useQuery({ queryKey: ['fields-for-academy', currentClubId], queryFn: () => fetchFields(currentClubId!), enabled: !!currentClubId })
  const { data: coaches = [] } = useQuery({ queryKey: ['coaches', currentClubId], queryFn: () => fetchCoaches(currentClubId!), enabled: !!currentClubId })
  const { data: scheduleSlots = [] } = useQuery({
    queryKey: ['schedule-slots', selectedGroup?.id],
    queryFn: () => fetchScheduleSlots(selectedGroup!.id),
    enabled: !!selectedGroup,
  })

  const createProgramMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('programs').insert({ club_id: currentClubId as string, name: programName, name_ar: programNameAr })
      if (error) throw error
    },
    onSuccess: () => {
      setProgramDialogOpen(false)
      setProgramName('')
      setProgramNameAr('')
      void queryClient.invalidateQueries({ queryKey: ['programs', currentClubId] })
    },
  })

  const createSeasonMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('seasons').insert({
        club_id: currentClubId as string,
        program_id: seasonProgramId || null,
        name: seasonName,
        start_date: seasonStart,
        end_date: seasonEnd,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setSeasonDialogOpen(false)
      setSeasonName('')
      setSeasonStart('')
      setSeasonEnd('')
      void queryClient.invalidateQueries({ queryKey: ['seasons', currentClubId] })
    },
  })

  const createAgeGroupMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('age_groups').insert({ club_id: currentClubId as string, name: ageGroupName })
      if (error) throw error
    },
    onSuccess: () => {
      setAgeGroupDialogOpen(false)
      setAgeGroupName('')
      void queryClient.invalidateQueries({ queryKey: ['age-groups', currentClubId] })
    },
  })

  const createGroupMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('groups').insert({
        club_id: currentClubId as string,
        branch_id: groupBranchId,
        program_id: groupProgramId,
        season_id: groupSeasonId,
        age_group_id: groupAgeGroupId || null,
        coach_id: groupCoachId || null,
        field_id: groupFieldId || null,
        name: groupName,
        capacity: Number(groupCapacity),
      })
      if (error) throw error
    },
    onSuccess: () => {
      setGroupDialogOpen(false)
      setGroupName('')
      setGroupBranchId('')
      setGroupProgramId('')
      setGroupSeasonId('')
      setGroupAgeGroupId('')
      setGroupCoachId('')
      setGroupFieldId('')
      void queryClient.invalidateQueries({ queryKey: ['groups', currentClubId] })
    },
  })

  const addSlotMutation = useMutation({
    mutationFn: async () => {
      if (!selectedGroup) throw new Error('no group selected')
      const { error } = await supabase.from('group_schedule_slots').insert({
        group_id: selectedGroup.id,
        day_of_week: Number(slotDay),
        start_time: slotStart,
        end_time: slotEnd,
      })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['schedule-slots', selectedGroup?.id] })
    },
  })

  const generateSessionsMutation = useMutation({
    mutationFn: async () => {
      if (!selectedGroup) throw new Error('no group selected')
      const through = new Date()
      through.setDate(through.getDate() + 28)
      const { data, error } = await supabase.rpc('generate_training_sessions', {
        p_group_id: selectedGroup.id,
        p_through_date: through.toISOString().slice(0, 10),
      })
      if (error) throw error
      return data as number
    },
  })

  function handleCreateProgram(e: FormEvent) {
    e.preventDefault()
    createProgramMutation.mutate()
  }

  function handleCreateSeason(e: FormEvent) {
    e.preventDefault()
    createSeasonMutation.mutate()
  }

  function handleCreateAgeGroup(e: FormEvent) {
    e.preventDefault()
    createAgeGroupMutation.mutate()
  }

  function handleCreateGroup(e: FormEvent) {
    e.preventDefault()
    createGroupMutation.mutate()
  }

  const groupColumns: DataTableColumn<GroupRow>[] = [
    {
      key: 'name',
      header: 'المجموعة',
      render: (g) => (
        <button className="text-accent-foreground hover:underline" onClick={() => setSelectedGroup(g)}>
          {g.name}
        </button>
      ),
    },
    { key: 'program', header: 'البرنامج', render: (g) => g.programName ?? '—' },
    { key: 'season', header: 'الموسم', render: (g) => g.seasonName ?? '—' },
    { key: 'capacity', header: 'السعة', render: (g) => g.capacity },
    { key: 'status', header: 'الحالة', render: (g) => <StatusBadge tone={g.status === 'active' ? 'success' : 'neutral'} label={GROUP_STATUS_LABELS[g.status] ?? g.status} /> },
  ]

  return (
    <div className="mt-6 flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Dialog open={programDialogOpen} onOpenChange={setProgramDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">برنامج جديد</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>برنامج جديد</DialogTitle></DialogHeader>
            <form onSubmit={handleCreateProgram} className="flex flex-col gap-3">
              <Input required placeholder="الاسم (عربي)" value={programNameAr} onChange={(e) => setProgramNameAr(e.target.value)} />
              <Input required placeholder="الاسم (إنجليزي)" value={programName} onChange={(e) => setProgramName(e.target.value)} />
              <Button type="submit" disabled={createProgramMutation.isPending}>إضافة</Button>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={seasonDialogOpen} onOpenChange={setSeasonDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">موسم جديد</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>موسم جديد</DialogTitle></DialogHeader>
            <form onSubmit={handleCreateSeason} className="flex flex-col gap-3">
              <Select value={seasonProgramId} onValueChange={setSeasonProgramId}>
                <SelectTrigger><SelectValue placeholder="البرنامج (اختياري)" /></SelectTrigger>
                <SelectContent>
                  {programs.map((p) => <SelectItem key={p.id} value={p.id}>{p.nameAr}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input required placeholder="اسم الموسم" value={seasonName} onChange={(e) => setSeasonName(e.target.value)} />
              <Input required type="date" value={seasonStart} onChange={(e) => setSeasonStart(e.target.value)} />
              <Input required type="date" value={seasonEnd} onChange={(e) => setSeasonEnd(e.target.value)} />
              <Button type="submit" disabled={createSeasonMutation.isPending}>إضافة</Button>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={ageGroupDialogOpen} onOpenChange={setAgeGroupDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm">فئة عمرية جديدة</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>فئة عمرية جديدة</DialogTitle></DialogHeader>
            <form onSubmit={handleCreateAgeGroup} className="flex flex-col gap-3">
              <Input required placeholder="مثال: U10" value={ageGroupName} onChange={(e) => setAgeGroupName(e.target.value)} />
              <Button type="submit" disabled={createAgeGroupMutation.isPending}>إضافة</Button>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">مجموعة جديدة</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>مجموعة جديدة</DialogTitle></DialogHeader>
            <form onSubmit={handleCreateGroup} className="flex flex-col gap-3">
              <Input required placeholder="اسم المجموعة" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
              <Select value={groupBranchId} onValueChange={setGroupBranchId}>
                <SelectTrigger><SelectValue placeholder="الفرع" /></SelectTrigger>
                <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={groupProgramId} onValueChange={setGroupProgramId}>
                <SelectTrigger><SelectValue placeholder="البرنامج" /></SelectTrigger>
                <SelectContent>{programs.map((p) => <SelectItem key={p.id} value={p.id}>{p.nameAr}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={groupSeasonId} onValueChange={setGroupSeasonId}>
                <SelectTrigger><SelectValue placeholder="الموسم" /></SelectTrigger>
                <SelectContent>{seasons.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={groupAgeGroupId} onValueChange={setGroupAgeGroupId}>
                <SelectTrigger><SelectValue placeholder="الفئة العمرية (اختياري)" /></SelectTrigger>
                <SelectContent>{ageGroups.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={groupCoachId} onValueChange={setGroupCoachId}>
                <SelectTrigger><SelectValue placeholder="المدرب (اختياري)" /></SelectTrigger>
                <SelectContent>{coaches.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={groupFieldId} onValueChange={setGroupFieldId}>
                <SelectTrigger><SelectValue placeholder="الملعب (اختياري)" /></SelectTrigger>
                <SelectContent>{fields.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}</SelectContent>
              </Select>
              <Input required type="number" min={1} placeholder="السعة" value={groupCapacity} onChange={(e) => setGroupCapacity(e.target.value)} />
              <Button type="submit" disabled={!groupBranchId || !groupProgramId || !groupSeasonId || createGroupMutation.isPending}>
                إضافة
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <DataTable
        columns={groupColumns}
        rows={groups}
        rowKey={(g) => g.id}
        isLoading={groupsLoading}
        emptyTitle="لا توجد مجموعات"
        emptyDescription="أنشئ برنامجًا وموسمًا ثم مجموعة لبدء إدارة الأكاديمية"
      />

      <Dialog open={!!selectedGroup} onOpenChange={(open) => !open && setSelectedGroup(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>الجدول الأسبوعي — {selectedGroup?.name}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            {scheduleSlots.length === 0 ? (
              <p className="text-sm text-text-secondary">لا يوجد مواعيد بعد.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {scheduleSlots.map((s) => (
                  <li key={s.id} className="rounded-md border border-border p-2 text-sm">
                    {DAY_OF_WEEK_LABELS[s.dayOfWeek]} — {s.startTime} إلى {s.endTime}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <Select value={slotDay} onValueChange={setSlotDay}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(DAY_OF_WEEK_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2">
                <Input type="time" value={slotStart} onChange={(e) => setSlotStart(e.target.value)} />
                <Input type="time" value={slotEnd} onChange={(e) => setSlotEnd(e.target.value)} />
              </div>
              <Button size="sm" disabled={addSlotMutation.isPending} onClick={() => addSlotMutation.mutate()}>
                إضافة موعد
              </Button>
            </div>
            {scheduleSlots.length > 0 && (
              <div className="border-t border-border pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={generateSessionsMutation.isPending}
                  onClick={() => generateSessionsMutation.mutate()}
                >
                  {generateSessionsMutation.isPending ? 'جارٍ التوليد...' : 'توليد جلسات الأسابيع الأربعة القادمة'}
                </Button>
                {generateSessionsMutation.data !== undefined && (
                  <p className="mt-2 text-sm text-text-secondary">تم إنشاء {generateSessionsMutation.data} جلسة جديدة.</p>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
