import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Input } from '@/components/ui/input'
import { Search } from 'lucide-react'

// Global Search: customers, players (via players_safe -- never surfaces
// medical_notes), invoice number. Grouped results, club-scoped by RLS.
// See ARCHITECTURE.md#performance-principles (indexed ILIKE), DESIGN_SYSTEM.md#search-ux.
interface SearchResults {
  customers: { id: string; full_name: string; mobile_display: string | null }[]
  players: { id: string; full_name: string }[]
  invoices: { id: string; invoice_number: string }[]
}

async function search(clubId: string, term: string): Promise<SearchResults> {
  const like = `%${term}%`
  const [customersRes, playersRes, invoicesRes] = await Promise.all([
    supabase.from('customers').select('id, full_name, mobile_display').eq('club_id', clubId).or(`full_name.ilike.${like},mobile_display.ilike.${like}`).limit(5),
    supabase.from('players_safe').select('id, full_name').eq('club_id', clubId).ilike('full_name', like).limit(5),
    supabase.from('invoices').select('id, invoice_number').eq('club_id', clubId).ilike('invoice_number', like).limit(5),
  ])

  return {
    customers: customersRes.data ?? [],
    players: (playersRes.data ?? []).filter((p): p is { id: string; full_name: string } => !!p.id && !!p.full_name),
    invoices: invoicesRes.data ?? [],
  }
}

export function GlobalSearch() {
  const { currentClubId } = useAuth()
  const navigate = useNavigate()
  const [term, setTerm] = useState('')
  const [focused, setFocused] = useState(false)

  const { data } = useQuery({
    queryKey: ['global-search', currentClubId, term],
    queryFn: () => search(currentClubId!, term),
    enabled: !!currentClubId && term.trim().length >= 2,
  })

  const hasResults = data && (data.customers.length > 0 || data.players.length > 0 || data.invoices.length > 0)

  return (
    <div className="relative w-full max-w-sm">
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-text-secondary" />
        <Input
          placeholder="بحث..."
          className="ps-9"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
        />
      </div>
      {focused && term.trim().length >= 2 && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-surface p-2 shadow-lg">
          {!hasResults ? (
            <p className="p-2 text-sm text-text-secondary">لا توجد نتائج</p>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              {data.customers.length > 0 && (
                <div>
                  <p className="px-2 text-xs font-medium text-text-secondary">العملاء</p>
                  {data.customers.map((c) => (
                    <button
                      key={c.id}
                      className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted/50"
                      onClick={() => navigate('/app/customers')}
                    >
                      {c.full_name} {c.mobile_display ? `· ${c.mobile_display}` : ''}
                    </button>
                  ))}
                </div>
              )}
              {data.players.length > 0 && (
                <div>
                  <p className="px-2 text-xs font-medium text-text-secondary">اللاعبون</p>
                  {data.players.map((p) => (
                    <button
                      key={p.id}
                      className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted/50"
                      onClick={() => navigate('/app/academy')}
                    >
                      {p.full_name}
                    </button>
                  ))}
                </div>
              )}
              {data.invoices.length > 0 && (
                <div>
                  <p className="px-2 text-xs font-medium text-text-secondary">الفواتير</p>
                  {data.invoices.map((i) => (
                    <button
                      key={i.id}
                      className="block w-full rounded px-2 py-1.5 text-start hover:bg-muted/50"
                      onClick={() => navigate('/app/billing')}
                    >
                      {i.invoice_number}
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
