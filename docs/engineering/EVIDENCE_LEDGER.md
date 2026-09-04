# Evidence Ledger

| Claim | Level | Evidence |
|---|---|---|
| Cross-tenant isolation | TEST-VERIFIED | Seven real authenticated staff sessions returned zero foreign rows across nine core/academy tables |
| Cross-branch operational isolation | DB/TEST-VERIFIED | Scoped roles see only City Nasr branch rows |
| Report isolation | DB/TEST-VERIFIED | Denied Sheikh Zayed RPC requests return empty arrays and zero totals |
| Academy branch isolation | DB/TEST-VERIFIED | Four roles show zero denied groups; sessions map only to allowed groups |
| Payment idempotency | DB/TEST-VERIFIED | Two concurrent RPCs returned one payment ID/row; reversed with `create_refund` |
| Route boundary | LIVE-VERIFIED | Receptionist direct navigation to `/app/staff` redirected to `/app` |
| Mobile overflow | LIVE-VERIFIED | Settings at 390px: document/body/client widths all 390 |
| Regression | TEST-VERIFIED | 62 passed; lint 0 errors; production build passed |
| Production DB | PRODUCTION-VERIFIED | Migrations 500–900 applied and exact versions recorded |

## Mission: MAL3ABY V1 Commercial Packaging (started 2026-09-04)

| Claim | Level | Evidence |
|---|---|---|
| Commercial packaging DB foundation (PR #17) deployed | PRODUCTION-VERIFIED | Independent direct SQL query against production `gxkrtlvpjwxhcqdisyob` on 2026-09-04 confirmed all 6 migrations (`20260904210000`–`20260904210500`) remote-deployed and `platform_plans` rows match claimed values exactly (Growth/Pro public, Monthly/Annual public with live subs, Quarterly archived) |
| Founding offer / onboarding gate / grace lifecycle RPCs work at runtime | UNVERIFIED | No automated or manual runtime test executed yet; code-reviewed only |
| Public pricing page reflects new plans/founding offer | NOT IMPLEMENTED | `PricingPage.tsx` still renders raw `public_plans` rows with no capacity, founding, or fair-use content |
| Platform Owner tenant-detail shows commercial fields | UNVERIFIED | `PlatformClubDetailPage.tsx` (1761 lines) not yet reviewed for commercial fields |
| Tenant `SubscriptionPage.tsx` shows usage/limits/grace/founding status | NOT IMPLEMENTED | Currently shows plan name + price only |
| RLS on `founding_customer_slots` and `commercial_resource_grace_state` | UNVERIFIED | No independent security review performed by anyone yet |
| Regression gate (tsc/eslint/vitest/build/security advisors) for this mission | NOT RUN | Blocked on frontend work not yet started |

