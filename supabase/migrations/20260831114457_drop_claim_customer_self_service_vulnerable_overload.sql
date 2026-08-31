-- Adding p_normalized_mobile to claim_customer_self_service() (see
-- 20260831114439_fix_claim_customer_self_service_missing_corroboration.sql)
-- creates a NEW Postgres function overload -- it does NOT replace the
-- old 2-arg signature. Confirmed live immediately after applying that
-- migration: the OLD, VULNERABLE 2-arg signature (no corroboration
-- check at all) remained fully callable, meaning the fix could be
-- completely bypassed by simply calling the old signature. Drop it.

drop function if exists public.claim_customer_self_service(uuid, uuid);
