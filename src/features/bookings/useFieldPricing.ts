import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'

// Gate 1 (Booking Time Integrity): the venue's real IANA timezone,
// never hardcoded. Every booking write/read that converts between a
// wall-clock Business Date+Time and an absolute Instant must resolve
// this first — see src/lib/domain/time.ts for why.
export function useClubTimezone(clubId: string | null) {
  return useQuery({
    queryKey: ['club-timezone', clubId],
    queryFn: async () => {
      const { data, error } = await supabase.from('clubs').select('timezone').eq('id', clubId!).single()
      if (error) throw error
      return data.timezone as string
    },
    enabled: !!clubId,
    staleTime: 60 * 60 * 1000, // a club's timezone essentially never changes mid-session
  })
}

// V1 Operational Product Rebuild (Section H — Pricing UX): the price an
// employee sees anywhere in the product must come from the server-side
// resolve_field_price() RPC, never be guessed/recomputed client-side.
//
// Real, but benign, condition found in live QA (2026-08-30): callers
// like BookingsPage's field-header card ask for "the price right now"
// by passing the current wall-clock time as both start and end — which
// legitimately has no matching pricing_rules row whenever "now" falls
// outside every configured rule's time range (e.g. outside the club's
// operating hours, or in an unpriced gap). resolve_field_price() then
// correctly `raise exception`s ("no pricing rule found..."), which
// PostgREST surfaces as an HTTP 400 -- an expected business outcome,
// not a real error, and the UI already falls back to a friendly
// "price varies by time" message when data is null (see call sites).
// Without retry:false, React Query still retried this 3x by default
// and logged the exception to the console on every retry, all wasted
// work for a condition that will never succeed on retry. retry:false
// stops that; the UI's existing graceful fallback is unchanged.
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
    retry: false,
  })
}

export interface PriceSegment {
  segmentStart: string
  segmentEnd: string
  pricePerHour: number
  hours: number
  segmentTotal: number
}

export interface ResolvedFieldPriceTotal {
  total: number
  segments: PriceSegment[]
}

// BOOKINGS/FIELDS PRODUCTION ACCEPTANCE, D4 CLOSURE: real duration
// pricing (as opposed to useResolvedFieldPrice's single-instant "price
// right now" point lookup above) must go through the segmented pricing
// engine (resolve_field_price_total), never resolve_field_price() x
// duration -- that naive multiplication is exactly what silently
// broke on a booking spanning two adjacent pricing windows, AND (found
// live this session, independent of D4) was already displaying a
// mathematically wrong total for any duration other than exactly 1
// hour, since resolve_field_price() only ever returns a single hourly
// rate, never multiplied by duration -- the frontend was showing that
// raw rate as if it were already the total. Used by QuickBookingSheet
// (staff booking creation) wherever a real chosen duration -- not a
// zero-duration "now" instant -- needs a price.
export function useResolvedFieldPriceTotal(fieldId: string | null, date: string | null, startTime: string | null, endTime: string | null) {
  return useQuery({
    queryKey: ['resolve-field-price-total', fieldId, date, startTime, endTime],
    queryFn: async (): Promise<ResolvedFieldPriceTotal> => {
      const { data, error } = await supabase.rpc('resolve_field_price_total', {
        p_field_id: fieldId!,
        p_date: date!,
        p_start_time: startTime!,
        p_end_time: endTime!,
      })
      if (error) throw error
      const segments: PriceSegment[] = (data ?? []).map((row) => ({
        segmentStart: row.segment_start,
        segmentEnd: row.segment_end,
        pricePerHour: Number(row.price_per_hour),
        hours: Number(row.hours),
        segmentTotal: Number(row.segment_total),
      }))
      const total = segments.reduce((sum, s) => sum + s.segmentTotal, 0)
      return { total: Math.round(total * 100) / 100, segments }
    },
    enabled: !!fieldId && !!date && !!startTime && !!endTime,
    retry: false,
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
