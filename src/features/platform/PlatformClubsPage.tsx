import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { CLUB_STATUS_LABELS, ACCESS_TONE, ACCESS_LABEL } from '@/features/platform/labels'

interface ClubRow {
  id: string
  name_ar: string
  club_code: string
  status: string
  access: string
}

async function fetchClubs(): Promise<ClubRow[]> {
  const { data: clubs, error } = await supabase
    .from('clubs')
    .select('id, name_ar, club_code, status')
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) throw error
  if (!clubs) return []

  const withAccess = await Promise.all(
    clubs.map(async (c) => {
      const { data: access } = await supabase.rpc('get_club_platform_access', { p_club_id: c.id })
      return { ...c, access: access ?? 'blocked' }
    }),
  )

  return withAccess
}

export function PlatformClubsPage() {
  const { data: clubs = [], isLoading } = useQuery({ queryKey: ['platform-clubs'], queryFn: fetchClubs })

  const columns: DataTableColumn<ClubRow>[] = [
    {
      key: 'name',
      header: 'النادي',
      render: (c) => (
        <Link to={`/platform/clubs/${c.id}`} className="font-medium text-accent-foreground hover:underline">
          {c.name_ar}
        </Link>
      ),
    },
    { key: 'code', header: 'الكود', render: (c) => c.club_code },
    {
      key: 'status',
      header: 'الحالة الإدارية',
      render: (c) => <StatusBadge tone={c.status === 'active' ? 'success' : 'danger'} label={CLUB_STATUS_LABELS[c.status] ?? c.status} />,
    },
    {
      key: 'access',
      header: 'حالة الاشتراك',
      render: (c) => <StatusBadge tone={ACCESS_TONE[c.access] ?? 'neutral'} label={ACCESS_LABEL[c.access] ?? c.access} />,
    },
  ]

  return (
    <div>
      <PageHeader title="الأندية" description="جميع الأندية المسجّلة في المنصة" />
      <DataTable
        columns={columns}
        rows={clubs}
        rowKey={(c) => c.id}
        isLoading={isLoading}
        emptyTitle="لا توجد أندية بعد"
      />
    </div>
  )
}
