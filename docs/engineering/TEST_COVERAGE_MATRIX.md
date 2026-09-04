# Test Coverage Matrix

| Area | Evidence | Result |
|---|---|---|
| Unit/domain | Vitest 62 passing | PASS |
| Authenticated tenant isolation | 7 staff roles × 9 tables | PASS |
| Authenticated branch isolation | Operations, finance, reports, cash, Academy | PASS |
| Payment concurrency/idempotency | Parallel RPC calls + row count + refund | PASS |
| Route/RBAC browser | Reception direct URL denial | PASS |
| Mobile visual/layout | Platform routes and settings at 375/390px | PASS |
| Arabic/English | Both translation resources compile; English role flow and Arabic data exercised | PASS |
| Build/lint | TypeScript/Vite/PWA build; ESLint 0 errors | PASS |

## Mission: MAL3ABY V1 Commercial Packaging (started 2026-09-04)

| Area | Evidence | Result |
|---|---|---|
| Commercial packaging DB foundation (plans, entitlements, RPCs, grace state, founding slots, onboarding column, WhatsApp usage view, public_plans extension) | Independent direct SQL query vs. production `gxkrtlvpjwxhcqdisyob`, 2026-09-04 | PASS (production-verified baseline) |
| Founding offer RPC (`claim_founding_customer_slot`, `get_founding_offer_status`) runtime behavior | None executed yet | NOT_TESTED |
| Onboarding gate RPC (`mark_club_onboarding_complete`) runtime behavior | None executed yet | NOT_TESTED |
| Grace lifecycle RPC (`refresh_commercial_grace_state`) runtime behavior | None executed yet | NOT_TESTED |
| Usage RPCs (`count_active_customers_and_players`, `count_active_staff`, `get_commercial_usage`) runtime behavior | None executed yet | NOT_TESTED |
| RLS on `founding_customer_slots`, `commercial_resource_grace_state` | None executed yet | NOT_TESTED |
| Public pricing page (Starter/Growth/Pro/Enterprise, capacity, founding offer, fair-use wording) | Not implemented | NOT_APPLICABLE (pending build) |
| Platform Owner tenant-detail commercial fields | Not reviewed/implemented | NOT_TESTED |
| Tenant `SubscriptionPage.tsx` usage/limits/grace/founding display | Not implemented | NOT_APPLICABLE (pending build) |
| Full regression (tsc/eslint/vitest/build/security advisors) post-frontend-changes | Not run | NOT_TESTED (blocked on frontend work) |

