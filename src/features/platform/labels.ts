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
