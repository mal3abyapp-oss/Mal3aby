-- Same overload-duplication issue as create_refund earlier in this
-- session: adding p_idempotency_key created a second overload instead
-- of replacing the function. Drop the stale 5-arg version so every
-- caller resolves to the one hardened 6-arg version (the 6th param
-- defaults to null, fully backward compatible for any existing 5-arg
-- caller).
drop function if exists public.claim_manual_payment(uuid, uuid, numeric, text, text);
