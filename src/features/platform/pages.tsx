// IA restructuring (Phase 4): this file used to export 4 placeholder
// screens (Subscriptions/Payments/Renewals/Settings). Confirmed as
// real nav dead-ends in MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md --
// "4 of 13 sidebar items lead to placeholder dead-ends... a user
// scanning the sidebar cannot tell which items are real without
// clicking." Their promised content already exists on real screens
// (Club Detail's subscription/billing tabs, Reports, Alerts) -- per
// the target IA (§8, step 4):
//   - /platform/subscriptions, /platform/payments, /platform/renewals
//     now redirect (via <Navigate> in router.tsx, the same pattern
//     already used for the pre-existing /app/club -> /app/settings
//     redirect) to where their real content lives, and their sidebar
//     items are removed entirely (see PlatformLayout.tsx).
//   - /platform/settings is now a real screen -- see
//     PlatformSettingsPage.tsx (a proper module, not exported from
//     this file anymore).
// This file is intentionally now empty of exports; kept (not deleted)
// only as a documented pointer for anyone following an old import path
// during the transition, per the "no orphan features" migration rule --
// safe to delete outright in a later cleanup pass once confirmed no
// stale imports remain.
export {}
