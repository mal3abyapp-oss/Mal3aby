# Platform Owner — Complete Control & Gap Analysis

**Date:** 2026-08-28
**Scope:** Full architecture/product/security review of Mal3aby's multi-tenant control model, answering one question: *can the Platform Owner centrally control every capability of every club, with clean state semantics, real enforcement, and auditability?*
**Method:** Read-only. Five parallel deep investigations (module/entitlement architecture, enforcement matrix across UI/route/RPC/RLS/public-route layers, per-domain feature depth for Branches/Fields/Academy/Memberships/Shop, payments/WhatsApp/public-route/security boundaries, and commercial/plan/subscription/limit/override lifecycle), each grounded in direct migration and live-schema reads, cross-checked against each other where their scopes overlapped. No code changed. No migrations applied.
**Nature:** Report only. Per instruction, this document does not launch further audits and implementation does not begin until explicitly approved.

---

## 1. Executive Summary

Mal3aby's Platform Owner console can genuinely and safely control the two things that matter most for platform economics — **can this club pay, and can this club create unlimited resources** — and does so with real server-side enforcement, not merely UI gating. `club_write_allowed()` is checked inside ~89 mutation RPCs; numeric limits are enforced by database triggers; neither can be bypassed by calling an RPC directly.

But the newer, more product-shaped question — **"can the Platform Owner turn a specific module on or off for a specific club and trust that the toggle does something"** — is **only true for Shop**. Academy and Fields have a `club_modules` row and a clickable toggle in the Platform Owner UI, but **zero RPC anywhere checks it**. Clicking "Disable" on Academy or Fields today updates a database row and changes nothing else — staff continue creating enrollments, marking attendance, and taking bookings exactly as before, and the public, unauthenticated booking page for a "disabled" club's Fields module keeps accepting real bookings from strangers on the internet. This is not a theoretical risk; it is a live, clickable control in production code that silently does nothing.

A second, distinct finding: the platform's newest commerce product — **Club Memberships** (a real, fully-built recurring-membership-plan system, separate from both academy subscriptions and platform billing) — was built *after* the `club_modules`/`commercial_entitlements` control architecture already existed, and was never wired into it at all. It has no entitlement toggle, no limit, and no platform visibility.

**Zero data-integrity or tenant-isolation defects were found.** No suspend/cancel RPC deletes data. RLS was not found weakened anywhere. The gaps here are entirely about *incomplete extension* of a pattern that was correctly designed and correctly executed for one module (Shop) and never carried to the others.

---

## 2. Current Architecture (ground truth)

Four structurally independent, parallel gating mechanisms exist. None derives from or defers to another — there is no computed "effective configuration," no chokepoint function, no override hierarchy. Each is enforced (where enforced at all) by hand-written checks inside individual RPC bodies:

| Gate | Reads | Enforced at | Scope |
|---|---|---|---|
| Subscription/platform access | `clubs.status`, `platform_subscriptions` | `club_write_allowed()` → `get_club_platform_access()`, ~89 call sites | Writes only, whole club |
| Module entitlement + activation | `club_modules` | `_shop_module_active()`-style helper — **exists for Shop only** | That module's reads+writes (Shop); nothing (Academy/Fields) |
| Numeric limits | `commercial_entitlements` | `BEFORE INSERT` triggers on `branches`/`fields`/`programs` | New resource creation only |
| Role permission | role/permission grants | `has_permission()`, per action | The specific action |

`platform_plans` feeds none of these at read time. It is a pricing/term template consulted exactly once, at subscription creation or renewal, to snapshot `price`/`interval`/`grace_period_days` onto the new `platform_subscriptions` row. After that snapshot, the plan is never consulted again for that subscription — it has no mechanical connection to modules or limits.

**Subscription lifecycle** is three real states (`full` / `grace` / `blocked`), computed on read, not stored:
```
full    = now() < end_at
grace   = end_at <= now() < end_at + grace_period_days_snapshot
blocked = anything else (no subscription, cancelled, admin-suspended, or grace expired)
```
"Expired" and "Suspended" are not distinct enforcement states — both collapse into `blocked`. A separate reporting RPC (`get_platform_clubs_access`) does distinguish `admin_suspended`/`no_subscription`/`expired`/`in_grace` for dashboard display, but nothing in the write-enforcement path consults it — enforcement only ever sees `full`/`grace`/`blocked`.

**During `grace`**, writes are allowed only for `settle_existing`/`operational_continuity` action categories (e.g. recording a payment against an existing invoice) — everything else is blocked, same as full block. **Reads are never gated by subscription state anywhere** — a fully blocked club can still view all its historical bookings, customers, invoices, and reports; only new writes are refused.

---

## 3. What Already Works Well (do not disturb)

