// Shared Arabic labels for platform_subscriptions enum columns.
// Owner-level review finding (P2, terminology): subscription_kind and
// lifecycle_status were rendered as raw enum values ("trial", "active"...)
// in multiple Platform Owner screens -- exposing internal
// developer-facing state names directly to a human platform owner.
// Centralized here once both PlatformClubDetailPage.tsx and
// PlatformReportsPage.tsx needed the same mapping, rather than
// duplicating it a third time.

// Matches platform_subscriptions' real check constraint exactly
// (lifecycle_status in ['trial','active','cancelled']) -- confirmed via
// live schema inspection, not guessed.
export const LIFECYCLE_STATUS_LABELS: Record<string, string> = {
  trial: 'تجربة مجانية',
  active: 'نشط',
  cancelled: 'ملغى',
}

export const SUBSCRIPTION_KIND_LABELS: Record<string, string> = {
  trial: 'تجربة مجانية',
  paid: 'مدفوع',
}

// IA restructuring (Phase 3): CLUB_STATUS_LABELS and ACCESS_TONE/
// ACCESS_LABEL were independently duplicated verbatim across
// PlatformClubsPage.tsx, PlatformClubDetailPage.tsx, and
// PlatformOwnersPage.tsx (confirmed via MAL3ABY_INFORMATION_
// ARCHITECTURE_AUDIT.md) -- consolidated here as the single source,
// same pattern as the two maps above. Two genuinely distinct concepts,
// deliberately NOT merged (target IA §5): clubs.status is an
// administrative action (active/suspended/closed); access is
// billing/subscription-derived (full/grace/blocked) via
// get_club_platform_access().
export const CLUB_STATUS_LABELS: Record<string, string> = {
  active: 'نشط',
  suspended: 'موقوف',
  closed: 'مغلق',
}

export const ACCESS_TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  full: 'success',
  grace: 'warning',
  blocked: 'danger',
}

export const ACCESS_LABEL: Record<string, string> = {
  full: 'كامل',
  grace: 'فترة سماح',
  blocked: 'موقوف',
}

// Accessibility/i18n remediation (Control Plane V1, Phase 13): this map
// used to live as a standalone hardcoded-Arabic-only object directly in
// PlatformOwnersPage.tsx, bypassing the i18n system entirely -- unlike
// every other enum-label map in that file (CLUB_STATUS_LABELS/
// ACCESS_LABEL above), which are already routed through t() with this
// kind of map used only as the `defaultValue` fallback. The real i18n
// keys (platform.ownersPage.membershipStatusLabels.*) already existed
// in both common.json locales before this fix -- only the frontend
// fallback map's location was inconsistent. Moved here to match the
// established convention (one shared labels module, not a per-file
// duplicate), value unchanged.
export const MEMBERSHIP_STATUS_LABELS: Record<string, string> = {
  active: 'نشطة',
  suspended: 'موقوفة',
  removed: 'ملغاة',
}

// Master IA/UX audit (Platform Owner phase): confirmed 3 DIFFERENT
// "expiring soon" thresholds existed for the same underlying concept
// across 3 screens -- Overview used a flat 7 days regardless of
// subscription kind, Alerts used 3 days for trials / 7 for paid
// (the more business-meaningful distinction: trials genuinely need
// more urgent attention as they approach zero-notice cutoff), and
// Reports' Renewal tab used its own flat 7-day bucketing with no trial
// distinction either. A club's subscription could show as "expiring
// soon" on one screen and not another for the exact same underlying
// row. Centralized here as the single definition -- Alerts' richer
// trial/paid distinction is the canonical one (trials are the more
// urgent case), Overview and Reports now both call this instead of
// re-deriving their own threshold.
export function isSubscriptionExpiringSoon(subscriptionKind: string, endAt: string, now: Date = new Date()): boolean {
  const end = new Date(endAt)
  const daysToEnd = Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
  if (daysToEnd < 0) return false
  return subscriptionKind === 'trial' ? daysToEnd <= 3 : daysToEnd <= 7
}
