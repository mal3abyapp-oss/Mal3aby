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

No open P0/P1 defects remain from this audit.

