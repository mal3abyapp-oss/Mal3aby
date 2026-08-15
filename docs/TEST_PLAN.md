# Test Plan

Not aiming for 100% coverage as a formal goal. Aiming to make the critical, hard-to-reverse business logic provably correct — especially anything touching money, availability, or tenant isolation. Everything below runs locally against `supabase start` — no test ever depends on production. See [PROJECT_RULES.md](PROJECT_RULES.md) rule 5.

## Layers

### Unit (Vitest)
Pure functions in `lib/domain/` only — no Supabase client, no DOM. Price calculation (pricing rule resolution/priority), subscription status derivation, installment/outstanding-balance math, invoice total calculation.

### Database / RLS (pgTAP, via `supabase test db`)
- Cross-club isolation matrix (see [RLS_MATRIX.md](RLS_MATRIX.md#verification-checklist-phase-2-gate)) — run per tenant-scoped table, not just spot-checked
- Double-booking exclusion constraint under direct SQL insert (bypassing the RPC) and under simulated concurrent connections
- QR atomic consume — replay returns zero rows on second attempt
- Invoice numbering under concurrent calls — no duplicates, no gaps beyond intentional voids
- Payment allocation sum trigger — rejects over-allocation
- Refund flow — original payment unchanged, ledger balances correctly after refund
- Subscription freeze — `end_date` shifts correctly when `extends_expiry = true`
- Role/permission checks — a role without a given permission is rejected on INSERT/UPDATE at the RLS layer, not just hidden in the UI

### Integration
End-to-end against a local Supabase instance (not mocked): booking creation (slot search → price calc → RPC → invoice → QR), subscription lifecycle (enroll → pay → freeze → expire), refund end-to-end.

### Manual QA
Responsive pass across mobile/tablet/desktop breakpoints; print QA (A4 + 80mm thermal — real printer if available, otherwise accurate print-preview); camera QA for `/scan` on an actual phone (desktop browser camera permission behavior differs from mobile).

## Critical Test List

Every item below must have a passing automated test (pgTAP or Vitest/integration) before the owning phase's exit gate is considered met:

- RLS isolation (per table, per role where relevant)
- Cross-club access denial (SELECT/INSERT/UPDATE/DELETE attempts)
- Double booking prevention (direct SQL + concurrent RPC calls)
- Concurrent booking race (two simultaneous requests for the same slot)
- Invoice total correctness (subtotal + tax − discount = total, across multiple line items)
- Payment allocation correctness (partial payments, multi-invoice payments)
- Refund correctness (ledger consistency, original payment untouched)
- Subscription activation (pending → active on qualifying payment)
- Subscription expiry (active → expired when `end_date` passes with no active freeze)
- Installment / outstanding balance correctness against the ledger
- QR replay protection (second scan of consumed token)
- QR expiry (expired token rejected even if otherwise valid)
- Role permission enforcement (unauthorized action rejected server-side, not just hidden client-side)
- Branch-scoped permission enforcement (Branch Manager cannot act outside their branch)
- Invoice numbering concurrency (no duplicate numbers under parallel connections)

## What Is Explicitly Not Tested Formally in V1

UI pixel-perfect visual regression, exhaustive input-fuzzing of every form field, load testing beyond what a single pilot club would generate. These aren't ignored — they're just not automated test-suite items; manual QA covers what's needed for V1's actual scale.