- **Subscription-state enforcement is real and server-side**, confirmed by reading `club_write_allowed()`'s body and its ~89 call sites directly inside `SECURITY DEFINER` RPCs — not a client-side redirect. A direct RPC call from a blocked club fails exactly as the UI implies it will.
- **No suspend/cancel path deletes data.** Read directly: `platform_suspend_club` is a bare `UPDATE clubs SET status = 'suspended'`; `cancel_platform_subscription` is a bare `UPDATE ... SET lifecycle_status = 'cancelled'`. Neither contains a DELETE statement.
- **Subscription history is fully preserved.** `renew_platform_subscription` creates a new row linked via `previous_subscription_id` rather than overwriting the current one — the full lifecycle chain is queryable.
- **Numeric limits (branch/field/academy) are enforced by database triggers**, not application code — cannot be bypassed by any RPC or direct write, and correctly treat NULL as "unlimited" with no silent zero-as-limit bug.
- **Shop's entitlement enforcement is a genuine model to replicate.** `_shop_module_active()` is checked in every Shop read and write RPC, including a real, self-documented defect-and-fix cycle: read RPCs originally checked only a permission key and not module-active state, were found exploitable against a real test club, and were swept fixed across 7 migrations. This is exactly the rigor the same pattern needs for Academy, Fields, and Club Memberships.
- **Vault-based secret storage for payment gateways is genuinely safe.** `club_gateway_connections` stores only `secret_vault_id`/`webhook_secret_vault_id` UUID pointers — confirmed via live schema, no plaintext secret column exists anywhere.
- **Every subscription-lifecycle RPC is audited** (create/renew/cancel/extend-grace/suspend/reactivate/record-payment/reverse-payment all call `write_audit_log`) — with exactly one confirmed exception (§9).
- **Country/region-aware payment provider filtering is real and structured** — not ad-hoc — `clubs.country` genuinely filters which of the 5 catalog gateway providers a club is offered, based on real per-provider country/currency support data.
- **A previously-flagged critical cross-tenant RLS hijack in notification consent has been independently reconfirmed fixed** (found resolved during this review's security pass, unrelated to but adjacent to the control-model work).

---

## 4. Platform Owner Control Model

**The core business requirement — "the Platform Owner must be able to decide, per club, exactly which capabilities exist, are visible, are active, suspended, limited, or unavailable" — is met for exactly one module (Shop) and unmet for the rest.**

The state model itself is well-designed where it's used: `club_modules.entitled` (platform-controlled: can this club use it at all) and `.active` (club-owner-controlled: is it turned on day-to-day) are correctly kept as two independent axes with one real dependency enforced by a CHECK constraint (`not active OR entitled` — can't be active without being entitled). This directly answers the prompt's requirement to not collapse states into a single boolean — the *design* supports NOT ENTITLED / ENTITLED BUT DISABLED / ACTIVE cleanly. **The problem is that this well-designed state model has a working effect on the product for only one of the three modules it currently covers, and doesn't cover Club Memberships at all.**

SUSPENDED and EXPIRED, as distinct states, do not exist anywhere in the codebase for either subscriptions or modules — both are real UI labels layered over the same underlying `blocked` value. LIMITED BY PLAN does not exist (plans carry no limits). LIMITED BY OVERRIDE is, in effect, the *only* limit mechanism that exists (§8) — there is no unoverridden default to speak of.

---

## 5. Module Catalog

The real, current, database-enforced module catalog is exactly three keys — confirmed via a `CHECK` constraint, not inferred from the frontend:

```sql
module_key text not null check (module_key in ('fields', 'academy', 'shop'))
```

| Module | Entitlement row exists | Enforcement helper | Enforced in RPCs | Enforced in RLS | Nav hides on disable | Public route respects state |
|---|---|---|---|---|---|---|
| **Shop** | Yes (opt-in default off) | `_shop_module_active()` | **Yes** — every read+write RPC | No (by design — see §6) | Yes (`RequireShopModule`) | N/A (no public Shop surface) |
| **Academy** | Yes (backfilled on) | **None exists** | **No — zero RPCs check it** | No | **No** (permission-gated only) | N/A (no public Academy surface) |
| **Fields** | Yes (backfilled on) | **None exists** | **No — zero RPCs check it** | No | **No** (permission-gated only) | **No — confirmed live gap, see §22** |

**Not in the catalog at all:** Club Memberships, WhatsApp, Payments, QR, Reports, Public Booking, Staff Management. Of these, Club Memberships is the one that most plausibly should be (see §17) — the rest are either infrastructure-level (Payments, Staff, Reports) or deliberately kept outside this model for other reasons (WhatsApp — see §20).

---

## 6. Entitlement Architecture

Confirmed as a genuinely correct two-tier design, verified by reading the migration's own explanatory comments and the CHECK constraint enforcing the one real invariant between the tiers:

- **Entitlement** (`club_modules.entitled`) = commercial unlock, Platform-Owner-only write.
- **Activation** (`club_modules.active`) = day-to-day on/off, club-owner-only write, meaningless unless entitled.

This is not confused with permissions anywhere audited: `has_permission()` (role-based action authorization) is a wholly separate mechanism from `club_modules` (module existence). One real historical confusion was found and already fixed: Shop's *read* RPCs originally checked only `has_permission('shop.view', ...)` and never `_shop_module_active()` — meaning a club owner retained shop-read access even after entitlement was revoked, purely because the permission check doesn't know about entitlement. This exact defect class — permission standing in for entitlement — has not been checked for on Academy or Fields, because those modules have no entitlement check to confuse with a permission check at all.

**RLS deliberately never encodes module-active state, for any module, including Shop.** This is confirmed as a consistent design choice (module-state is a commercial-tier RPC-layer concern, RLS is reserved for tenant/permission isolation), not an inconsistency to fix.

No feature-flag system exists anywhere (confirmed via repo-wide grep) — there is no ENTITLEMENT/ACTIVATION/FEATURE-FLAG/PLAN-LIMIT/OPERATIONAL-STATUS confusion to find in that direction, because feature flags simply aren't a concept in this codebase yet.

---

## 7. Activation Architecture

