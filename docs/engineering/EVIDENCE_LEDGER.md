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

