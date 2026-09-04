// Sales Intelligence timestamps (discovery, activity, follow-ups) are
// platform-global -- unlike every other FormattedDate call site in this
// codebase, they are not tied to any one club's venue timezone (a lead
// has no club yet). FormattedDate requires an explicit IANA timeZone by
// design ("never format a raw instant without an explicit venue
// timezone" -- see formatted-date.tsx), so for this platform-scoped
// context the correct explicit choice is the viewing platform owner's
// own browser timezone: "when did I see this happen", not a business's
// operating hours. Resolved once per module load, not per render.
export const SALES_DISPLAY_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
