# Defect Register

| ID | Severity | Area | Summary | State | Root Cause | Fix / Evidence |
|---|---|---|---|---|---|---|
| AUD-001 | P1 | Security | Branch-scoped staff could read other branches' operations and finance | CERTIFIED | Club-only RLS | Migrations 500/700; authenticated negative reads and denied shift open |
| AUD-002 | P1 | Security | SECURITY DEFINER reports bypassed branch scope | CERTIFIED | Definer execution ignored caller RLS | Migration 600 uses invoker security; denied branch reports return empty/zero |
| AUD-003 | P1 | Security | Academy groups/sessions leaked across branches | CERTIFIED | Academy policies were club-only | Migration 900; four authenticated roles show zero denied groups |
| AUD-004 | P1 | Finance | Ordinary payment crashed without a government receipt | CERTIFIED | Untyped PL/pgSQL RECORD was never assigned | Migration 800 uses typed row; concurrent payment succeeded and was refunded |
| AUD-005 | P2 | RBAC UX | Hidden routes remained reachable by direct URL | CERTIFIED | Navigation-only role filtering | Route guard; receptionist direct URL redirected |
| AUD-006 | P2 | Mobile | Platform/settings pages overflowed horizontally | CERTIFIED | Flex children and payment controls lacked shrink/wrap rules | 390px scroll width equals client width |
| AUD-007 | P2 | UX | Trial/report loading showed false zeros | CERTIFIED | Defaults rendered before queries settled | Loading states wired to cards/tables |
| AUD-008 | P2 | Mobile/Auth | Club mobile UI had no logout action | CERTIFIED | Logout existed only in desktop sidebar | Added to More page; production click returned to login |
| AUD-009 | P3 | RBAC UX | Reception occupancy card linked to blocked field management | CERTIFIED | Shared dashboard drill-down ignored role domain | Card remains informational for reception and links only for managers |

No open P0/P1 defects remain from this audit.

## Mission: MAL3ABY V1 Commercial Packaging (started 2026-09-04)

| ID | Severity | Area | Summary | State | Root Cause | Fix / Evidence |
|---|---|---|---|---|---|---|
| CP-001 | P2 | Academy/Commercial | Academy usage counted from wrong source table in commercial usage calc | CERTIFIED (pre-existing, closed under PR #17) | Query referenced incorrect source table | Fixed and re-verified live during PR #17; migration merged in `6ab90c8` |
| CP-002 | P1 | Commercial RPC | `get_commercial_usage` ambiguous column error | CERTIFIED (pre-existing, closed under PR #17) | OUT-parameter name shadowed a column reference | Fixed and re-verified live during PR #17; migration merged in `6ab90c8` |

No new defects discovered yet in this mission — remaining scope (frontend build, runtime RPC test evidence, RLS/security verification of `founding_customer_slots` and `commercial_resource_grace_state`) is UNVERIFIED, not yet exercised, so no defect can be confirmed or ruled out. Record new defect IDs here as `CP-0xx` once testing begins.
