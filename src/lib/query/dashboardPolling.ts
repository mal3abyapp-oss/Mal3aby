// PERF-04 (production audit): TodayPage, AttentionNeeded, and
// OwnerFinanceTransparency each mount independently on the Today
// screen and previously each hard-coded its own `refetchInterval:
// 60_000` literal. For a club_owner (who sees all three at once --
// isOwner implies isManager, see TodayPage's role gating) that meant
// three separately-timed polling loops on one screen with no shared
// source of truth: a future edit to one literal silently drifts it
// out of sync with the other two.
//
// A single combined cross-domain RPC was considered and rejected here:
// get_today_dashboard, get_collections_report, and
// get_financial_exceptions_report are three independently-evolved SQL
// functions (each with multiple follow-up migrations hardening
// RLS/branch-scope/timezone correctness -- see
// supabase/migrations/2026081[57]*, 2026082[0146]*). Merging their
// logic into one new RPC would mean re-implementing that already
// battle-tested scoping logic in a new function, which is materially
// riskier than the finding warrants. The three components also query
// genuinely disjoint data (operational booking counts, actionable
// exception rows, finance collections) with different role gates
// (isManager||isReception vs. isOwner), so there is no redundant round
// trip to simply delete.
//
// This constant is the safer, smaller fix: one shared source of truth
// for the polling cadence so the three loops can no longer drift apart
// by accident, and so staleTime lines up with the interval instead of
// each component picking its own. It intentionally does NOT set
// refetchIntervalInBackground -- the default (false) is preserved so
// polling still stops when the tab is backgrounded.
export const DASHBOARD_POLL_INTERVAL_MS = 60_000

// PERF-04: MessagingSafetyCard.tsx polls whatsapp_queue_diagnostics
// (a view over notification_queue, RLS-gated by plain club membership)
// and get_whatsapp_status (a SECURITY DEFINER RPC gated by the
// stricter manage_whatsapp_connection permission) every 15s each.
// These were NOT merged into one call: the two sources answer
// different questions (queue backlog counts vs. account/circuit-
// breaker connection health) and, more importantly, sit behind two
// different authorization checks -- combining them into one RPC would
// mean picking a single permission gate for both, which either loosens
// the diagnostics view's exposure or needlessly hides queue counts
// behind the connection-management permission. That's a tenant/permission-
// boundary change, not a same-shape consolidation, so it's out of scope
// here. Both are aligned to this shared constant instead so the two
// timers can't drift apart from each other by accident.
export const WHATSAPP_SAFETY_POLL_INTERVAL_MS = 15_000
