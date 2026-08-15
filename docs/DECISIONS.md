# Decisions

Architecture Decision Records for Mala3by. Each entry: Decision, Reason, Alternatives considered, Trade-offs accepted. Newest first.

> **2026-08-15 (later) — Platform Billing domain added.** ADR-022 through ADR-026 introduce platform-level billing (Mala3by charging clubs to use the platform) as a new domain, structurally separate from a club's own customer billing. This is additive V1 scope, not a correction — see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) Phase 3b.
>
> **2026-08-15 — Mandatory Architecture Corrections applied.** ADR-011 through ADR-021 below were added in a dedicated correction pass before any production code was written. ADR-006 (organizations) is **superseded** by ADR-011 — its original nullable-placeholder approach was rejected in favor of full removal. See each entry for details.

---

## ADR-026 — Grace period blocks new commitments but allows collecting on existing ones

**Decision:** While `clubs.status = 'grace_period'`, RLS is **not** a single blanket read-only switch. Per-table, per-action distinction:
- **Blocked (INSERT/UPDATE):** `bookings` (no new bookings), `enrollments` (no new enrollments), `subscriptions` (no new subscriptions), `groups`/`programs` creation, anything that creates a *new* future commitment.
- **Still allowed (INSERT):** `payments`, `payment_allocations`, `refunds` against *existing* `invoices`/`subscriptions` — the club can still collect money it's owed on obligations already in motion. `attendance` marking for already-scheduled `training_sessions` also remains allowed, since blocking it would strand players already mid-program with no way to record a session that's happening regardless.
- **Always allowed (SELECT):** everything, unchanged — full read access to bookings, customers, reports, invoices, exactly as in `active` status.

**Reason:** A hard read-only lockout the moment a club's platform payment is a day late is disproportionate and commercially hostile — a club with 40 kids mid-season shouldn't be unable to record that Ahmed showed up to training or collect a parent's cash payment because Mala3by's own invoice is pending. But grace period must still meaningfully restrict *new* business the club is transacting on top of the platform — otherwise grace period is functionally identical to `active` and has no teeth. The dividing line is "does this create a new forward-looking commitment the platform is being asked to support" (blocked) vs "does this settle an obligation that already exists" (allowed).

**Alternatives considered:** Full read-only (rejected by explicit choice — see conversation). Full read-write with only a banner warning (rejected — grace period would have no actual enforcement, defeating its purpose as a step before suspension).

**Trade-offs:** This is a materially larger RLS surface than a single status check — every write-permission policy on `bookings`/`enrollments`/`subscriptions`/`payments`/`attendance` needs an additional `clubs.status != 'grace_period' OR <this specific action is allowed in grace period>` condition, rather than one shared helper. Mitigated by a single `auth.club_write_allowed(p_club_id, p_action_category)` helper (`'new_commitment'` | `'settle_existing'` | `'operational_continuity'`) that centralizes the distinction — see [ARCHITECTURE.md](ARCHITECTURE.md#platform-billing-strategy).

---

## ADR-025 — Grace period is 7 days by default, per-club overridable, ends early on manual payment confirmation

**Decision:** `platform_subscriptions.grace_period_days` (default `7`, nullable override per club). When a platform invoice's due date passes unpaid, `clubs.status` moves from `active` to `grace_period`; a scheduled check (or on-access lazy check — see trade-off below) moves it from `grace_period` to `suspended` once `grace_period_days` have elapsed from the transition into grace period. Platform Owner recording a platform payment at any point immediately moves the club back to `active`, regardless of where it was in the countdown.

**Reason:** A fixed default with a per-club override gives predictable behavior for the common case while leaving room for Platform Owner to extend grace for a specific club relationship (e.g. a known-good club going through a temporary issue) without needing a special-cased workflow — it's just a different number in the same column.

**Alternatives considered:** No auto-expiry, Platform Owner manually suspends (rejected by explicit choice — risks unpaid clubs sitting in grace_period indefinitely with no enforcement pressure).

**Trade-offs:** The grace-period-to-suspended transition needs *something* to evaluate the elapsed time and flip the status — V1 has no scheduled job infrastructure (deliberately, to stay zero-cost — see [PROJECT_RULES.md](PROJECT_RULES.md) rule 4). Resolved as a **lazy, on-access check**: `auth.user_club_ids()` and related RLS helpers compute the effective status (`active`/`grace_period`/`suspended`) from `platform_subscriptions` + `clubs.status` + `now()` at query time rather than relying on a stored status that only a cron job would keep current. This means the transition takes effect on the next request after the deadline passes, not proactively — acceptable since the only consequence of a few extra minutes/hours in a stale `grace_period` label is staff correctly continuing to have grace-period-level access a bit longer, not a security gap.

---

## ADR-024 — Platform subscription payment is manual/offline in V1

**Decision:** A club's platform subscription payment happens outside the system (bank transfer, cash, etc., between the club and Mala3by's operator). Platform Owner manually records the receipt as a `platform_payments` row against the club's `platform_invoices`, which moves the club's status back to `active`.

