// Shared commercial-truth source for every public-site pricing surface
// (PricingPage.tsx, HomePage.tsx's pricing preview, and any future
// surface). Extracted 2026-09-06: HomePage and PricingPage each fetched
// public_plans independently and each re-implemented monthly/annual
// family-grouping and the "which plan is recommended" logic slightly
// differently -- HomePage rendered every row as its own flat card
// (6 cards: 3 monthly + 3 annual) while PricingPage correctly grouped
// rows into one card per package with a billing-cycle toggle. This
// hook is now the ONE place that fetches, filters (legacy plans
// excluded via filterPublicCommercialPlans), groups into families, and
// computes annual discounts -- both pages consume the same data and
// the same grouping so they can never again drift into inconsistent
// interaction models for the same underlying commercial truth.
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { filterPublicCommercialPlans, computeAnnualDiscountsByFamily } from '@/lib/domain/billing'

export interface PublicPlanRow {
  id: string
  name: string | null
  name_ar: string | null
  description_ar: string | null
  billing_interval: string | null
  billing_interval_count: number | null
  price: number | null
  currency: string | null
  discount_label: string | null
  features_summary: string | null
  default_grace_period_days: number | null
  default_branch_limit: number | null
  default_field_limit: number | null
  default_academy_limit: number | null
  default_staff_limit: number | null
  default_active_player_limit: number | null
  display_order: number | null
}

export interface PlanFamily {
  familyName: string // e.g. "Starter" — the shared name minus "(Annual)"
  monthly: PublicPlanRow | null
  annual: PublicPlanRow | null
}

async function fetchPublicCommercialPlans(): Promise<PublicPlanRow[]> {
  const { data, error } = await supabase.from('public_plans').select('*').order('display_order')
  if (error) throw error
  return filterPublicCommercialPlans((data ?? []) as PublicPlanRow[])
}

// Groups the flat public_plans rows (each billing interval is its own
// row, e.g. "Starter" + "Starter (Annual)") into one card per
// commercial tier, matching how a customer actually thinks about
// plans — "Starter" with a monthly/annual choice, not separate cards.
export function groupIntoFamilies(rows: readonly PublicPlanRow[]): PlanFamily[] {
  const families = new Map<string, PlanFamily>()
  for (const row of rows) {
    if (!row.name) continue
    const isAnnual = row.billing_interval === 'year'
    const familyName = isAnnual ? row.name.replace(/\s*\(Annual\)\s*$/, '') : row.name
    const existing = families.get(familyName) ?? { familyName, monthly: null, annual: null }
    if (isAnnual) existing.annual = row
    else existing.monthly = row
    families.set(familyName, existing)
  }
  return Array.from(families.values()).sort(
    (a, b) => (a.monthly?.display_order ?? a.annual?.display_order ?? 0) - (b.monthly?.display_order ?? b.annual?.display_order ?? 0),
  )
}

export interface UsePublicPricingResult {
  isLoading: boolean
  families: PlanFamily[]
  /** familyName -> rounded annual discount percent (e.g. "Growth" -> 16.4). Never present for a family with no valid discount to show — see computeAnnualDiscountsByFamily. */
  annualDiscountByFamily: Map<string, number>
}

// One shared React Query cache key + one shared derivation pipeline —
// both public-site pages calling this hook share the exact same fetch,
// so there is no risk of one page's copy of the filter/grouping logic
// silently drifting from the other's.
export function usePublicPricing(): UsePublicPricingResult {
  const { data: plans = [], isLoading } = useQuery({ queryKey: ['public-commercial-plans'], queryFn: fetchPublicCommercialPlans })
  const families = groupIntoFamilies(plans)
  const annualDiscountByFamily = computeAnnualDiscountsByFamily(plans)
  return { isLoading, families, annualDiscountByFamily }
}
