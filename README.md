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

## What this is not (V1)

No online payments, no WhatsApp/SMS, no native apps, no AI features, no full accounting suite, no customer self-service portal. See [docs/DECISIONS.md](docs/DECISIONS.md) and the V1/Deferred matrix in [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for what's deferred and why.

## Tech stack

- **Frontend:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, TanStack Query
- **Backend:** Supabase (Postgres, Auth, Storage, RLS, RPC) — no custom server
- **Deployment:** Cloudflare Pages
- **Source control:** Git + GitHub

## Documentation

| File | Purpose |
|---|---|
| [docs/PROJECT_RULES.md](docs/PROJECT_RULES.md) | Non-negotiable engineering rules for this project |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture, domain architecture, key strategies |
| [docs/DATABASE_BLUEPRINT.md](docs/DATABASE_BLUEPRINT.md) | Full table-by-table database design |
| [docs/RLS_MATRIX.md](docs/RLS_MATRIX.md) | Role × table × permission matrix and RLS policy patterns |
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

Planning complete. Phase 0 not yet started. See [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md).
