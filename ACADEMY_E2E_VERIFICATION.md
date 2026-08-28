# Academy — Live Verification (Phase 4 addendum)

**Status: LIVE VERIFIED (tenant isolation, read + write).** Written
2026-08-28, part of Phase 4. Checked against real data on "QA Full Test
Club" (`6ca5315e-e199-4531-9fb1-1df358cda087`, 20 real enrollments).

## Results

| # | Attack | RPC | Result | Evidence |
|---|---|---|---|---|
| 1 | Club A owner reads a real player's 360 summary (enrollments, attendance, subscriptions) belonging to a different real club | `get_player_360_summary(p_club_id, p_player_id)` | **DENY** — `P0001: not authorized` | LIVE VERIFIED |
| 2 | Club A owner marks attendance for a real player against a real training session belonging to a different real club | `mark_attendance(p_session_id, p_player_id, p_status)` | **DENY** — `P0001: not authorized for this session` | LIVE VERIFIED |

Re-queried `public.attendance` after the denied attempt: **0 rows**
exist for that session/player pair — the denial produced zero state
change, not a partial or silent write.

## Fixtures

None created or destroyed. Read-only for #1; #2 was a genuine write
attempt that was correctly rejected before any row was inserted — no
cleanup was needed since nothing was written.

## Scope note

Enrollment-capacity rejection (a full group correctly refusing a new
enrollment) and the QR attendance path are not re-covered here — both
already have dedicated E2E coverage in `e2e/staff/academy-memberships.spec.ts`
(the capacity case is `test.fixme()`-gated pending a stable selector;
`e2e/staff/academy-memberships.spec.ts`'s coach-QR-scan-reachability
test already runs and passes without needing a live mutation). This
document adds the tenant-isolation dimension specifically, which had no
prior coverage anywhere.
