-- Same grant-leak class as return_shop_sale earlier this session: adding
-- p_payment_amount changed create_shop_sale's signature, which Postgres
-- treats as a new function identity and applies its own default
-- EXECUTE-to-PUBLIC grant on creation. Caught immediately after the
-- migration (before any live business testing) by this session's own
-- grant-audit query, not by a later sweep.
drop function if exists public.create_shop_sale(uuid, uuid, uuid, jsonb, text, text, uuid);

revoke all on function public.create_shop_sale(uuid, uuid, uuid, jsonb, text, text, uuid, numeric) from public, anon;
grant execute on function public.create_shop_sale(uuid, uuid, uuid, jsonb, text, text, uuid, numeric) to authenticated;
