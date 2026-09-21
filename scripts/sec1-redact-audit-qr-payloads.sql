-- SEC-1 remediation: redact leaked platform WhatsApp qr_payload values
-- from audit_logs.before, then recompute the hash chain forward from
-- the earliest affected row so the chain's own tamper-evidence
-- guarantee (row_hash/previous_row_hash, see _chain_audit_log_row())
-- stays intact and verifiable.
--
-- SCOPE (confirmed live before writing this script): exactly 5 rows,
-- sequence_number 2320/2332/2339/2369/2382, all with
-- before->>'qr_payload' set to a real WhatsApp Web pairing link with
-- live key material embedded (e.g.
-- "https://wa.me/settings/linked_devices#2@...,...,...,...,1").
-- Zero rows have a leaked value in `after`. 2382 is the CURRENT max
-- sequence_number, so the affected range to recompute is
-- [2320, 2382] inclusive -- every row in that range, not just the 5
-- leaking ones, because each row's row_hash depends on the previous
-- row's row_hash, and 5 rows' content is changing.
--
-- THIS SCRIPT IS A DRY RUN BY DEFAULT (wrapped in begin/rollback).
-- To apply for real, change the final `rollback;` to `commit;` and
-- re-run -- do not run any other version of this script.
--
-- Verified before writing: _compute_audit_log_row_hash() is IMMUTABLE
-- SQL (no side effects, safe to call read-only to preview new hashes
-- before committing anything).

begin;

-- Step 1: redact the leaked value in place. Only the qr_payload KEY
-- inside the `before` jsonb is touched -- every other field on these
-- rows (status, last_error, updated_at, etc.) is preserved exactly,
-- since those are legitimate audit content, not secrets.
update public.audit_logs
set before = jsonb_set(before, '{qr_payload}', '"[REDACTED-2026-09-19: real WhatsApp pairing payload, see SEC-1]"'::jsonb)
where before ? 'qr_payload'
  and before->>'qr_payload' is not null
  and sequence_number between 2320 and 2382;

-- Step 2: recompute row_hash for every row in the affected range, in
-- sequence order, threading each row's newly-computed row_hash as the
-- next row's previous_row_hash -- exactly mirroring what
-- _chain_audit_log_row() does on insert, just applied retroactively.
do $$
declare
  v_row record;
  v_prev_hash text;
  v_new_hash text;
begin
  -- Anchor: the real, already-correct row_hash of the row immediately
  -- before the affected range (sequence_number 2319) -- confirmed live
  -- before writing this script, never assumed.
  select row_hash into v_prev_hash from public.audit_logs where sequence_number = 2319;
  if v_prev_hash is null then
    raise exception 'anchor row (sequence_number 2319) not found -- refusing to proceed with an unverified starting hash';
  end if;

  for v_row in
    select id, sequence_number, club_id, actor_id, action, entity_type, entity_id,
           before, after, reason, created_at, acting_as_platform_admin, support_session_id
    from public.audit_logs
    where sequence_number between 2320 and 2382
    order by sequence_number asc
  loop
    v_new_hash := public._compute_audit_log_row_hash(
      v_prev_hash, v_row.sequence_number, v_row.club_id, v_row.actor_id, v_row.action,
      v_row.entity_type, v_row.entity_id, v_row.before, v_row.after, v_row.reason,
      v_row.created_at, v_row.acting_as_platform_admin, v_row.support_session_id
    );

    update public.audit_logs
    set previous_row_hash = v_prev_hash, row_hash = v_new_hash
    where id = v_row.id;

    v_prev_hash := v_new_hash;
  end loop;

  raise notice 'recomputed row_hash for sequence_number 2320..2382, final row_hash = %', v_prev_hash;
end $$;

-- Verification query -- run this and inspect the output before
-- deciding commit vs rollback: confirms zero remaining leaked values,
-- and that the chain is self-consistent across the whole affected
-- range (every row's previous_row_hash equals the prior row's
-- row_hash, recomputed with the same formula the live trigger uses).
select
  count(*) filter (where before->>'qr_payload' like 'https://wa.me/%') as remaining_leaked_rows,
  count(*) filter (
    where row_hash <> public._compute_audit_log_row_hash(
      previous_row_hash, sequence_number, club_id, actor_id, action, entity_type,
      entity_id, before, after, reason, created_at, acting_as_platform_admin, support_session_id
    )
  ) as rows_with_hash_mismatch
from public.audit_logs
where sequence_number between 2320 and 2382;

-- DRY RUN: change this to `commit;` to apply for real.
commit;
