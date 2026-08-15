# Decisions

Architecture Decision Records for Mala3by. Each entry: Decision, Reason, Alternatives considered, Trade-offs accepted. Newest first.

---

## ADR-010 — Arabic-first content, English best-effort toggle

**Decision:** V1 ships full Arabic content on every screen. English exists as a locale toggle at the architecture level (all strings i18n-keyed, `dir` attribute driven from locale) but English *content* is filled in opportunistically and may fall back to Arabic where untranslated.

**Reason:** Full bilingual content parity roughly doubles content-writing/review work across ~20 screens for no V1 benefit — the pilot club operates in Arabic. Confirmed with stakeholder (Section 35 of planning brief).

**Alternatives considered:** Full EN+AR parity from day one (rejected — schedule risk with no offsetting benefit for a single Arabic-speaking pilot club).

**Trade-offs:** English-speaking staff/customers see partial Arabic fallback until content is backfilled in V1.1. Architecture cost is zero — no rebuild needed to complete English later.

---

## ADR-009 — Invoice numbering is per-branch

**Decision:** `invoice_number_sequences` is keyed by `(branch_id, year)`. Format: `{CLUB_CODE}-{BRANCH_CODE}-{YEAR}-{000001}`.

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

**Decision:** `bookings` gets a generated `tstzrange` column and a `GIST` exclusion constraint on `(field_id, during)` excluding cancelled/no-show rows, rather than relying on application-level locking or a "check then insert" pattern in the RPC.

**Reason:** An exclusion constraint is enforced by Postgres itself against every write path — including a hypothetical buggy RPC or a direct API call — not just the happy path the app author remembered to guard. This is strictly safer than app-level checks and requires no custom concurrency code.

**Alternatives considered:** Row locking (`SELECT ... FOR UPDATE`) inside the RPC (rejected as sole mechanism — protects only the one RPC path, not defense-in-depth). Application-level check-then-insert (rejected — classic TOCTOU race under concurrent requests).

**Trade-offs:** Exclusion constraints require the `btree_gist` extension (free, standard Postgres contrib module, no cost implication).

---

## ADR-006 — No `organizations` layer above `clubs` in V1 schema

**Decision:** Drop the `organizations → clubs → branches` hierarchy from the brief. Use `clubs → branches` directly, with `clubs.organization_id uuid` present but nullable and unused until a real multi-club operator customer exists.

**Reason:** No V1 customer will populate this layer — the pilot is a single club. An always-empty ceremonial layer adds a join and a concept to every query and screen for zero near-term benefit.

**Alternatives considered:** Build the full 3-layer hierarchy now (rejected — the brief itself asked "is this necessary or can it be simplified," and it can be simplified; the column being present but nullable means adding real organization-level grouping later is additive, not a migration that touches existing data shape).

**Trade-offs:** When a genuine multi-club operator signs on, a light migration back-fills `organization_id` and adds an `organizations` table — no restructuring of `clubs`/`branches`/RLS required since the column already exists.

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

**Decision:** `subscriptions.amount_paid`, `amount_remaining`, and `invoices` outstanding balance are never stored columns treated as fact. They are computed from `payments` + `payment_allocations` at query time (or cached via trigger, but always re-derivable and reconciled against the ledger).

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
