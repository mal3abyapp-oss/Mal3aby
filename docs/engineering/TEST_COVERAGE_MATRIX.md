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

