-- A genuinely NEW function object (the 10-arg record_expense()
-- overload created by 20260831073301_expenses_idempotency_key.sql)
-- picks up Postgres's own default PUBLIC EXECUTE grant on creation,
-- regardless of what grants any prior same-named overload had.
-- Confirmed live: `anon` and PUBLIC both had EXECUTE on the new
-- signature immediately after that migration applied, even though the
-- original 20260830055731_expenses_feature.sql migration explicitly
-- granted only `authenticated` on the old 9-arg signature. Re-apply
-- the exact same grant set (authenticated only, no anon/PUBLIC) --
-- the function itself still checks auth.uid() internally so this was
-- not independently exploitable, but it breaks this codebase's own
-- established least-privilege convention for every other staff
-- financial-write RPC.

revoke all on function public.record_expense(uuid, uuid, numeric, text, text, uuid, text, text, date, uuid) from public;
revoke all on function public.record_expense(uuid, uuid, numeric, text, text, uuid, text, text, date, uuid) from anon;
grant execute on function public.record_expense(uuid, uuid, numeric, text, text, uuid, text, text, date, uuid) to authenticated;
