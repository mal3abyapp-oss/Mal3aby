import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { Input } from '@/components/ui/input'

// Gate 13 task #55: the platform owner console had no way to see WHO
// owns each club -- ownership is a club_memberships row (role = club_owner),
// not a column on clubs, so it was invisible without a direct DB query.
// This is the platform's actual customer list: one row per club_owner
// membership (an owner running multiple clubs shows up once per club,
// since commercial entitlements/billing are per-club, not per-person).
interface OwnerRow {
  club_id: string
  club_name: string
  club_code: string
  club_status: string
  membership_id: string
  membership_status: string
  user_id: string
  full_name: string | null
  phone: string | null
  email: string | null
  owner_since: string
}

async function fetchOwners(): Promise<OwnerRow[]> {
  const { data, error } = await supabase.rpc('get_platform_club_owners')
  if (error) throw error
  return (data ?? []) as OwnerRow[]
}

const CLUB_STATUS_LABELS: Record<string, string> = { active: 'نشط', suspended: 'موقوف', closed: 'مغلق' }
const MEMBERSHIP_STATUS_LABELS: Record<string, string> = { active: 'نشطة', suspended: 'موقوفة', removed: 'ملغاة' }

export function PlatformOwnersPage() {
  const [search, setSearch] = useState('')
  const { data: owners = [], isLoading } = useQuery({ queryKey: ['platform-owners'], queryFn: fetchOwners })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return owners
    return owners.filter(
      (o) =>
        (o.full_name ?? '').toLowerCase().includes(q) ||
        (o.email ?? '').toLowerCase().includes(q) ||
        (o.phone ?? '').toLowerCase().includes(q) ||
        o.club_name.toLowerCase().includes(q) ||
        o.club_code.toLowerCase().includes(q),
    )
  }, [owners, search])

  const ownerClubCounts = new Map<string, number>()
  for (const o of owners) ownerClubCounts.set(o.user_id, (ownerClubCounts.get(o.user_id) ?? 0) + 1)
  const uniqueOwners = ownerClubCounts.size
  const multiClubOwners = [...ownerClubCounts.values()].filter((count) => count > 1).length

  const columns: DataTableColumn<OwnerRow>[] = [
    {
      key: 'owner',
      header: 'المالك',
      render: (o) => (
        <div className="flex flex-col">
          <span className="font-medium text-text-primary">{o.full_name ?? '—'}</span>
          <span className="text-xs text-text-secondary">{o.email ?? '—'}</span>
        </div>
      ),
    },
    { key: 'phone', header: 'الهاتف', render: (o) => o.phone ?? '—' },
    {
      key: 'club',
      header: 'النادي',
      render: (o) => (
        <Link to={`/platform/clubs/${o.club_id}`} className="font-medium text-accent-foreground hover:underline">
          {o.club_name}
        </Link>
      ),
    },
    { key: 'code', header: 'الكود', render: (o) => o.club_code },
    {
      key: 'club_status',
      header: 'حالة النادي',
      render: (o) => (
        <StatusBadge tone={o.club_status === 'active' ? 'success' : 'danger'} label={CLUB_STATUS_LABELS[o.club_status] ?? o.club_status} />
      ),
    },
    {
      key: 'membership_status',
      header: 'حالة العضوية',
      render: (o) => (
        <StatusBadge
          tone={o.membership_status === 'active' ? 'success' : 'neutral'}
          label={MEMBERSHIP_STATUS_LABELS[o.membership_status] ?? o.membership_status}
        />
      ),
    },
    { key: 'since', header: 'مالك منذ', render: (o) => new Date(o.owner_since).toLocaleDateString('ar-EG') },
  ]

  return (
    <div>
      <PageHeader title="أصحاب الأندية" description="جميع أصحاب الأندية المسجّلين على المنصة، وربط كل مالك بناديه" />
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard label="إجمالي أصحاب الأندية" value={String(uniqueOwners)} />
        <StatCard label="إجمالي عضويات الملكية" value={String(owners.length)} />
        <StatCard label="أصحاب يملكون أكثر من نادٍ" value={String(multiClubOwners)} />
      </div>
      <div className="mb-4 max-w-sm">
        <Input
          placeholder="ابحث بالاسم، البريد الإلكتروني، الهاتف، أو اسم النادي"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(o) => o.membership_id}
        isLoading={isLoading}
        emptyTitle={search ? 'لا توجد نتائج مطابقة' : 'لا يوجد أصحاب أندية بعد'}
      />
    </div>
  )
}
