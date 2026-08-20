-- Self-caught bug: the prior migration's CREATE OR REPLACE for
-- settle_employee_cash_liability added a new trailing parameter
-- (p_idempotency_key), which Postgres treats as a distinct overload
-- rather than a replacement of the 3-arg version -- both signatures
-- remained independently callable, so the OLD version (no self-
-- settlement block, no idempotency key) was still reachable. Drop it
-- explicitly so only the fixed 4-arg version exists.
drop function if exists public.settle_employee_cash_liability(uuid, numeric, text);

revoke all on function public.settle_employee_cash_liability(uuid, numeric, text, text) from public;
revoke all on function public.settle_employee_cash_liability(uuid, numeric, text, text) from anon;
grant execute on function public.settle_employee_cash_liability(uuid, numeric, text, text) to authenticated;