Covered jointly with §6 above — activation (`club_modules.active`) is the club-owner's own switch, correctly modeled as read-only from the Platform Owner's UI (the Platform Owner sees but does not set `active`, only `entitled`) per `PlatformClubDetailPage.tsx`'s own explanatory comment: this "keeps that boundary honest instead of letting a platform admin silently flip a club's own operational on/off switch." This boundary is correctly held for Shop; it is moot for Academy/Fields since neither's `active` flag has any enforcement effect regardless of who sets it.

---

## 8. Plan Architecture

`platform_plans` (`name`, `name_ar`, `billing_interval`, `billing_interval_count`, `price`, `currency`, `discount_label`, `features_summary`, `default_grace_period_days`, `is_public`, `display_order`, `status`) is confirmed to be **pure pricing/term metadata with zero mechanical connection to modules or limits** — no `plan_modules` join table, no limit columns, no code path anywhere that derives a club's entitlements or limits from its plan. `features_summary` is free text, never parsed or enforced.

**This is the report's clearest, most actionable architectural gap.** A Platform Owner selling "Pro Plan" today must remember, entirely manually, to separately configure that club's `commercial_entitlements` limits and `club_modules` entitlements — nothing connects the sale to the configuration. Two clubs on the identical "Pro Plan" could silently diverge in what they're actually entitled to, with no system anywhere flagging the inconsistency.

---

## 9. Limits Architecture

Exactly three limit types exist as real columns: `branch_limit`, `field_limit`, `academy_limit` (all nullable integers on `commercial_entitlements`, NULL = unlimited). No staff/customer/product/booking limits exist anywhere in schema, despite being commercially plausible.

Enforcement is exclusively via `BEFORE INSERT` triggers on `branches`/`fields`/`programs` — confirmed as the *sole* enforcement point (no RPC independently re-checks these limits, so no drift risk between two enforcement paths).

**Confirmed gap: reducing a limit below current usage is completely unguarded.** No trigger fires on `UPDATE` of `commercial_entitlements`. A Platform Owner can set `branch_limit` from 5 to 1 on a club that already has 4 active branches — this succeeds silently, blocks only the *next* branch creation attempt, and leaves the existing over-limit state permanently unflagged anywhere in the UI.

**Confirmed gap: this table's writes are unaudited.** `PlatformClubDetailPage.tsx`'s limit-editing form performs a **direct client-side `.upsert()`** on `commercial_entitlements`, not an RPC — and no database trigger exists to compensate. Every other commercial-lifecycle table in this codebase (subscriptions, suspensions, payments) writes to `audit_logs` on every change; this is the one exception, found by direct comparison.

---

## 10. Override Architecture

The prompt's proposed `PLAN DEFAULT + CLUB OVERRIDE = EFFECTIVE CONFIGURATION` model, with a visible `PLAN LIMIT = 2 / OVERRIDE = 5 / EFFECTIVE = 5` display, **does not exist and cannot exist as designed**, because there is no plan default for anything to override (§8). `commercial_entitlements` is not an override layer sitting on top of a plan value — it is the *only* layer. Calling it an "override" is, strictly, a naming mismatch with what the architecture actually does; the correct framing for the target architecture (§37) is that a plan should define real defaults, and `commercial_entitlements` should become genuinely subtractive/additive against them.

No `get_club_effective_config()`-style merge function exists anywhere (confirmed via grep) — every consumer (RLS, RPCs, the Club Detail page) independently re-derives its own slice of "what can this club do" from whichever of the four gates in §4 is relevant to it.

---

## 11. Subscription State Model

See §2 for the full derivation. Restated as a direct table against the prompt's requested taxonomy:

| State | Login? | Read? | Write? | Public booking? | Payments? | Shop? | Academy attendance? | WhatsApp? | Reports? |
|---|---|---|---|---|---|---|---|---|---|
| Trial (`full`) | Yes | Yes | Yes | Yes | Yes | Yes (if entitled) | Yes | Yes | Yes |
| Active/paid (`full`) | Yes | Yes | Yes | Yes | Yes | Yes (if entitled) | Yes | Yes | Yes |
| Grace | Yes | Yes | **Only settle-existing/operational-continuity actions** | Confirmed unaffected (see §22 — public booking doesn't check subscription state either, a separate finding) | Payment-settling writes only | Blocked (new sales are a "new commitment," not settle-existing) | Blocked (new enrollment/attendance writes are blocked; historical data still readable) | Unaffected (WhatsApp isn't gated by this mechanism at all) | Yes (reads never gated) |
| Blocked (expired/no-sub/cancelled) | Yes (auth ≠ club access) | Yes | **No** | Confirmed unaffected — see §22 | No | No | No | Unaffected | Yes |
| Suspended (`clubs.status`) | Yes | Yes | **No** (collapses to `blocked`) | Correctly blocked — `get_public_club` independently checks `status='active'` | No | No | No | Unaffected | Yes |

The Trial row's "no grace period" behavior (grace is hardcoded to 0 days for trials specifically, confirmed via `create_platform_subscription`) is a real, deliberate, and reasonable design choice, not a gap.

---

## 12. Suspension Model

