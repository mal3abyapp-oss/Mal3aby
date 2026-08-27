import { supabase } from '@/lib/supabase/client'
import type { Database } from '@/lib/supabase/types'

type RpcName = keyof Database['public']['Functions']

// PRINTING & DOCUMENT OUTPUT -- FULL FILTERED PRINT (2026-08-27):
// "Print Full Report" retrieval path, shared by every report screen
// that limits its NORMAL screen query for performance
// (list_shop_inventory_movements / list_shop_sales, both p_limit:50
// by default). This does NOT change the screen query -- that stays
// bounded exactly as before. This is a SEPARATE, explicit, on-demand
// fetch triggered only when the user asks to print the full report,
// paging through the SAME server RPC (same filters, same club/branch/
// permission enforcement -- these RPCs already gate on has_permission()
// internally, unchanged) in bounded chunks rather than one unlimited
// query.
//
// Hard safety cap: MAX_PAGES * pageSize is the absolute ceiling this
// function will ever fetch, to guarantee it can never freeze the
// browser or explode memory on a pathological dataset. If the cap is
// hit, `truncated: true` is returned -- callers MUST surface this
// explicitly on the printed page (never silently drop rows past the
// cap without saying so).
const MAX_PAGES = 40 // 40 * 200 = 8000 rows hard ceiling

export interface FullReportResult<T> {
  rows: T[]
  truncated: boolean
  totalFetched: number
}

/**
 * Pages through a Supabase RPC that accepts p_limit/p_offset, collecting
 * every row across all pages up to the safety cap. `rpcParams` should
 * include every filter currently active on screen (status, location,
 * product, date range, etc.) so the full-print result reflects the
 * exact same filtered view the user is looking at -- never an
 * unfiltered dump.
 */
export async function fetchFullReport<T>(
  rpcName: RpcName,
  rpcParams: Record<string, unknown>,
  pageSize = 200,
): Promise<FullReportResult<T>> {
  const rows: T[] = []
  let offset = 0
  let truncated = false

  for (let page = 0; page < MAX_PAGES; page++) {
    // The generated Database['public']['Functions'] union means each RPC's
    // real argument shape differs per name -- this helper is intentionally
    // generic across every paginated report RPC (p_limit/p_offset plus
    // whatever filters that specific RPC accepts), which the generated
    // per-function argument types can't express without a discriminated
    // call per RPC. Callers are responsible for passing the correct
    // p_club_id/filter shape for the RPC they name; the RPC's own
    // server-side permission/RLS checks are the real enforcement boundary
    // regardless of this cast.
    const { data, error } = await supabase.rpc(
      rpcName,
      { ...rpcParams, p_limit: pageSize, p_offset: offset } as never,
    )
    if (error) throw error
    const pageRows = (data ?? []) as T[]
    rows.push(...pageRows)

    if (pageRows.length < pageSize) {
      // Fewer rows than requested means we've reached the real end.
      return { rows, truncated: false, totalFetched: rows.length }
    }
    offset += pageSize

    if (page === MAX_PAGES - 1) {
      truncated = true
    }
  }

  return { rows, truncated, totalFetched: rows.length }
}
