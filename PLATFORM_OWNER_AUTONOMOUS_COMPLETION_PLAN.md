# Platform Owner Autonomous Completion Plan

**Started:** 2026-08-29, following the real authenticated visual acceptance pass (see `PLATFORM_OWNER_CONTROL_PRODUCTION_ACCEPTANCE.md` §28).
**Baseline:** `main` @ `a18972b`.
**Mode:** Continuous discover→fix→test→visually-verify→regress loop, no owner check-ins, per the directive.

## Known concrete gaps entering this loop (from §28's TOP REMAINING GAPS + directive's own explicit scope)

1. **Provider-policy allowlist has no dedicated UI** — backend (`set_club_gateway_provider_policy`) fully live since Phase 5, no screen to use it. Directive §11/§12 requires this closed.
2. **Audit label mapping missing for new action types** — `module.entitled`, `module.unentitled`, `module.activated`, `module.deactivated`, `club_payments.enabled`, `club_payments.disabled`, `commercial_entitlements.updated` all render as raw strings in the Audit Log's Action column. Directive §21 requires this closed.
3. **Mobile Modules-tab discoverability** — at 375px, 5 tabs don't fit, Modules is scrolled out of initial view. Directive §24 requires a low-risk improvement.
4. **Over-limit UI never live-triggered** — original visual review couldn't trigger it (0 usage on the test club). Directive §14 requires creating a safe fixture and testing it for real.
5. **Support session history screen** — confirmed absent from navigation. Directive §22: build if backend data is sufficient; accept as P2 limitation only if disproportionate.

## Phases

### Phase A — Provider Policy UI (addresses gap 1, directive §11/§12)
Build a UI on Club Detail for `set_club_gateway_provider_policy` / listing `club_gateway_provider_policy` rows, showing provider/connected/enabled/platform-allowed/policy-blocked status without exposing credentials. Live-test allow→block→restore on the QA club; confirm a second club unaffected.
Status: COMPLETE — committed `b07c22f`. New RPC `get_platform_club_gateway_overview` (migration `20260829010000_platform_gateway_policy_read_rpc.sql`), `ProviderPolicyPanel` in `PlatformClubDetailPage.tsx`. Live-verified: block Stripe → SQL-confirmed `policy_blocked` → `connect_club_gateway` rejection confirmed → restore via UI → SQL-confirmed `allowed`. Cross-club isolation confirmed (zero policy rows for any other club). Side-effect fix: stale Vite `.vite` pre-bundle cache found and cleared (dev-tooling issue, not a product defect).

### Phase B — Audit Label Mapping (addresses gap 2, directive §21)
Extend `src/lib/domain/audit.ts`'s `ACTION_LABELS`/`ACTION_LABELS_EN` (and entity labels if needed) with human-readable AR/EN mappings for the 7+ action strings found live-unmapped. Live-verify in the real Audit Log UI.
Status: COMPLETE. Added AR+EN entries for `module.entitled`, `module.unentitled`, `module.activated`, `module.deactivated` (entity `club_module`), `club_payments.enabled`, `club_payments.disabled`, `commercial_entitlements.updated` (entity `commercial_entitlements`), and `club_gateway_provider_policy.updated` (entity `club_gateway_provider_policy`, newly relevant from Phase A). `tsc -b` and `eslint` clean. Live-verified in the real Club Detail → Audit Log tab: all entries (including this session's own Phase A block/restore actions) now render as readable Arabic labels instead of raw machine strings. Noted but out of scope: `payment.gateway_refund`/`payment.gateway_confirmed`/`payment.gateway_rejected`/`product.created` remain raw — these are club-tier transactional logs from already-closed prior phases, not Platform Owner control actions named in the directive's §21 list.

### Phase C — Mobile Modules Tab Discoverability (addresses gap 3, directive §24)
Low-risk fix to `PlatformClubDetailPage.tsx`'s tab bar so Modules (and other tabs) are reachable without hidden horizontal scroll at 375px — e.g. allow the tab list to wrap, or ensure a visible scroll affordance. Visually verify at 375px.
Status: COMPLETE. Fixed in the shared `TabsList` component (`src/components/ui/tabs.tsx`, used by 14 screens) rather than per-screen — a direction-aware (RTL/LTR) edge shadow that only renders on the side(s) with unscrolled content, tracked via a real scroll listener + `ResizeObserver` (a tab bar that already fits shows no shadow, unchanged from before). `tsc -b`/`eslint` clean. Live-verified at 375px on Club Detail's 5-tab bar: initial mount correctly shows only the "more content" shadow (not both), native `scrollTo()` to the far end correctly flips it, and the previously hidden "الوحدات" (Modules) and "سجل التدقيق" (Audit Log) tabs are confirmed reachable by scroll. One real bug caught and fixed during live verification: initial RTL edge-distance math was inverted (used `maxScroll - Math.abs(scrollLeft)` instead of `Math.abs(scrollLeft)`), corrected and reverified. Side-effect: the Phase A Vite pre-bundle cache staleness recurred (same root cause as before, `node_modules/.vite` stale after HMR) — cleared again, confirmed fixed via live DOM inspection (not stale console history, which is known to persist old errors after recovery).

### Phase D — Over-Limit Live Trigger with Real Fixture (addresses gap 4, directive §14)
Create a safe synthetic branch (or field) on the QA club to produce real usage > 0, set a limit below that usage via the real UI, confirm the over-limit warning renders live with correct copy, confirm no data deleted, then restore (remove the synthetic fixture, restore unlimited).
Status: PENDING

### Phase E — Support Session History Screen (addresses gap 5, directive §22)
Investigate whether `platform_support_sessions` (or equivalent) has sufficient data for a practical read-only list (support user, club, access level, reason, start, expiry, end, status). If yes, build a minimal `/platform/support` (or similar) screen. If backend data is insufficient without disproportionate new architecture, document as an accepted P2 limitation and move on — do not build new session-tracking infrastructure.
Status: PENDING

### Phase F — Full Manual-Like Journey (directive §38, 31 steps)
Execute the full journey end-to-end on the real authenticated session after Phases A-E are live, confirming no SQL is required anywhere in the loop, at 375/768/1024/1440.
Status: PENDING

### Phase G — Final Regression + Closure
tsc, lint, build, unit/integration, zero-credential E2E, targeted Platform Owner tests, migration consistency, repo hygiene, final report update.
Status: PENDING

---

Phases are additive-only in the schema sense (new tables/columns/RPCs, no destructive changes) and frontend-only where possible (Phase B, C are pure frontend; Phase A needs no new backend, RPC already exists; Phase D needs zero new schema, just fixture data; Phase E may need zero new schema if `platform_support_sessions` already has what's needed).