The genuinely-implemented suspension levels are: **platform/club-wide** (`clubs.status = 'suspended'`, `platform_suspend_club`) and **subscription-derived** (`blocked`/`grace`, automatic from date math). **Module-level suspension does not meaningfully exist** — `club_modules.active = false` is the closest analog, but as established in §5, it has zero enforcement effect for Academy/Fields. Payment-suspension and public-booking-suspension as *independent* levers (distinct from the whole-club subscription block) do not exist — see §14 (no payment kill switch) and §22 (public booking doesn't check either subscription or module state, so it can't currently be selectively suspended at all).

---

## 13. Club 360 Model

The existing `PlatformClubDetailPage.tsx` (confirmed via prior review to be the single largest file in the tier, ~1,300 lines) already implements a genuine subset of the requested Club 360 sections well: Overview (identity/owner/summary cards), Subscription (full lifecycle actions with typed reasons), Modules (the Shop/Academy/Fields entitlement tab), Audit. It does not yet have distinct Limits, Payments-as-gateway-oversight, or Support sections as separate, purpose-built areas — Payments today means platform billing only (§14), and Limits is folded into an "editing" sub-panel rather than a first-class section showing plan-default/override/effective values (because, per §10, there is no plan-default to show).

The target Club 360 structure (§33) should make explicit what's currently implicit: a **Modules & Limits** section showing entitled/active/limit/usage for every real module, with the same enforcement guarantee (RPC-checked, not just UI-displayed) for all three, plus Club Memberships added as a fourth row once wired into the entitlement system.

---

## 14. Branch Controls

| Control | Status |
|---|---|
| Max branch count | **EXISTS** — `commercial_entitlements.branch_limit`, trigger-enforced |
| Enable/disable a specific branch | **MISSING at platform level** — `manage_branch()` supports an inactive status but is club-permission-gated only; no Platform Owner RPC exists |
| Branch creation availability (independent of the count limit) | **MISSING** — only indirectly capped via `branch_limit` |
| Branch-specific module scoping | **MISSING** — `club_modules` has no `branch_id`; entitlement is club-wide only |
| Branch-specific payment methods | **MISSING** — `payment_method_configs` has no `branch_id` |
| Any per-branch platform control surface at all | **MISSING** — the only branch data in the entire Platform Owner console is a read-only count |

---

## 15. Field Controls

Platform Owner controls exactly two things for Fields: entitlement on/off (currently a no-op — see §5) and the numeric field-count limit (real, trigger-enforced). Every other operational facet named in the review directive — public visibility, QR booking, online-booking window, recurring bookings, pricing-rule features — is **100% club-owner-controlled with zero platform override anywhere**, confirmed by reading each relevant RPC's authorization check directly.

---

## 16. Academy Controls

