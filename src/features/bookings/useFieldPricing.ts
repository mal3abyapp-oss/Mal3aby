import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'

// V1 Operational Product Rebuild (Section H — Pricing UX): the price an
// employee sees anywhere in the product must come from the server-side
// resolve_field_price() RPC, never be guessed/recomputed client-side.
export function useResolvedFieldPrice(fieldId: string | null, date: string | null, startTime: string | null, endTime: string | null) {
  return useQuery({
    queryKey: ['resolve-field-price', fieldId, date, startTime, endTime],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('resolve_field_price', {
        p_field_id: fieldId!,
        p_date: date!,
        p_start_time: startTime!,
        p_end_time: endTime!,
      })
      if (error) throw error
      return Number(data)
    },
    enabled: !!fieldId && !!date && !!startTime && !!endTime,
  })
}

export interface FieldOperatingHoursToday {
  openTime: string | null
  closeTime: string | null
  isClosed: boolean
  isUnrestricted: boolean
}

// No resolve_field_operating_hours() RPC exists yet -- read
// field_operating_hours directly (falls back to branch-level rows, then
// "unrestricted" if neither field nor branch has any configured hours
// for that weekday, matching the convention used elsewhere in this
// schema: an empty hours table for a scope means unrestricted).
export async function fetchOperatingHoursForWeek(clubId: string, fieldId: string, branchId: string) {
  const { data, error } = await supabase
    .from('field_operating_hours')
    .select('day_of_week, open_time, close_time, field_id, branch_id')
    .eq('club_id', clubId)
    .or(`field_id.eq.${fieldId},and(field_id.is.null,branch_id.eq.${branchId})`)
  if (error) throw error
  return data ?? []
}

export function resolveHoursForDay(
  rows: { day_of_week: number; open_time: string; close_time: string; field_id: string | null }[],
  fieldId: string,
  dayOfWeek: number,
): FieldOperatingHoursToday {
  const fieldRows = rows.filter((r) => r.field_id === fieldId)
  const scoped = fieldRows.length > 0 ? fieldRows : rows.filter((r) => r.field_id === null)
  if (scoped.length === 0) {
    return { openTime: null, closeTime: null, isClosed: false, isUnrestricted: true }
  }
  const today = scoped.find((r) => r.day_of_week === dayOfWeek)
  if (!today) {
    return { openTime: null, closeTime: null, isClosed: true, isUnrestricted: false }
  }
  return { openTime: today.open_time, closeTime: today.close_time, isClosed: false, isUnrestricted: false }
}
