-- CRITICAL GRANT-HYGIENE BUG, continued -- the return_shop_sale
-- idempotency migration (return_shop_sale_idempotency) changed the
-- function's parameter LIST (added p_idempotency_key), which made
-- Postgres treat it as a genuinely new function identity -- and every
-- newly CREATEd function gets Postgres's own default EXECUTE-to-PUBLIC
-- grant unless explicitly revoked. That migration's `create or replace
-- function` block never included the revoke/grant statements every
-- other Shop RPC migration in this session correctly included at its
-- own tail -- a real oversight, caught by this session's own final
-- grant-hygiene audit pass before it could ship uncaught. Confirmed
-- live via has_function_privilege(): EXECUTE was granted to both
-- `public` and `anon` on the current single return_shop_sale overload.
revoke all on function public.return_shop_sale(uuid, jsonb, boolean, numeric, text, uuid) from public;
revoke all on function public.return_shop_sale(uuid, jsonb, boolean, numeric, text, uuid) from anon;
grant execute on function public.return_shop_sale(uuid, jsonb, boolean, numeric, text, uuid) to authenticated;