Same shape as Fields: entitlement toggle exists but is a confirmed no-op (§5), the `academy_limit` numeric cap is real and correctly counts billable groups (not raw programs, per a later migration's deliberate correction). Attendance and QR-attendance have no separable control from the whole-module toggle. Real schema dependencies confirmed: Academy has a genuine FK into Customers (`enrollments.guardian_id`) and into Fields (`groups.field_id`, `training_sessions.field_id`) — meaningful for the dependency graph in §26 — and only a soft, RPC-level (not FK) coupling to WhatsApp.

**The sidebar-hiding gap is confirmed to be worse for Academy than the general "no role-filtering" finding from a prior review implies**: it's not just that every role sees the Academy nav item — the nav item's visibility is entirely disconnected from whether the module is even entitled at all. A club with Academy fully disabled by the Platform Owner still sees a working "Academy" link in its own sidebar, leading to fully functional pages.

---

## 17. Membership Controls

**A real scope finding, not an assumption:** two unrelated things share the word "membership" in this codebase, plus a third genuine commerce concept that must not be confused with either:
1. `club_memberships` — internal staff-to-club role assignment (a permissions table, not a product).
2. Academy `subscriptions` — the recurring-payment mechanism for academy enrollment specifically.
3. **`club_membership_plans`/`club_membership_subscriptions`** — a real, fully-built, recently-added (2026-08-26) customer-facing commerce product for gym/club-style recurring memberships, explicitly documented in its own migration as distinct from both of the above.

**Item 3 is the one this section is actually about, and it is confirmed to sit entirely outside the Platform Owner's control plane**: not one of the three `club_modules.module_key` values, no limit column in `commercial_entitlements`, no platform-level visibility beyond whatever a generic report might show. It launched with real product depth (freeze, renewal, branch-scoping, idempotent sale keys) but zero platform governance — the newest commerce module has *less* central control than the oldest ones, despite the governing pattern (`club_modules`) already existing when it was built.

---

## 18. Shop Controls

**Confirmed atomic, not granular, by schema constraint** — the `module_key` CHECK permits exactly one value (`'shop'`) for the entire domain; there is no `shop_inventory`, `shop_stock_count`, `shop_reports`, etc. as separate keys, and `set_club_module_entitlement`'s signature has no sub-feature parameter. Products, Categories, Inventory, Suppliers, Stock-Count, Returns, Discounts, Reports, Receipts, and Media are all gated by the same single `_shop_module_active()` check plus ordinary permission keys — there is no independent on/off for any one sub-feature. This atomicity appears to be a reasonable current-scale choice, not an oversight — the report does not recommend fragmenting it without a specific commercial reason to sell one Shop sub-feature separately from another.

**Data-visibility behavior on disable is the strictest of any module**: because `_shop_module_active()` is checked in both reads and writes, disabling Shop makes historical sales/inventory data **completely inaccessible**, not merely hidden or read-only. This is worth a product decision, not a code defect: a club that temporarily loses Shop entitlement currently cannot even view its own past sales for record-keeping. Compare directly with Academy/Fields, where disabling currently changes nothing at all — the platform's three modules are internally inconsistent about what "disabled" even means for existing data.

---

## 19. Payment Controls

- **Provider catalog**: real and structured (`payment_gateway_providers`, 5 providers with per-provider country/currency support), but it is a **platform-wide catalog any club can draw from**, not a per-club allowlist — there is no mechanism for a Platform Owner to restrict which of the 5 a specific club may connect.
- **Platform-level payment kill switch**: **confirmed MISSING** — no RPC lets a Platform Owner centrally disable all online payments for one club independent of that club's own gateway connections. The only blunt instrument is full club suspension (which blocks everything, not payments specifically).
- **Credential safety**: confirmed genuinely vault-referenced — `secret_vault_id`/`webhook_secret_vault_id` are UUID pointer columns only; no plaintext secret column exists anywhere in the payment-gateway schema.
- **Webhook/reconciliation data**: the underlying schema (`payment_gateway_webhook_events`, connection-health timestamps) already exists and is surfaced club-side; no platform-wide cross-tenant aggregation exists yet, but the data model is ready for one to be built without new tables.

---

## 20. WhatsApp Controls

Reviewed theoretically only, per explicit instruction — no code touched. WhatsApp is confirmed to be a genuinely separate, always-available concept: it is **not** one of the three `club_modules` keys, and its connection/consent/queue state lives in its own dedicated, RLS-locked (deny-all, RPC-only) tables. This is consistent with WhatsApp's status (from a prior engagement) as a hardened, closed area — the report does not recommend folding it into `club_modules` without new, explicit cause, since doing so would touch protected territory. Documented here as current-state only.

---

## 21. Public Feature Controls

Public/anonymous surfaces in the entire router: marketing pages, `/onboarding`, `/verify/:token` (invoice verification), `/qr/:token`, `/activate/:token`, and **`/c/:slug`** — the only real anonymous storefront, a public Fields booking page. There is no public Academy registration route and no public Shop storefront route anywhere in the router — those risks are moot because those surfaces don't exist, not because they were deliberately guarded.

**`/c/:slug` (Fields public booking) does not check module entitlement/activation state at all** — confirmed by reading both backing RPCs' live SQL bodies directly (`get_public_club`, `create_public_booking`, both `anon`-executable). They correctly check `clubs.status = 'active'` (so a suspended club's public page is genuinely blocked) and `get_public_club_subscription_access(...) != 'blocked'` (so an expired club's public page is genuinely blocked) — but **neither references `club_modules` anywhere**. This means: **a Platform Owner can click "Disable" on a club's Fields entitlement in the live Platform Owner UI today, and that club's public booking page will keep accepting real, unauthenticated bookings from anyone with the link, completely unaffected.** This is the single most concrete, most severe finding in this entire report — it is reachable by anonymous internet users, not merely by a club's own staff, and it directly defeats a control the Platform Owner UI presents as working.

---

## 22. Staff / Permission Relationship

Confirmed correctly separated in principle — Platform Owner controls module existence, club owner controls role permissions within it — but the separation is only *meaningfully enforced* for Shop. For Academy and Fields, since there's no RPC-level module check at all, a staff member's ordinary `enrollment.create`/`booking.create` permission is *sufficient by itself* to bypass the Platform Owner's module-disable decision entirely — the two layers aren't just "correctly separated," they're accidentally *equivalent* right now (permission alone determines access; the entitlement layer contributes nothing).

---

## 23. Route Enforcement

Confirmed inconsistent across the three modules:

| Layer | Shop | Academy | Fields |
|---|---|---|---|
| UI guard (`Require<Module>Module`) | Exists (`RequireShopModule`) | Missing | Missing |
| Route guard placement | Partial — embedded in `ShopLayout.tsx` around the Outlet for most routes, but applied route-element-level for `reports/shop` specifically — two inconsistent patterns within the same module | N/A (no guard exists) | N/A (no guard exists) |
| Nav item hides on disable | No (permission-gated only, not entitlement-gated) — a genuine, separate gap even for Shop | No | No |

Even Shop, the best-covered module, has an internal inconsistency in *where* its route guard is applied — worth a small hardening pass independent of the larger Academy/Fields gap.

---

## 24. RPC / Server Enforcement

This is the core finding of the report, stated once plainly: **`_shop_module_active()`-equivalent enforcement exists only for Shop.** No `_academy_module_active()` or `_fields_module_active()` function exists anywhere in the schema (confirmed via direct `pg_proc` query against the live database, not just a migration grep) — this is not a partial or inconsistent implementation for those two modules, it is a clean, total absence. Sampled write RPCs for both (enrollment creation, attendance marking, booking creation) confirm zero references to `module_active`/`club_modules` in any of them.

---

## 25. RLS / Isolation

Confirmed as consistently tenant/permission-scoped only, across every table sampled for every module (Shop, Academy, Fields, payment gateways, government compliance, club modules themselves) — no RLS policy encodes module-active state for any module, which is a deliberate, consistent design choice rather than something to "fix," and no RLS policy was found weakened by anything related to the Platform Owner control surfaces reviewed. One previously-flagged critical cross-tenant RLS defect (notification consent self-service) was independently reconfirmed as already fixed during this pass.

---

## 26. Module Dependencies

Real, FK-confirmed hard dependencies found:
- **Shop → Customers** (required, not nullable — a sale cannot exist without a real customer row). Customers itself is not a toggleable module, so this is unconditional infrastructure.
- **Shop → Branches** (conditional — only for branch-kind inventory locations, not warehouse-kind).
- **Shop → Invoices/Payments** (hard, via reuse of the existing `invoices` table rather than a duplicate schema).
- **Shop ↛ Academy**: confirmed *no* dependency, by explicit prior design decision (products belong to the club, never to an academy).
- **Academy → Customers** (`enrollments.guardian_id`, nullable FK) and **Academy → Fields** (`groups.field_id`, `training_sessions.field_id`) are both real, schema-level dependencies.
- **Academy ↔ WhatsApp**: soft/functional coupling only (an RPC sends a WhatsApp message on payment), no FK dependency.

**Recommendation for the target architecture (§37):** given Academy has a real FK dependency on Fields, disabling Fields for a club that has Academy active and using field-scheduled groups should at minimum WARN, and disabling both together needs explicit product thought — this dependency is not enforced or even flagged anywhere today, since neither module's disable path does anything at all yet.

---

## 27. Audit Requirements

Every subscription-lifecycle RPC (create/renew/cancel/extend-grace/suspend/reactivate/record-payment/reverse-payment) is confirmed audited. **One confirmed, concrete gap**: `commercial_entitlements` (branch/field/academy limit) changes are written via a direct client-side `.upsert()` with no backing RPC and no compensating database trigger — this is the single unaudited commercial-change surface in an otherwise consistently-audited system. Support-session and platform-staff action types were found in a prior review to render as raw unmapped strings in the audit log UI (a presentation gap, not a logging gap — the events are captured, just not human-readable yet).

---

## 28. Platform Owner Dashboard Requirements

Not re-investigated in full depth this pass (already covered by a prior visual review) — restated briefly for completeness: club counts, module adoption, and a rules-based "needs attention" panel exist in a strong, exception-first design for subscription/WhatsApp signals specifically, but do not yet cover module-adoption breakdown (Shop/Academy/Fields/Memberships), gateway health, or dormancy signals. See the separately-published `PLATFORM_OWNER_EXPERIENCE_REVIEW.md` for the full visual/UX-level treatment of this area — this report does not duplicate that analysis.

---

## 29. Club Health Requirements

Same note as §28 — a rules-based, non-AI "needs attention" section already exists and is well-built for the signals it covers (WhatsApp health, flagged duplicates, no-subscription clubs, pending requests). It does not yet incorporate module-disable-had-no-effect as a signal (impossible today, since the toggle has no effect to detect) or gateway/payment health. Once §5's core gap is fixed, "module entitlement says off, but the club is still writing to it" becomes a legitimately valuable health signal to add.

---

## 30. Payment/Gateway Oversight

Covered fully in §19. Restated as the two actionable gaps: no per-club provider allowlist (any club can connect any of the 5 catalog providers), and no platform-level payment kill switch independent of full club suspension.

---

## 31. Support Sessions

Not re-investigated in depth this pass (covered fully by the prior `PLATFORM_OWNER_EXPERIENCE_REVIEW.md`, which found the live support-session UX itself strong — explicit VIEW/MANAGE mode choice, a persistent full-width "you are in support context" banner, explicit exit — with the concrete gap being that session start/end events render as raw unmapped audit strings, and no dedicated session-history screen exists yet). Nothing in this pass's findings changes that assessment or weakens the existing support-session security model.

---

## 32. Global Search

Not re-investigated this pass — per the prior review, `PlatformGlobalSearch` covers clubs and owners only, routing every result to Club Detail. This report adds one note: once Club Memberships is wired into the control model (§17), it should be reachable from Club Detail like every other module, not require a separate search path.

---

## 33. UX/IA Recommendation

The existing Club Detail "Modules" tab is the right foundation and should be extended, not replaced:

```
Club 360
 ├ Overview
 ├ Subscription           (existing — strong)
 ├ Modules & Limits        (extend existing Modules tab)
 │   Module         Entitled   Active    Enforcement    Limit    Usage
 │   Fields         ✓          ✓         ⚠ not wired    12       9
 │   Academy        ✓          ✓         ⚠ not wired    5        3
 │   Shop           ✓          ✕         ✓ enforced      —        —
 │   Memberships    —          —         — not modeled   —        —
 ├ Operations             (existing summary cards)
 ├ Payments               (existing — platform billing only; extend per §19)
 ├ Support                (existing session start; add history per §31)
 └ Audit                  (existing — strong)
```

The "Enforcement" column above is a deliberately new, honest addition: it should show the Platform Owner directly, in the UI, whether a toggle they can click actually does anything server-side — surfacing exactly the gap this report found, so it can never again look identically "controlled" for a module that isn't.

---

## 34. Gap Matrix

| Capability | Current State | Required State | Gap | Severity | Architectural Impact | Security Impact | UX Impact |
|---|---|---|---|---|---|---|---|
| Fields module disable | Toggle exists, zero enforcement anywhere (RPC, RLS, public route) | Toggle blocks all reads/writes and public booking | Full enforcement layer missing | **P0** | New helper fn + ~15-20 RPC call sites | Anonymous users can transact against a "disabled" module | Toggle currently lies to the operator |
| Academy module disable | Toggle exists, zero RPC enforcement | Toggle blocks all reads/writes | Full enforcement layer missing | **P0** | New helper fn + RPC call sites | Staff-level bypass only (not anonymous) | Same as above |
| Public booking vs. subscription/module state | Subscription-blocked correctly denied; module-disabled not denied | Both should be denied | Module-state check missing from 2 public RPCs | **P0** | Small, surgical — 2 RPC bodies | Anonymous, unauthenticated exposure | None if fixed correctly |
| Club Memberships entitlement | Not in `club_modules` at all | Should be a 4th module key | New module registration + enforcement | **P1** | Moderate — new module wiring, following the Shop template | None currently (just unmanaged, not insecure) | Platform Owner currently blind to this product |
| Plan → module/limit linkage | None — plans are pricing-only | Plan should define default modules/limits | New join table + read-path change | **P1** | Moderate-large — touches subscription creation flow | None | Root cause of "two clubs, same plan, different reality" |
| Limit reduction below usage | Unguarded, silent | Should flag/prevent/warn | New guard logic | **P1** | Small | None (no data loss, just silent inconsistency) | Confusing for operator |
| `commercial_entitlements` auditability | Unaudited direct client upsert | Should audit-log like every other commercial change | Convert to RPC or add trigger | **P1** | Small | Minor — no attacker benefit, but breaks audit completeness | None |
| Payment kill switch per club | Missing | Platform Owner should be able to disable payments without suspending the whole club | New RPC + UI control | **P2** | Small-moderate | None | Real operational gap for a genuine support scenario |
| Gateway provider allowlist per club | Missing (global catalog only) | Optional per-club/plan restriction | New table + check | **P2** | Small | None | Only matters if commercial policy requires it |
| Nav hides on module disable | Missing for all 3 modules | Nav should reflect entitlement, not just permission | Frontend-only change once RPC enforcement exists | **P2** | Trivial once §5 fixed | None | Currently misleading for staff |
| Shop route-guard placement inconsistency | Works but inconsistently placed | Uniform route-level guard | Refactor guard location | **P3** | Trivial | None (RPC/RLS still hold) | None user-visible |

---

## 35. Risk Register

1. **Anonymous booking bypass of a disabled Fields module** — the highest-risk item in this report. Reachable by anyone with a club's public URL, requires no account, and directly contradicts what the Platform Owner UI presents as true. Recommend fixing before any other item in this report.
2. **Staff-level bypass of a disabled Academy module** — lower risk than #1 (requires an existing staff account with ordinary permissions, not privilege escalation) but has the same root cause and should be fixed in the same pass.
3. **Silent commercial drift** (plan says one thing, actual entitlements/limits say another, nothing flags the mismatch) — low acute risk, but compounds over time as the club base grows and becomes harder to reason about the more clubs and plans exist.
4. **Unaudited limit changes** — low risk on its own (no attacker benefit; a Platform Owner's own console), but is a genuine audit-completeness gap that would matter in any future compliance or dispute context.

No risk was found rising to active data loss, cross-tenant data exposure, or credential exposure — the register above is entirely about *control gaps*, not *breach* conditions.

---

## 36. What NOT To Change

- The four-gate parallel architecture itself (subscription/module/limit/permission as independent checks) — this is a reasonable design; the fix is to *complete* module enforcement for Academy/Fields following Shop's exact template, not to redesign the relationship between the four gates.
- `club_write_allowed()` and its ~89 call sites — confirmed correct and consistently applied; do not touch.
- The Entitled/Active two-tier module model — correct as designed; extend it to new modules, do not collapse it.
- Shop's atomic (non-granular) sub-feature model — reasonable at current scale; do not fragment without a specific commercial reason.
- WhatsApp's separateness from `club_modules` — this was a deliberate, protected decision from a prior engagement; do not fold it in without new, explicit instruction.
- Any suspend/cancel RPC's data-preservation behavior — confirmed correct (no deletes); do not "clean up" data on disable for any module.
- RLS's deliberate exclusion of module-state checks — correct separation of concerns; do not push module-active logic into RLS policies.

---

## 37. Proposed Target Architecture

1. **A canonical `<module>_module_active(club_id)` helper for every real module**, following `_shop_module_active()`'s exact pattern, wired into every read and write RPC for that module — Academy and Fields first, Club Memberships once registered.
2. **Club Memberships added as a fourth `club_modules.module_key` value**, with its own limit column on `commercial_entitlements` if a seat/plan-count cap is commercially desired.
3. **A `plan_modules` (or equivalent) join, and limit columns on `platform_plans`**, so that assigning a plan to a club can *seed* — not silently replace — that club's `club_modules`/`commercial_entitlements` rows. `commercial_entitlements` then becomes a genuine override layer (plan default + club override = effective), matching the model the original prompt described, rather than the sole source it is today.
4. **A guard (trigger or RPC check) on `commercial_entitlements` updates** that at minimum flags — does not need to block — a reduction below current usage, plus routing all writes to it through an audited RPC instead of a direct client upsert.
5. **Nav visibility driven by entitlement state, not permission alone**, for all three (soon four) modules, once the RPC-layer enforcement in item 1 exists to back it up.

---

## 38. Migration Strategy

- All new enforcement helpers are additive (`_academy_module_active()`, `_fields_module_active()`) — no existing function signature changes, so this is low-risk to ship incrementally, module by module, exactly as Shop's own hardening was done across 7 sequential migrations.
- Every existing club is currently backfilled to `academy: entitled=true, active=true` and `fields: entitled=true, active=true` — so turning on enforcement for the first time changes behavior for **zero** clubs today (everyone stays entitled+active); the risk only appears the first time a Platform Owner actually uses the toggle, which is exactly when the fix needs to already be live.
- Club Memberships' new module row should also backfill every existing club to `entitled=true, active=true` for continuity, mirroring the Academy/Fields backfill precedent — do not silently turn off a product clubs are already using.
- Plan→module/limit linkage should be introduced as an optional, nullable relationship first (plans MAY define defaults) so it doesn't force an immediate reconciliation of every existing plan/club pairing.

---

## 39. Implementation Roadmap

Derived from the actual findings above, not the illustrative example in the prompt:

- **PO-A — Module Enforcement Parity (P0).** Build `_academy_module_active()`/`_fields_module_active()`, sweep every Academy/Fields read+write RPC (mirroring the 7-migration Shop precedent exactly), fix the two public-booking RPCs to also check module state. This alone closes both P0 findings in the gap matrix.
- **PO-B — Club Memberships Governance (P1).** Register `club_membership` as a fourth module key, wire its own enforcement helper, backfill existing clubs, surface it in the Club Detail Modules tab.
- **PO-C — Plan-to-Entitlement Linkage (P1).** Add the optional `plan_modules`/plan-limit-default schema, wire it into subscription creation as a seed (not override) of `club_modules`/`commercial_entitlements`.
- **PO-D — Limits Auditability & Guardrails (P1).** Route `commercial_entitlements` writes through an audited RPC; add a soft warning (not a hard block) for reducing a limit below current usage.
- **PO-E — Payment Oversight Controls (P2).** Per-club payment kill switch; optional provider allowlist, if commercially needed.
- **PO-F — Nav & UX Parity (P2).** Entitlement-driven nav hiding for all modules; the "Enforcement" column in the Modules tab described in §33.
- **PO-G — Acceptance & Regression (P0-adjacent, always last).** Live-verify each module's disable-toggle genuinely blocks reads/writes/public-access before considering any phase above complete — this report's own findings are proof that "the toggle exists" is not sufficient evidence of "the toggle works."

---

## 40. Acceptance Criteria

For each module (Fields, Academy, Shop, Memberships once built):
1. Setting `entitled=false` (or `active=false`) causes every write RPC for that module to reject, verified by direct RPC call (not just UI), for a real test club.
2. The same setting causes any public/anonymous surface for that module to reject or hide, verified by direct anonymous RPC call.
3. Historical data behavior on disable is a deliberate, documented product decision (fully hidden like Shop, or read-only-preserved) — not left undefined per module.
4. The Platform Owner UI's "Enforcement" indicator (§33) matches reality for every module before this roadmap is considered complete.
5. `commercial_entitlements` changes appear in the audit log with the same fidelity as every other commercial change.

---

## Final Response

```
PLATFORM OWNER COMPLETE CONTROL AUDIT = COMPLETE
CURRENT CONTROL MATURITY = Uneven — one module (Shop) is fully and correctly enforced end-to-end; the platform's core subscription/limit gates are genuinely solid; module-level control for the other two existing modules is decorative only, and the newest commerce product (Memberships) isn't in the control model at all.
P0 = 3
P1 = 4
P2 = 3
P3 = 1

CAN PLATFORM OWNER CURRENTLY CONTROL ALL CLUB MODULES CENTRALLY = NO

MODULES WITH INCOMPLETE CENTRAL CONTROL =
- Academy (entitlement toggle is a no-op at every enforcement layer)
- Fields (entitlement toggle is a no-op; additionally bypassable by anonymous public booking)
- Club Memberships (not registered in the entitlement system at all)

TOP 10 ARCHITECTURAL / OPERATIONAL GAPS =
1. Fields module-disable does not propagate to the public, unauthenticated booking page — anonymous users can transact against a club whose Fields module the Platform Owner turned off.
2. Academy module-disable has zero RPC-level enforcement — any staff member with ordinary permissions can continue using it regardless of the toggle.
3. Fields module-disable has zero RPC-level enforcement for authenticated staff use, same root cause as #2.
4. Club Memberships — a real, fully-built commerce product — has no entitlement toggle, no limit, and no platform visibility at all.
5. `platform_plans` has no mechanical connection to modules or limits — a plan is pricing-only, so two clubs on the same plan can silently diverge in actual entitlements.
6. `commercial_entitlements` (branch/field/academy limits) is written via a direct, unaudited client-side upsert — the one gap in an otherwise fully-audited commercial-change surface.
7. Reducing a limit below a club's current usage is completely unguarded and silent.
8. No per-club payment kill switch exists independent of full club suspension.
9. No per-club payment-provider allowlist exists — any club can connect any of the 5 catalog gateways.
10. Nav visibility for all three modules is permission-based only, never entitlement-based — a disabled module's nav item can still appear and lead to a fully working page.

TARGET ARCHITECTURE = Extend Shop's proven entitlement-enforcement pattern (a per-module RPC-layer active-check, applied to every read/write, including public surfaces) to Academy, Fields, and a newly-registered Club Memberships module; introduce an optional plan-to-entitlement seeding relationship so plans stop being purely cosmetic; close the one unaudited commercial-write path.

IMPLEMENTATION PHASES = 7 (PO-A through PO-G)

REPORT = PLATFORM_OWNER_COMPLETE_CONTROL_AUDIT.md

NEXT ACTION = WAIT FOR OWNER APPROVAL BEFORE IMPLEMENTATION
```

**STOP.**
