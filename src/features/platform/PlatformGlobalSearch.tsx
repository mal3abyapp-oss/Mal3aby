import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { Input } from '@/components/ui/input'
import { Search } from 'lucide-react'

// PERSONA COUNCIL AUDIT (2026-08-25) -- Platform Owner persona finding:
// the club-side app has GlobalSearch.tsx wired into AppLayout; the
// Platform Owner console had NO cross-page search entry point at all --
// finding a specific club required already being on /platform/clubs or
// /platform/owners first, typing into that page's own local search box.
// Mirrors GlobalSearch.tsx's own shape (debounce-free, min 2 chars,
// grouped results, club-scoped by the same platform_owner-only RLS
// every other platform screen already relies on) rather than inventing
// a new pattern. Reuses get_platform_club_owners() for the owner half
// of the search (already server-side searched, already the exact join
// this needs) instead of adding a second RPC.
interface ClubResult {
  id: string
  name_ar: string
  club_code: string
}

interface OwnerResult {
  user_id: string
  club_id: string
  full_name: string | null
  email: string | null
}

interface SearchResults {
  clubs: ClubResult[]
  owners: OwnerResult[]
}

async function search(term: string): Promise<SearchResults> {
  const escapedTerm = term.replace(/[%,]/g, '\\$&')
  const like = `%${escapedTerm}%`
  const [clubsRes, ownersRes] = await Promise.all([
    supabase.from('clubs').select('id, name_ar, club_code').or(`name_ar.ilike.${like},club_code.ilike.${like}`).limit(5),
    supabase.rpc('get_platform_club_owners', { p_search: term, p_limit: 5, p_offset: 0 }),
  ])

  const seenOwners = new Set<string>()
  const owners: OwnerResult[] = []
  for (const row of (ownersRes.data ?? []) as { user_id: string; club_id: string; full_name: string | null; email: string | null }[]) {
    if (seenOwners.has(row.user_id)) continue
    seenOwners.add(row.user_id)
    owners.push({ user_id: row.user_id, club_id: row.club_id, full_name: row.full_name, email: row.email })
  }

  return {
    clubs: (clubsRes.data ?? []) as ClubResult[],
    owners,
  }
}

export function PlatformGlobalSearch() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const navigate = useNavigate()
  const [term, setTerm] = useState('')
  const [focused, setFocused] = useState(false)

  const { data } = useQuery({
    queryKey: ['platform-global-search', term],
    queryFn: () => search(term),
    enabled: term.trim().length >= 2,
  })

  const hasResults = data && (data.clubs.length > 0 || data.owners.length > 0)

  return (
    <div className="relative w-full max-w-xs">
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-white/50" />
        <Input
          placeholder={t('platform.search.placeholder', { defaultValue: locale === 'en' ? 'Search clubs or owners...' : 'بحث عن نادٍ أو مالك...' })}
          className="border-white/10 bg-white/5 ps-9 text-white placeholder:text-white/40"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
        />
      </div>
      {focused && term.trim().length >= 2 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-surface p-2 text-text-primary shadow-lg">
          {!hasResults ? (
            <p className="p-2 text-sm text-text-secondary">{t('search.noResults')}</p>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              {data.clubs.length > 0 && (
                <div>
                  <p className="px-2 text-xs font-medium text-text-secondary">{t('platform.search.clubs', { defaultValue: locale === 'en' ? 'Clubs' : 'الأندية' })}</p>
                  {data.clubs.map((c) => (
                    <button
                      key={c.id}
                      className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted/50"
                      onClick={() => navigate(`/platform/clubs/${c.id}`)}
                    >
                      {c.name_ar} <span className="text-xs text-text-secondary">({c.club_code})</span>
                    </button>
                  ))}
                </div>
              )}
              {data.owners.length > 0 && (
                <div>
                  <p className="px-2 text-xs font-medium text-text-secondary">{t('platform.search.owners', { defaultValue: locale === 'en' ? 'Owners' : 'الملاك' })}</p>
                  {data.owners.map((o) => (
                    <button
                      key={o.user_id}
                      className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted/50"
                      onClick={() => navigate(`/platform/clubs/${o.club_id}`)}
                    >
                      {o.full_name ?? o.email ?? o.user_id} {o.email && <span className="text-xs text-text-secondary">· {o.email}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
