import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { CLUB_STATUS_LABELS, ACCESS_TONE, ACCESS_LABEL } from '@/features/platform/labels'

// Master IA/UX audit (Platform Owner phase, Audit 5): a hard `.limit(100)`
// silently dropped any club beyond the 100th with zero indication a cutoff
// happened -- a real data-loss-from-view risk once the platform grows past
// this number, not just today. Fixed with simple offset-based "load more"
// pagination rather than a full page-number component, since no shared
// pagination primitive exists in this codebase yet (DataTable is
// deliberately bounded/dumb per its own header comment) and this screen's
// flat, most-recent-first list shape doesn't need page jumping.
const PAGE_SIZE = 100

interface ClubRow {
  id: string
  name_ar: string
  club_code: string
  status: string
  access: string
}

async function fetchClubs(offset: number): Promise<{ rows: ClubRow[]; hasMore: boolean }> {
  const { data: clubs, error } = await supabase
    .from('clubs')
    .select('id, name_ar, club_code, status')
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)

  if (error) throw error
  if (!clubs) return { rows: [], hasMore: false }

  const withAccess = await Promise.all(
    clubs.map(async (c) => {
      const { data: access } = await supabase.rpc('get_club_platform_access', { p_club_id: c.id })
      return { ...c, access: access ?? 'blocked' }
    }),
  )

  return { rows: withAccess, hasMore: clubs.length === PAGE_SIZE }
}

export function PlatformClubsPage() {
  const [pages, setPages] = useState(1)
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['platform-clubs', pages],
    queryFn: async () => {
      const results = await Promise.all(Array.from({ length: pages }, (_, i) => fetchClubs(i * PAGE_SIZE)))
      const lastPage = results.at(-1)
      return { rows: results.flatMap((r) => r.rows), hasMore: lastPage?.hasMore ?? false }
    },
  })
  const clubs = data?.rows ?? []

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
    { key: 'code', header: 'الكود', render: (c) => <bdi>{c.club_code}</bdi> },
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
      {data?.hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => setPages((p) => p + 1)} disabled={isFetching}>
            {isFetching ? 'جارٍ التحميل...' : 'تحميل المزيد'}
          </Button>
        </div>
      )}
    </div>
  )
}
