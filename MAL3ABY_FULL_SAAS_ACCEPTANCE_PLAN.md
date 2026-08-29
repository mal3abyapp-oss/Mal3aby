# MAL3ABY — FULL SAAS PRODUCTION ACCEPTANCE PLAN

**Started:** 2026-08-29
**Mode:** Autonomous execution, no approval checkpoints, per explicit directive.
**Baseline commit:** `b0efbb7`

## Ground rules (from directive)
- Discover → analyze → fix → test → live-verify → regression → continue. No stopping between phases.
- P0/P1: auto-fix. P2 low-risk + clear: fix. P3: document only, no endless polish.
- Never weaken security to pass a test. Never touch real financial history. QA fixtures only, fully cleaned up.
- True stop conditions only: irreversible real-financial-data edit required, new paid external service required, unresolvable real security conflict, materially ambiguous accounting rule with real-money impact, total credential/infra blocker. Nothing else stops execution.
- Browser-blocked persona → `ENVIRONMENT-BLOCKED`, documented, continue rest.

## Phases

1. **Baseline + Environment** — confirm repo clean, build/test/lint green, identify real QA identities (already established from prior anti-fraud engagement), confirm Supabase MCP + Browser access.
2. **Platform Owner Acceptance** — full journey: club directory, Club360, club lifecycle (create/suspend/reactivate), subscriptions/plans/trial/grace/expired, modules, platform staff/roles/permissions, support sessions, audit logs, platform reports/analytics/health, settings.
3. **Club Owner Acceptance** — full journey: branches, fields, bookings/calendar, customers, academy (groups/players/enrollment/subscription/attendance/QR), club memberships, shop/POS/inventory, payments/cash, reports, printing, settings.
4. **Club Staff / Permissions Acceptance** — test Owner/Manager/Receptionist/Cashier/Coach/Custom-role personas; nav visibility vs RPC/RLS enforcement; branch scope; escalation attempts.
5. **Customer / Player Acceptance** — portal registration/login, public booking flow, bookings/payments/invoices/QR/memberships/academy view, new-customer and returning-customer journeys.
6. **Cross-Module Journeys** — booking→invoice→payment→report; shop sale→inventory→return→refund; academy subscription→attendance eligibility; membership→QR eligibility; module toggle→nav/route/RPC enforcement.
7. **Reports / Printing** — filters, totals vs source data, export, print layouts (A4/thermal, AR/EN).
8. **Responsive / RTL / English** — 375/768/1024/1440px across personas; RTL correctness; English parity.
9. **Error / Edge Cases** — 0/1/large records, duplicate submit, refresh mid-op, expired session, module/club state changing mid-session.
10. **Performance / PWA** — page load spot checks, PWA update/cache behavior (already fixed this session — re-verify).
11. **Security Regression** — targeted cross-tenant/cross-branch/IDOR/escalation checks triggered by anything found above (not a full re-audit).
12. **Full Visual Regression** — actual browser walkthroughs of changed areas.
13. **Final Production Acceptance** — tsc/lint/build/tests, migration consistency, git clean, write `MAL3ABY_FULL_SAAS_PRODUCTION_ACCEPTANCE.md`, commit, push (or ENVIRONMENT-BLOCKED), final status block.

## Findings log
Findings tracked with ID/Persona/Area/Severity/Repro/Expected/Actual/RootCause/Fix/Evidence/Regression in the final acceptance report as they are confirmed and fixed.

## Execution approach
Given scale, delegate phases 2-5 exploration to specialized subagents (product-explorer / ux-reviewer / security-reviewer / database-reviewer) running with real Browser + Supabase MCP access, running in background, synthesizing results as they return, fixing confirmed P0/P1/low-risk-P2 issues directly, then re-verifying.
