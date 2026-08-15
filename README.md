# ملعبي | Mala3by

**Club & Academy Operations Platform** — not just a court booking app.

Mala3by is a multi-tenant operations system for sports clubs and football academies: booking desk, cashier, coach, and manager all work from one system, all day. Built to run a single pilot club first, architected so a second club or branch is a data row, not a rebuild.

## What this is

- Multi-club, multi-branch SaaS with database-enforced tenant isolation (Supabase RLS)
- Field booking with database-level double-booking prevention
- Academy management: programs, groups, coaches, players, subscriptions, attendance
- Real financial ledger: invoices, payments, allocations, refunds — no deletes, only void/reverse
- Secure QR check-in for bookings and academy attendance
- Arabic RTL first, English toggle, installable PWA, works on desktop/tablet/mobile
- Platform billing: Mala3by charges clubs a real subscription (Monthly/Quarterly/Semi-Annual/Annual) to use the platform — period-based with full renewal history, structurally separate from a club's own customer billing, and fully independent of club account status (see [docs/DECISIONS.md ADR-027](docs/DECISIONS.md#adr-027--clubsstatus-and-platform-subscription-status-are-fully-independent-grace_period-is-never-a-club-status) through ADR-035)
- Public marketing site + self-service signup + 7-day free trial (no card required) — a club can go from anonymous visitor to an operating trial club in one short flow, with trial modeled as a value on the same subscription system above, not a separate mechanism (see [docs/DECISIONS.md ADR-036](docs/DECISIONS.md#adr-036--free-trial-requires-no-payment-method-zero-financial-exposure-by-construction) through ADR-046)
- Security-first by design: the frontend is never trusted for authorization or financial values — every mutation is re-verified server-side, with a documented Abuse Test Catalogue and a Security Gate on every implementation phase (see [docs/SECURITY_ANTI_FRAUD.md](docs/SECURITY_ANTI_FRAUD.md))
- A real, documented visual identity (Modern Sports Operations SaaS, not an old-style ERP) — see [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md)

## What this is not (V1)

No `organizations` layer above clubs (fully removed, not a placeholder — see [DECISIONS.md ADR-011](docs/DECISIONS.md#adr-011--organizations-removed-entirely-from-v1-schema)), no online payments, no WhatsApp/SMS, no native apps, no AI features, no full accounting suite, no customer self-service portal. See [docs/DECISIONS.md](docs/DECISIONS.md) and the V1/Deferred matrix in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for what's deferred and why.

## Tech stack

- **Frontend:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, TanStack Query
- **Backend:** Supabase (Postgres, Auth, Storage, RLS, RPC) — no custom server
- **Deployment:** Cloudflare Pages (target end-state — not yet authorized, see Git Policy below)
- **Source control:** Git, hosted on GitHub ([mal3abyapp-oss/Mal3aby](https://github.com/mal3abyapp-oss/Mal3aby))

## Git Policy

**Phase 17 (GitHub release) complete:** the repository is pushed to GitHub with its full local commit and migration history preserved, no rewriting. **Phase 18 (Cloudflare + production deployment) is still blocked** until a separate, explicit go-ahead — no Cloudflare Pages connection, no production Supabase project, no DNS/domain changes, no deployment secrets. See [docs/PROJECT_RULES.md](docs/PROJECT_RULES.md) rule 5b.

## Documentation

| File | Purpose |
|---|---|
| [docs/PROJECT_RULES.md](docs/PROJECT_RULES.md) | Non-negotiable engineering rules for this project |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture, domain architecture, key strategies |
| [docs/DATABASE_BLUEPRINT.md](docs/DATABASE_BLUEPRINT.md) | Full table-by-table database design |
| [docs/RLS_MATRIX.md](docs/RLS_MATRIX.md) | Role × table × permission matrix and RLS policy patterns |
| [docs/RLS_SECURITY.md](docs/RLS_SECURITY.md) | Mandatory `SECURITY DEFINER` function discipline and sensitive-column protection |
| [docs/SECURITY_ANTI_FRAUD.md](docs/SECURITY_ANTI_FRAUD.md) | Business-abuse threat model, Abuse Test Catalogue, per-phase Security Gate |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | Visual identity, design tokens, component foundation, responsive rules |
| [docs/USER_FLOWS.md](docs/USER_FLOWS.md) | Critical end-to-end user flows |
| [docs/SCREEN_MAP.md](docs/SCREEN_MAP.md) | Full screen inventory by device |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phase-by-phase build plan with exit gates |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | Testing strategy across all layers |
| [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md) | Current phase, progress, blockers — updated after every phase |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture Decision Records |

## Local development

```bash
supabase start        # local Postgres + Auth + Storage (requires Docker)
npm install
npm run dev
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#local-development-workflow) for the full loop (test → build → commit → push).

## Status

Implementation through Phase 16 complete (20 / 22 actual planned phases — Phases 0–16 plus 3b/3c/3d), Final Pre-Release Verification and Final Release Gate both passed, Phase 17 (GitHub release) complete. Phase 18 (Cloudflare + production deployment) not started — blocked pending separate explicit authorization. See [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md).
