# RLS & Security Definer Discipline

This file documents the specific, mandatory rules for any PostgreSQL function that runs with elevated privilege, and for protecting sensitive columns that RLS alone cannot restrict at the column level. Added as part of the Mandatory Architecture Corrections pass (2026-08-15). Read together with [RLS_MATRIX.md](RLS_MATRIX.md) (the policy pattern and per-table permission matrix), [ARCHITECTURE.md](ARCHITECTURE.md#rls-strategy), and [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md) (the business-abuse threat catalogue and the Security Gate every phase must pass — added 2026-08-15, final pre-implementation pass).

## Why this file exists

RLS policies protect rows. They do not, by themselves, protect columns, and they are bypassed *by design* inside any function marked `SECURITY DEFINER` (which runs with the privileges of the function's owner, not the calling user). Every atomic multi-table operation in this system — booking creation, invoice numbering, QR consume, refunds, enrollment capacity checks — necessarily uses `SECURITY DEFINER` to write across tables the calling user's own RLS policies wouldn't otherwise let them touch directly. That power has to be re-earned inside the function itself, explicitly, every time.

## Mandatory rules for every `SECURITY DEFINER` function

1. **Pin `search_path` explicitly.** Every `SECURITY DEFINER` function sets `SET search_path = public, pg_temp` (or the specific minimal schema list it needs) in its definition. Never rely on the caller's or the database's default search path — an unpinned `search_path` inside a `SECURITY DEFINER` function is a classic privilege-escalation vector (a malicious or shadowing object earlier in the path could be executed with the function owner's privileges).

2. **Never trust a `club_id` (or any tenant-scoping value) passed as a plain argument without verifying it against the caller's actual membership.** If a function accepts `p_club_id uuid`, its first real statement re-derives the caller's authorized club(s) from `club_memberships` via `auth.uid()` and checks `p_club_id` is among them — or, better, doesn't accept `club_id` as an argument at all where it can instead be derived server-side from the referenced row (e.g. derive `club_id` from the `field_id` being booked, not from a client-supplied parameter). A `club_id` argument is a suggestion from an untrusted client until the function proves otherwise.

3. **Always resolve identity via `auth.uid()`, never a client-supplied user ID.** Any "who is doing this" value (`created_by`, `received_by`, `marked_by`, `scanner_user_id`, etc.) is set from `auth.uid()` inside the function, never accepted as a parameter from the client.

4. **Check the specific permission inside the function, not just at the RLS layer.** Even though the outer RLS policy on the target table(s) may already gate `INSERT`/`UPDATE`, a `SECURITY DEFINER` function bypasses those same policies for its own writes — so the function must perform its own explicit `auth.has_permission('<specific.key>', v_club_id)` check before doing anything privileged. Relying on "the caller could have inserted directly anyway" is not sufficient reasoning, because the function may do more than a direct insert would have allowed (e.g. numbering an invoice, consuming a QR credential).

5. **Grant `EXECUTE` only to the roles that need it**, via `REVOKE EXECUTE ... FROM PUBLIC` followed by explicit `GRANT EXECUTE ... TO <role>` — never leave a privileged function callable by any authenticated user by default. Supabase's `authenticated` role should not automatically have `EXECUTE` on every function; grant per-function based on the permission model, not as a blanket default.

6. **Every `SECURITY DEFINER` function ships with a cross-tenant test.** At minimum: User A (Club A membership) calls the function with a Club B target (via a spoofed argument, a Club B row reference, or any other path) and the call is rejected — not silently scoped, not partially executed, rejected before any write happens. See [TEST_PLAN.md](TEST_PLAN.md) for how this integrates into the pgTAP suite.

## Sensitive column protection: `medical_notes`

RLS operates at row granularity, not column granularity — a `SELECT` policy that lets a Receptionist read a `players` row cannot, by itself, hide just the `medical_notes` column from them while showing everything else. Two patterns are viable in PostgreSQL; V1 uses the first for simplicity:

**Chosen approach — restricted view:** A `players_safe` (or similarly named) view excludes `medical_notes` and is what roles without `player.medical_notes.view` query through in the UI layer; the underlying `players` table (including `medical_notes`) is queried directly only by roles that hold the permission, gated by an additional RLS check on the base table itself (`medical_notes IS NULL OR auth.has_permission('player.medical_notes.view', club_id)` is not expressible as a column-level RLS predicate, so this is enforced by which relation — `players` vs `players_safe` — the client is authorized/expected to query, backed by application-layer discipline in `features/players/`). Global search explicitly selects only the safe column set, never `SELECT *` against `players`.

**Alternative considered, not used in V1:** PostgreSQL column-level privileges (`REVOKE SELECT (medical_notes) ON players FROM some_role`) — more "correct" at the database level but heavier to manage per-role in Supabase's role model for V1's scale; revisit if the view-based approach proves insufficient.

## Verification checklist (part of Phase 14 gate)

- [ ] Every `SECURITY DEFINER` function in `supabase/migrations/` has an explicit `SET search_path`
- [ ] No `SECURITY DEFINER` function trusts a client-supplied `club_id`/user-id argument without re-verification
- [ ] Every privileged function has a passing cross-tenant rejection test
- [ ] `EXECUTE` grants are role-specific, not blanket `PUBLIC`/`authenticated`
- [ ] `medical_notes` does not appear in any global search query or any role's default player list view without the `player.medical_notes.view` permission
- [ ] `audit_logs` has zero `UPDATE`/`DELETE` policies for any role (see [DECISIONS.md ADR-020](DECISIONS.md#adr-020--audit-logs-are-immutable-no-role-can-update-or-delete-them))
