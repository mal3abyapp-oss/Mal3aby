# Tenant Go-Live Checklist

Written 2026-08-31, Controlled Commercial Launch Gate, Phase 8.

Reusable per-tenant checklist. Complete every gate before telling a
customer "you're live." Copy this list per tenant when tracking
onboarding (paper, spreadsheet, or ticket — the mechanism doesn't
matter; completing every gate does).

**Tenant name:** ______________________  **Date:** ______________

| # | Gate | Pass? |
|---|------|-------|
| 1 | Tenant created with real business name (not a QA/test name pattern) | ☐ |
| 2 | Subscription tier set correctly per agreed commercial terms | ☐ |
| 3 | Tenant status = `active` | ☐ |
| 4 | At least one real branch created with real name/address | ☐ |
| 5 | Branch currency confirmed correct | ☐ |
| 6 | Branch timezone confirmed correct | ☐ |
| 7 | Owner-role staff account created with the real owner's real email | ☐ |
| 8 | Owner has completed first login and account shows `active` (not `invited`) | ☐ |
| 9 | All other real staff accounts created — one real person per account, no shared logins | ☐ |
| 10 | Real courts/fields or academy groups configured matching physical setup | ☐ |
| 11 | Real pricing set (no QA placeholder rates like 1 EGP/hour) | ☐ |
| 12 | Public booking page (if applicable) loads and shows only this tenant's data | ☐ |
| 13 | Test notification successfully delivered to a real, checked inbox (not landing in spam) | ☐ |
| 14 | One real end-to-end transaction completed and verified (booking → payment → invoice → report) — see Phase 9 enhanced review | ☐ |
| 15 | Tenant isolation spot-check: this tenant's data does not leak into any other tenant's view | ☐ |
| 16 | Ongoing notification preferences configured per customer request | ☐ |
| 17 | Customer briefed on how to reach support | ☐ |
| 18 | Onboarding recorded in the operator tracker (who onboarded, when, tier) | ☐ |
| 19 | Next-business-day follow-up check scheduled | ☐ |

**All 19 gates must be ☑ before declaring this tenant live.** A
partially-complete tenant (e.g. created but not yet staffed) is not
"soft launched" — it stays explicitly marked incomplete until every
gate passes.

## What "PASS" means per gate

Each gate is verified by direct observation in the product (clicking
through, reading the actual screen) — not by assuming a step "must
have worked" because a prior step succeeded. This mirrors the
evidence discipline used throughout every acceptance phase of this
engagement: no gate is marked ☑ without having actually looked.
