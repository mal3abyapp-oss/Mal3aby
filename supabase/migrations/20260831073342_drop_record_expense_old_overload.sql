-- Adding p_idempotency_key to record_expense() (see
-- 20260831073301_expenses_idempotency_key.sql) creates a NEW function
-- overload in Postgres (functions are identified by name+signature) --
-- it does NOT replace the old 9-arg one. Confirmed live immediately
-- after applying that migration: both the old 9-arg and new 10-arg
-- signatures were simultaneously callable. Drop the orphaned overload
-- so callers cannot bypass the idempotency-key path by omitting it.

drop function if exists public.record_expense(uuid, uuid, numeric, text, text, uuid, text, text, date);
