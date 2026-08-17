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