**Reason:** Consistent with the already-established zero-cost-first, no-online-payment-gateway V1 rule (Stripe/Paymob explicitly deferred for club-level billing — see [PROJECT_BRIEF](../README.md) Section 43). Extending that same rule to platform-level billing avoids reopening a settled decision and avoids adding a payment gateway integration for a product with one pilot club.

**Alternatives considered:** Build a payment gateway integration for platform billing now (rejected — directly contradicts the existing zero-cost-first rule; would need its own explicit decision to reopen, which wasn't requested).

**Trade-offs:** Platform Owner must manually reconcile and record every club's platform payment — acceptable at V1's scale (one pilot club, a handful at most before this would need revisiting).

---

## ADR-023 — Single flat platform plan, manually managed, in V1

**Decision:** V1 has exactly one `platform_plans` row (e.g. "Standard"), with a price set per club on `platform_subscriptions.price_override` (nullable — falls back to the plan's default price) rather than building multiple tiers with feature gating.

**Reason:** A tiered plan/entitlement engine (different branch limits, staff seat counts, feature flags per tier) is real, non-trivial scope with no current justification — there's one pilot club, and no product signal yet about what tiers should even contain. A single plan with a per-club price override covers "charge different clubs different amounts" (the actual near-term need, e.g. an early-adopter discount) without building a gating system nothing uses yet.

**Alternatives considered:** Tiered plans with feature gating (rejected for V1 — premature, no current signal on what should differ between tiers; see [PROJECT_RULES.md](PROJECT_RULES.md) rule 6 on no premature abstraction). Usage-based pricing (rejected — most complex to build and reconcile, no justified need).

**Trade-offs:** If/when real tiering is needed, `platform_plans` already exists as a table (not a hardcoded constant), so adding a second plan row and wiring feature checks to `platform_subscriptions.plan_id` is additive — the schema doesn't block it, it just isn't built out in V1.

---

## ADR-022 — Platform billing is a structurally separate domain from club billing

**Decision:** Mala3by charging a club to use the platform is modeled with its own tables — `platform_plans`, `platform_subscriptions`, `platform_invoices`, `platform_payments` — entirely distinct from `invoices`/`payments`/`payment_allocations`/`subscriptions`, which represent money flowing between a club and *its own* customers.

**Reason:** These are two unrelated financial relationships that happen to both be called "billing": one is Mala3by↔Club (platform revenue), the other is Club↔Customer (club revenue). Conflating them into the same tables — e.g. adding a `payer_type` discriminator to `invoices` — would repeat exactly the kind of dual-purpose-table hazard already corrected once in this project (see [ADR-011b](#adr-011b--paymentsinvoice_id-removed-payment_allocations-is-the-only-payment-invoice-relationship)): RLS policies would need to branch on payer type everywhere, reports would need to filter it out everywhere, and a bug conflating the two is a bug that either overbills a customer or underbills a club's platform account. Separate tables make the two ledgers impossible to accidentally cross.

**Alternatives considered:** Reuse `invoices`/`payments` with a `scope` or `payer_type` column distinguishing platform vs. club billing (rejected — the exact anti-pattern this project already corrected once with the `payments.invoice_id` issue; two genuinely different relationships belong in two genuinely different tables).

**Trade-offs:** Some structural duplication (platform billing needs its own numbering, its own status enum, its own "payment" concept) rather than reusing club-billing machinery. Accepted because the duplication is small (4 tables, Platform-Owner-only access) and the isolation is the actual safety property being bought.

---

## ADR-021 — Exclusion constraint covers `pending_payment`, `confirmed`, and `checked_in`

**Decision:** The `bookings` double-booking exclusion constraint's `WHERE` clause is `status IN ('pending_payment', 'confirmed', 'checked_in')` — i.e. it blocks overlap for any non-terminal booking state. `completed`, `cancelled`, and `no_show` are excluded from the constraint.

**Reason:** `cancelled`/`no_show` explicitly free the slot — no correction needed there, this matches the original design. `completed` needed explicit reasoning: a completed booking's time range is necessarily in the past (you can't complete a future booking), so it can never structurally overlap with a new booking being created for a future or current slot — excluding it from the constraint is safe and avoids the constraint doing unnecessary work on historical rows. `pending_payment` was added to the blocking set — a booking awaiting payment still holds the slot; if it didn't, two receptionists could each create a `pending_payment` booking for the same slot while sorting out payment, and the constraint's whole purpose would be defeated at exactly the highest-race-risk moment (peak booking hours, near-simultaneous walk-ins/calls).

**Alternatives considered:** Only blocking on `confirmed`/`checked_in` (rejected — leaves a real race window during the payment-pending moment, which is exactly when double-booking risk is highest).

**Trade-offs:** A `pending_payment` booking that's abandoned (never paid, never explicitly cancelled) holds a slot until someone cancels it. This is an acceptable operational cost given the booking flow is designed to be seconds long (see [USER_FLOWS.md](USER_FLOWS.md)) — a stale `pending_payment` booking is a training/process issue to catch via the dashboard's "upcoming" list, not a data integrity problem.

**Boundary test confirmed:** `10:00–11:00` and `11:00–12:00` do not overlap under `[)` range semantics — `tstzrange(..., '[)')` makes the end time exclusive, so back-to-back bookings are always legal.

---

## ADR-020 — Audit logs are immutable: no role can update or delete them

**Decision:** `audit_logs` has an RLS `SELECT` policy only. There is no `UPDATE` or `DELETE` policy for any role — not Club Owner, not Platform Owner. `INSERT` happens exclusively via `SECURITY DEFINER` triggers/RPCs, never direct client insert.

**Reason:** An audit trail that any privileged user can edit is not an audit trail — it's a log that a sufficiently privileged actor can rewrite to hide their own actions. Platform Owner has no legitimate V1 need to alter historical audit data; if a correction is ever needed, the correct pattern is a new audit entry noting the correction, not mutating history.

**Alternatives considered:** Allow Platform Owner UPDATE for "fixing mistakes" (rejected — creates exactly the tamper vector audit logs exist to prevent; a "fix" is itself just a new fact, recorded as a new row).

**Trade-offs:** None — this is strictly a security improvement with no legitimate workflow it blocks.

---

## ADR-019 — Medical notes are a permission-gated field, not a default-visible one

**Decision:** `players.medical_notes` requires the explicit permissions `player.medical_notes.view` / `player.medical_notes.update`, granted by default to Academy Manager, Club Manager, and a Coach for their assigned players only. Receptionist does not see this field by default. It never appears in global search result previews.

**Reason:** Medical information is sensitive personal data with a materially different exposure risk than a name or phone number. A Receptionist's job (booking, payment, check-in) never requires reading it; defaulting it to visible-to-everyone-who-can-see-a-player-record is an unnecessary exposure with no operational benefit.

**Alternatives considered:** Same visibility as the rest of the player record (rejected — no business justification for the exposure, and it's cheap to gate properly from the start rather than retrofit after a privacy concern is raised).

**Trade-offs:** One additional permission pair to seed and check; UI needs a conditional render for this one field. Minor cost for a real privacy improvement.

---

## ADR-018 — All timestamps are `timestamptz`; club owns a display timezone

**Decision:** Every timestamp column in the schema is `timestamptz`. No booking time, session time, or audit timestamp is ever stored as a naive local timestamp. `clubs.timezone` (default `Africa/Cairo`) is the single source for how timestamps are *displayed* to that club's staff; storage is always UTC-normalized `timestamptz` under the hood.

**Reason:** This was already implicit in the original blueprint but is now stated as an explicit rule because booking/session times are exactly the kind of data that silently corrupts under DST changes or multi-timezone confusion if a naive timestamp type is ever used by mistake in a future migration.

**Alternatives considered:** None seriously — this is a correctness baseline, not a trade-off decision.

**Trade-offs:** None.

---

## ADR-017 — Single currency per club, no multi-currency in V1

**Decision:** Each club has exactly one operating `currency` (stored on `clubs`). `payments`/`invoices` do not carry their own `currency` column in V1 — they are assumed to match their club's currency. If a genuine historical/multi-currency need arises later, a `currency` column can be added to those tables at that point, constrained to match the club's currency unless multi-currency is explicitly built.

**Reason:** No V1 use case requires a club to transact in more than one currency simultaneously. Adding a per-row currency column now, with no logic that ever varies it, is a placeholder with no function — the same anti-pattern already rejected for `organization_id` (see ADR-011).

**Alternatives considered:** Add `currency` to every financial row now "just in case" (rejected — same reasoning as removing `organization_id`: no schema placeholders for unused capability).

**Trade-offs:** A genuine future multi-currency requirement (e.g. a club chain spanning two countries) requires a migration at that time. Acceptable — it's a rare, clearly-triggered event, not a silent gap.

---

## ADR-016 — Money is `numeric(12,2)`, never `float`/`double`

**Decision:** Every money-valued column (`price_per_hour`, `total_price`, `amount`, `total`, `subtotal`, `discount`, `tax`, etc.) is `numeric(12,2)` in PostgreSQL.

**Reason:** Floating-point binary representation cannot exactly represent most decimal currency values (`0.1 + 0.2 ≠ 0.3` in IEEE 754), which silently corrupts financial totals over enough operations. `numeric` is PostgreSQL's exact decimal type — no rounding drift, and `(12,2)` comfortably covers any realistic club revenue figure with 2 decimal places of currency precision.

**Alternatives considered:** Integer minor-units (piastres) storage (rejected as unnecessary complexity for this domain — `numeric(12,2)` is exact and requires no unit-conversion logic scattered through the app, unlike the integer-cents pattern common in USD-cents systems).

**Trade-offs:** None meaningful — `numeric` arithmetic is marginally slower than native float ops, utterly irrelevant at this application's data volume.

---

## ADR-015 — Membership branch scope is a join table, not a single column

**Decision:** `club_memberships` has no `branch_id` column. A new `membership_branches(membership_id, branch_id)` join table expresses branch scope. **Semantics: zero rows for a membership = all branches of that club. One or more rows = restricted to exactly those branches.**

**Reason:** The original single nullable `branch_id` column could not express "this Branch Manager works across two specific branches, but not all branches of the club" — only "one specific branch" or "all branches" (via null). A real club can absolutely have a manager covering two of three branches. A join table expresses the full range of real scoping needs without inventing a special multi-value encoding inside a single column.

**Alternatives considered:** Array column (`branch_ids uuid[]`) on `club_memberships` (rejected — join tables are easier to index, foreign-key-constrain, and query/join against cleanly in RLS policies than array-containment checks; also easier to audit membership-branch grant/revoke as discrete events later if needed).

**Trade-offs:** One additional table and join in RLS branch-scoping checks. Worth it for correctly modeling a real operational case instead of hitting a wall the first time a multi-branch manager is hired.

---

## ADR-014 — Permissions, not role keys, are the authorization source of truth

**Decision:** No application code — frontend or database function — makes an authorization decision by comparing a role key (e.g. `if role === 'accountant'`). Every authorization check, in both the UI (to decide what to show) and the RPC/RLS layer (to decide what to allow), is expressed as a permission key check (e.g. `has_permission('payment.refund')`).

**Reason:** This was already the intent of the original RLS design (`role_permissions` exists specifically for this) but is now stated as an explicit rule because it's easy to accidentally shortcut with a role-key `if` statement during UI development, which silently reintroduces the exact rigid role-coupling the permission model exists to avoid. `roles` remains a real, seeded table — it's a convenient labeling/grouping mechanism for assigning a bundle of permissions to a person — but it is never itself the thing being checked.

**Alternatives considered:** None — this is a discipline rule restating and hardening the existing design, not a new architecture.

**Trade-offs:** None. Marginally more verbose than a role check in places, in exchange for a system that survives adding a new role or adjusting one role's capabilities without a code change.

---

## ADR-013 — Subscription activation policy is a club setting, not a hardcoded rule

**Decision:** `clubs.subscription_activation_policy` is one of `manual` | `first_payment` | `full_payment`, default `first_payment`. The subscription-activation RPC branches on this value rather than hardcoding "any partial payment activates the subscription."

**Reason:** "Does a deposit activate a subscription, or does it need to be paid in full, or does staff decide manually?" is a business policy question, not a technical fact — different clubs may reasonably want different answers, and hardcoding one as if it were universally true was flagged as a real risk. A single nullable-free enum column on `clubs`, checked inside one RPC, supports all three behaviors without complex UI — it's a setting, not a feature.

**Alternatives considered:** Hardcode `first_payment` behavior only (rejected — the exact anti-pattern flagged; would require an RPC rewrite, not just a data change, the first time a club needs `manual` or `full_payment`). Build a rich policy-configuration UI (rejected — over-engineered for what is genuinely a single enum setting; a simple dropdown in club settings is sufficient).

**Trade-offs:** One additional column and one `CASE`/`IF` branch in the activation RPC. Negligible cost for avoiding a rebuild.

---

## ADR-013b — One subscription : one enrollment in V1 is a deliberate rule

**Decision:** `subscriptions.enrollment_id` is a required, unique foreign key — each subscription belongs to exactly one enrollment, and each enrollment has at most one subscription. This is enforced by a unique constraint on `subscriptions.enrollment_id`, not just documented as a convention.

**Reason:** Explicitly recorded as an intentional V1 business rule, not an oversight or an accidental limitation discovered later. It keeps the billing model simple and matches the actual V1 use case (a player's group membership is billed as one subscription). A membership/package product spanning multiple groups or sports is a materially different model — different renewal logic, different capacity implications, different pricing — and should be designed as its own thing when there's a real need for it, not bolted onto this table by loosening the constraint.

**Alternatives considered:** Allow a subscription to span multiple enrollments now, "just in case" (rejected — exactly the kind of premature generalization the project's guiding principles reject; no current use case needs it, and it would complicate every subscription-status/billing calculation for a hypothetical).

**Trade-offs:** When a genuine multi-group package product is needed, it's a new table/model, not a migration loosening this constraint — which is the intended, cleaner path.

---

## ADR-012 — Phone numbers are normalized; `mobile` is not a hard unique constraint

**Decision:** `customers` stores both `mobile_display` (as entered) and `normalized_mobile` (run through a shared normalization utility handling `010...`, `+2010...`, `002010...` as the same number). There is **no unique constraint** on phone number — instead, a non-unique index on `(club_id, normalized_mobile)` powers duplicate-detection in the UI at creation/search time.

**Reason:** A hard unique constraint on mobile number was flagged as unsafe for the real usage pattern in this market: a father may use one number for himself and multiple children's player records, a family may share one number, a customer may have no phone on file at all, and the same person may be typed in with different formats over time. A strict constraint would either reject legitimate shared-number cases or (if scoped to avoid that) fail to catch real duplicates typed in different formats — normalization plus a soft duplicate-check UI solves both problems without blocking legitimate saves.

**Alternatives considered:** Hard `UNIQUE(club_id, mobile)` (rejected — blocks legitimate shared-family-number cases). No normalization at all (rejected — `010...`/`+2010...`/`002010...` would silently register as three different customers, defeating search and creating real operational confusion).

**Trade-offs:** Duplicate customer records are still *possible* (not database-prevented) — mitigated by the UI surfacing likely matches before save, which is judged sufficient for V1 given the false-positive cost of a hard constraint would be worse than the false-negative cost of an occasional missed duplicate.

---

## ADR-011d — Player QR is reusable; Booking QR is consumable; scans are a separate log

**Decision:** Three logically distinct QR concerns, previously conflated:
1. `qr_credentials.type` is `booking` or `player_membership` only (not `subscription`).
2. `player_membership` credentials have `single_use = false` — scanning does not consume/mutate the credential; it is a lookup/validation event only.
3. `booking` credentials have `single_use = true` by default, but **consumption happens on explicit staff confirmation, not on scan alone** (see ADR-011e below).
4. Every scan — successful, replayed, expired, wrong-club, whatever — is logged to a new `qr_scan_events` table, independent of whatever state change (or lack thereof) happened to the credential. `qr_credentials.used_at`/`used_by` remain as a convenience "last use" snapshot but are not the audit trail.
5. An invoice QR (if used) is explicitly documented as a lookup/verification reference, never an access credential, and is not a `qr_credentials` row at all in the access-control sense.

**Reason:** The original design implicitly treated all QR types the same way (single-use, consumed on scan), which is wrong for a player membership card that a coach scans every training day — consuming it after the first scan would break attendance entirely. Separating "credential state" from "scan history" also fixes an audit gap: without `qr_scan_events`, there was no way to see a full history of repeated valid scans (e.g. every time a player's card was scanned for attendance) or a security-relevant pattern of failed/rejected scan attempts.

**Alternatives considered:** One generic `qr_credentials` table with `single_use` as the only variation, no separate scan log (rejected — insufficient audit trail, and conflates "current credential state" with "full history," which are different concerns with different retention/query needs).

**Trade-offs:** One additional table (`qr_scan_events`) and one more INSERT per scan. Necessary cost for correct attendance behavior and a real audit trail.

---

## ADR-011e — QR scan validates; explicit staff confirmation performs the check-in mutation

**Decision:** For booking check-in specifically: scanning a QR **only validates and displays** the booking (customer, field, time, payment status) — it does not, by itself, consume the credential or change `bookings.status`. A separate, explicit "Confirm Check-in" action performs the atomic state mutation: consumes the credential (if single-use) and transitions `bookings.status → checked_in` together, in one RPC.

**Reason:** The brief flagged a real contradiction risk: if scanning alone both consumed the QR and changed booking state, then a QR that merely passes in front of a camera (accidental scan, camera testing, a customer showing it to a friend) could silently check someone in. Requiring staff to see the validated result and explicitly confirm removes that failure mode while still keeping the overall flow fast (scan → glance → tap confirm is still a 2-3 second operation).

**Alternatives considered:** Scan = atomic validate-and-check-in in one step (rejected — the accidental-scan risk above; also removes the staff's chance to notice something wrong — e.g. wrong booking, unpaid balance — before committing the check-in).

**Trade-offs:** One extra tap in the check-in flow versus a fully automatic scan-to-checked-in. Judged worth it for the error-prevention benefit; still well within the "fast operational flow" goal.

---

## ADR-011c — Refund model: `refunds` table + reversing allocation, atomic RPC

**Decision:** Refunds use the simpler of the two options considered (a dedicated `refunds` table referencing the original `payment_id`, rather than a full generalized ledger/reversal-entry system), executed through a single atomic RPC that: (1) validates the requested refund amount does not exceed the payment's current refundable balance (`payment.amount − sum of prior completed refunds`), (2) inserts the `refunds` row, (3) inserts a reversing `payment_allocations` adjustment so the invoice's derived outstanding balance reflects the refund, (4) writes an `audit_logs` entry — all in one transaction.

**Reason:** A full double-entry ledger/reversal-entry system (Option B) was considered and rejected as more machinery than V1's actual requirement — the brief's own list of what a refund must guarantee (original payment unchanged, partial refund supported, cannot exceed refundable balance, actor/time/reason captured, balance always derivable, atomic, audited) is fully satisfiable with a dedicated `refunds` table plus a reversing allocation, without introducing a generalized ledger abstraction this product doesn't otherwise need.

**Alternatives considered:** Option B, a generalized ledger/reversal-entry model (rejected for V1 as over-engineered relative to the actual requirement — see [PROJECT_RULES.md](PROJECT_RULES.md) rule 6 on avoiding unnecessary abstraction). Mutating `payments.amount` directly on refund (rejected outright — destroys the historical record of what was actually originally paid).

**Trade-offs:** If a future need arises for more complex financial event sourcing (e.g. multi-step reconciliation workflows), this model would need to be extended — judged unlikely to be needed at this product's scale and deferred until evidence says otherwise.

---

## ADR-011b — `payments.invoice_id` removed; `payment_allocations` is the only payment↔invoice relationship

**Decision:** `payments` has no `invoice_id` column. The relationship between a payment and the invoice(s) it funds exists exclusively through `payment_allocations(payment_id, invoice_id, amount)`.

**Reason:** The original blueprint had a genuine internal contradiction — `payments.invoice_id` implied a one-payment-to-one-invoice relationship, while `payment_allocations` was simultaneously introduced specifically to support one payment funding multiple invoices (or partially funding one). Two sources of truth for the same relationship is a data-integrity hazard: which one wins if they disagree? Removing `payments.invoice_id` entirely and keeping `payment_allocations` as the single relationship path resolves this cleanly.

**Alternatives considered:** Keep both, with `payments.invoice_id` as a denormalized "primary" invoice for convenience (rejected — reintroduces exactly the dual-source-of-truth problem; any convenience query can instead join through `payment_allocations`, which is not meaningfully more expensive at this data scale).

**Trade-offs:** Looking up "which invoice does this payment belong to" always requires a join through `payment_allocations` rather than a direct column read — correct trade for a payment that may legitimately fund more than one invoice.

---

## ADR-011 — `organizations` removed entirely from V1 schema

**Decision:** No `organizations` table exists in V1. No `organization_id` column exists on `clubs` or anywhere else — not even as a nullable placeholder. Confirmed architecture: `Platform → Clubs → Branches`, full stop. **This supersedes ADR-006's original "nullable placeholder" approach.**

**Reason:** ADR-006 originally kept `clubs.organization_id` as an unused nullable column "for later." On reflection this is itself a schema placeholder for a capability with zero V1 users — exactly the anti-pattern the project's own principles reject (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 6, "no premature abstraction"). A nullable unused column still shows up in every schema diagram, every generated TypeScript type, and every developer's mental model of `clubs`, for a concept that may never be needed, or may need a different shape than guessed today when it actually is needed.

**Alternatives considered:** ADR-006's original approach — nullable placeholder column (superseded, reasoning above). Full 3-layer hierarchy built now (still rejected, same reasoning as ADR-006 — no V1 user populates it).

**Trade-offs:** If a genuine multi-club-operator customer signs on later, adding `organizations` + `clubs.organization_id` at that point is a normal additive migration (new table, new nullable FK column, backfill as needed) — no different in cost from what ADR-006 originally proposed, just deferred until the column would actually be used by something instead of sitting empty from day one.

---

## ADR-010 — Arabic-first content, English best-effort toggle

**Decision:** V1 ships full Arabic content on every screen. English exists as a locale toggle at the architecture level (all strings i18n-keyed, `dir` attribute driven from locale) but English *content* is filled in opportunistically and may fall back to Arabic where untranslated.

**Reason:** Full bilingual content parity roughly doubles content-writing/review work across ~20 screens for no V1 benefit — the pilot club operates in Arabic. Confirmed with stakeholder (Section 35 of planning brief).

**Alternatives considered:** Full EN+AR parity from day one (rejected — schedule risk with no offsetting benefit for a single Arabic-speaking pilot club).

**Trade-offs:** English-speaking staff/customers see partial Arabic fallback until content is backfilled in V1.1. Architecture cost is zero — no rebuild needed to complete English later.

---

## ADR-009 — Invoice numbering is per-branch

**Decision:** `invoice_number_sequences` is keyed by `(branch_id, year)`. Format: `{club_code}-{branch_code}-{YEAR}-{000001}`, where `club_code` and `branch_code` are read from `clubs.club_code`/`branches.branch_code` at generation time — **never a hardcoded prefix like `MAL` inside database function logic.** A club can set its own code (e.g. a different club would not be `MAL`-prefixed).

**Reason:** Confirmed with stakeholder (Section 35 of planning brief). Gives each branch's front desk an independently verifiable, gapless sequence for daily cash/invoice reconciliation without cross-branch contention on a shared counter.

**Alternatives considered:** Per-club sequence (rejected — couples unrelated branches on one counter row, and branch identity would only appear via an embedded code rather than being the actual partitioning key).

**Trade-offs:** A club with multiple branches has multiple independent number sequences rather than one global one — acceptable since invoices are always viewed in branch context anyway.

---

## ADR-008 — Subscription freeze extends expiry by default

**Decision:** `subscription_freezes.extends_expiry` defaults to `true`. When a subscription is frozen, its `end_date` shifts forward by the frozen duration once the freeze ends.

**Reason:** Confirmed with stakeholder (Section 35 of planning brief). Matches customer expectation — a paying customer who freezes for travel keeps the full paid access period, which is the safer default for retention and avoids billing disputes.

**Alternatives considered:** Fixed expiry regardless of freeze (rejected — customers lose paid days, dispute risk). Per-club configurable policy (rejected for V1 — adds a settings field and branching logic in the status/expiry RPC for a decision that has one clear right answer for this business).

**Trade-offs:** None significant; `extends_expiry` remains a column (not hardcoded) so a future club with a different policy need doesn't require a schema change, only a data value + RPC branch — deferred until actually needed.

---

## ADR-007 — Double-booking prevention via PostgreSQL exclusion constraint

**Decision:** `bookings` gets a generated `tstzrange` column and a `GIST` exclusion constraint on `(field_id, during)`, rather than relying on application-level locking or a "check then insert" pattern in the RPC. **See [ADR-021](#adr-021--exclusion-constraint-covers-pending_payment-confirmed-and-checked_in) for the exact set of statuses the constraint blocks on** — this was refined after the original draft to explicitly include `pending_payment`, not just `confirmed`/`checked_in`.

**Reason:** An exclusion constraint is enforced by Postgres itself against every write path — including a hypothetical buggy RPC or a direct API call — not just the happy path the app author remembered to guard. This is strictly safer than app-level checks and requires no custom concurrency code.

**Alternatives considered:** Row locking (`SELECT ... FOR UPDATE`) inside the RPC (rejected as sole mechanism — protects only the one RPC path, not defense-in-depth). Application-level check-then-insert (rejected — classic TOCTOU race under concurrent requests).

**Trade-offs:** Exclusion constraints require the `btree_gist` extension (free, standard Postgres contrib module, no cost implication).

---

## ADR-006 — No `organizations` layer above `clubs` in V1 schema (SUPERSEDED by ADR-011)

**⚠️ Superseded 2026-08-15.** This entry's original decision — keeping a nullable, unused `clubs.organization_id` placeholder column — was itself identified as a schema placeholder anti-pattern and reversed. **See [ADR-011](#adr-011--organizations-removed-entirely-from-v1-schema) for the current, binding decision: no `organization_id` column exists anywhere in the schema.** This entry is kept for historical record only; do not implement against it.

**Original decision (no longer in effect):** Drop the `organizations → clubs → branches` hierarchy from the brief. Use `clubs → branches` directly, with `clubs.organization_id uuid` present but nullable and unused until a real multi-club operator customer exists.

**Original reason:** No V1 customer will populate this layer — the pilot is a single club. An always-empty ceremonial layer adds a join and a concept to every query and screen for zero near-term benefit.

**Why it was superseded:** The nullable placeholder column was itself judged to be exactly the kind of premature schema element the project's principles reject — see ADR-011.

---

## ADR-005 — QR tokens are opaque random values, hashed at rest

**Decision:** QR codes encode a 256-bit random token, not a database ID or any predictable identifier. The server stores only `SHA-256(token)` in `qr_credentials.token_hash`, never the raw token.

**Reason:** Prevents QR forgery (unguessable) and prevents any information leakage if the `qr_credentials` table were ever exposed (hash isn't reversible to a usable token). Matches the brief's explicit rejection of `booking_id=1234`-style QR content.

**Alternatives considered:** Signed JWT-style tokens embedding the booking ID (rejected — more moving parts, no benefit over opaque-token + server lookup for this use case, and a leaked signing key would be catastrophic vs. a leaked hash being safe).

**Trade-offs:** Every scan requires a database round-trip (no offline/client-side validation) — acceptable and actually required anyway, since replay protection must be atomic and server-side.

---

## ADR-004 — No custom backend server; Supabase RPC covers all atomic operations

**Decision:** All atomic/multi-table business operations (booking creation, invoice numbering, QR consume, refunds) are implemented as PostgreSQL functions called via `supabase.rpc()`. No Node/Express/Nest server is introduced.

**Reason:** Supabase RLS + Postgres functions + exclusion constraints cover every atomicity and authorization requirement in the brief. Introducing a separate backend would duplicate the authorization model (RLS already does this) and add a service to host, deploy, and pay for.

**Alternatives considered:** Custom API server as a thin layer over Supabase (rejected — no functional gap it fills; violates the brief's explicit "no custom backend server if Supabase covers the need" instruction).

**Trade-offs:** Business logic that would live in "controller" code in a traditional backend instead lives in SQL/PLpgSQL — requires the team to be comfortable writing and testing Postgres functions, which the Test Plan accounts for (pgTAP).

---

## ADR-003 — Financial values are always derived, never stored as authoritative

**Decision:** `subscriptions.amount_paid`, `amount_remaining`, and `invoices` outstanding balance are never stored columns treated as fact. They are computed from `payment_allocations` (net of `refunds`) at query time (or cached via trigger, but always re-derivable and reconciled against the ledger). See [ADR-011b](#adr-011b--paymentsinvoice_id-removed-payment_allocations-is-the-only-payment-invoice-relationship) — `payment_allocations` is the sole payment↔invoice relationship this derivation reads from.

**Reason:** Storing derived financial values invites drift between the "cached" number and the real ledger — a source of bugs and financial discrepancies that are hard to detect and worse to explain to a club owner.

**Alternatives considered:** Storing and manually updating running totals on `subscriptions`/`invoices` (rejected — exactly the inconsistency risk the brief explicitly warned against).

**Trade-offs:** Slightly more complex queries (joins/aggregates instead of a flat column read); acceptable given the volumes involved (a single club's invoice/payment history, not big data).

---

## ADR-002 — Guardian is not a separate entity from Customer

**Decision:** There is one `customers` table. A customer becomes a "guardian" by having one or more rows in `guardian_links(customer_id, player_id, relationship)`. No separate `guardians` table.

**Reason:** The brief's own example — a booking customer later enrolls their kid — would otherwise require either duplicating the person as both a `customer` and a `guardian` record, or an awkward "promote customer to guardian" migration step. A single people-table with a role-indicating join table avoids duplicate-person modeling entirely.

**Alternatives considered:** Separate `guardians` table (rejected — models a role as an entity, and the brief explicitly says a customer isn't necessarily a player but doesn't say a customer and a guardian are structurally different kinds of person).

**Trade-offs:** None identified; this is strictly simpler than the alternative.

---

## ADR-001 — Booking state machine reduced to 6 states

**Decision:** `bookings.status` is one of: `pending_payment, confirmed, checked_in, completed, cancelled, no_show`. `Draft` and `Pending` (as distinct pre-confirmation states) and `In Progress`/`Refunded` (as booking-level states) from the original brief are dropped.

**Reason:** The brief itself asks that booking creation be "as few steps as possible" — a receptionist's booking flow commits directly, it doesn't pass through a separate draft-then-pending UI step in practice. `In Progress` is redundant with `checked_in` for a same-day walk-in sport-facility booking (no meaningful UI/business action differs between "checked in" and "in progress" for this use case). `Refunded` is a property of the linked payment/invoice, not the booking itself — a booking is `cancelled`, and its payment is separately `refunded`.

**Alternatives considered:** Full 9-state machine from the brief (rejected — more states to build UI for and test, with no corresponding real-world transition that needs them in V1).

**Trade-offs:** If a future need for a true multi-step draft/approval booking flow emerges (e.g. requiring manager approval before confirmation), it can be added as new status values — additive, not a rebuild.
