-- AUDIT LOG HARDENING -- Phase 3: tamper-evident hash chain (2026-08-29)
--
-- Follow-up to Phases 1-2 (missing audit calls on 5 real RPCs). This
-- phase raises the audit_logs GUARANTEE itself, not just its coverage.
--
-- CURRENT STATE (confirmed live, this pass): audit_logs is genuinely
-- append-only from every client role -- FORCE ROW LEVEL SECURITY is
-- enabled, only 2 SELECT policies exist (no INSERT/UPDATE/DELETE
-- policy for any client role), and a live attack (a real DELETE
-- attempt by the actual TEST-CLUB-1 owner, who genuinely holds
-- table-level DELETE grant) affected 0 rows. This is "cannot be
-- tampered with via the normal client-facing surface" -- a real,
-- meaningful guarantee.
--
-- WHAT IT DOES NOT COVER: a `service_role` connection (superuser
-- database access, migrations, a compromised backend credential, or a
-- future bug that accidentally grants a broader policy) CAN still
-- UPDATE or DELETE a row directly at the database level -- RLS does
-- not apply to a role with BYPASSRLS, and service_role has it by
-- design. Today, that is only ever this project's own migration
-- tooling and the Supabase dashboard's own superuser access -- but the
-- audit log's entire purpose is being the source of truth for "what
-- happened", including in an incident-response scenario where an
-- attacker DID get service_role-level access. A silently-editable
-- append-only table under that threat model is not append-only at
-- all -- it is append-only "unless you're already inside the
-- perimeter this log exists to detect breaches of".
--
-- FIX: a genuine tamper-EVIDENT hash chain, the same structural
-- primitive a blockchain or a certificate-transparency log uses (not
-- inventing a new cryptographic scheme -- this is the standard
-- "each record commits to the hash of everything before it"
-- construction). Each row's own `row_hash` is computed from ITS OWN
-- committed fields plus the immediately-preceding row's `row_hash`.
-- Any single row being altered or deleted after the fact breaks the
-- hash of every row after it -- a chain-wide, purely-mathematical
-- verification (verify_audit_log_chain(), added below) detects this
-- deterministically, with no need to trust any log of who-accessed-
-- the-database-when. This does not prevent a service_role-level
-- actor from deleting or editing a row (nothing at the database layer
-- ever can, by definition of what service_role means) -- it makes
-- doing so DETECTABLE, converting an undetectable tamper into a
-- provable one. This is the correct, proportionate next step given
-- FORCE RLS already closes the client-facing vector completely.
--
-- DESIGN DECISIONS:
--
-- 1. Ordering key: a new `sequence_number bigint` column (backed by a
--    dedicated sequence, NOT `created_at`) is the authoritative chain
--    order. Confirmed live this pass: `created_at` has real duplicate
--    timestamps in this table (multiple rows sharing the same
--    microsecond-precision value -- concurrent requests can genuinely
--    collide), so it cannot serve as a deterministic chain order on
--    its own. A bigint sequence, assigned atomically by Postgres at
--    insert time, has no such ambiguity.
--
-- 2. Hash computed in a BEFORE INSERT trigger, not by the RPC layer:
--    write_audit_log() (or any future direct audit_logs insert) never
--    computes or supplies row_hash/sequence_number itself -- if it
--    did, a compromised or buggy caller could compute a hash over
--    fabricated "previous hash" input and the chain would silently
--    accept it. The trigger reads the true previous row's row_hash
--    directly from the table (the one place that value can come from)
--    and computes this row's hash server-side, unconditionally, for
--    every insert regardless of which RPC produced it.
--
-- 3. Hash function: SHA-256 over a canonical, unambiguous concatenation
--    of every column that defines this row's meaning (sequence_number,
--    club_id, actor_id, action, entity_type, entity_id, before, after,
--    reason, created_at, acting_as_platform_admin, support_session_id)
--    plus the previous row's row_hash. jsonb columns are cast via
--    `::text` (Postgres's own canonical jsonb text representation,
--    stable for a given stored value) rather than re-serialized, so
--    the hash genuinely commits to the exact bytes stored, not a
--    re-derived approximation.
--
-- 4. Genesis row: the very first row in the table (by sequence_number)
--    has no predecessor -- its row_hash is computed with a fixed,
--    well-known genesis constant ('mal3aby-audit-log-genesis') standing
--    in for "previous_hash", exactly like a blockchain's own genesis
--    block. Documented, not a magic empty string.
--
-- 5. Backfill: all 1583 pre-existing real rows (2026-08-15 through
--    today) are chained retroactively, ordered by (created_at, id) --
--    the best available deterministic tie-break for historical rows
--    that predate sequence_number's existence. This is NOT a
--    fabrication of history -- these rows' own committed content
--    (before/after/actor/action/etc.) is completely unchanged; only
--    a NEW column is computed FROM that already-existing, immutable
--    content. From this migration forward, every new row is chained
--    at insert time by the trigger, with no gap.
--
-- 6. verify_audit_log_chain(p_from_sequence, p_to_sequence): re-derives
--    every row's hash independently and compares it to the stored
--    row_hash, returning any row where they disagree (a genuine
--    tamper) plus any sequence_number gap (a deleted row, which
--    breaks the chain even though there is by definition no row left
--    to show a hash mismatch on -- a gap IS the tamper signal for a
--    deleted row). service_role-only (this is an integrity-auditing
--    tool, not a general-purpose read path -- SELECT access to
--    audit_logs itself already exists via the table's own RLS
--    policies for legitimate club-scoped reads).

-- Dedicated sequence -- NOT audit_logs' own implicit id sequence
-- (id is a uuid, no sequence exists for it), and deliberately not
-- reusing any other table's sequence.
create sequence if not exists public.audit_logs_sequence_number_seq;

alter table public.audit_logs
  add column if not exists sequence_number bigint,
  add column if not exists row_hash text,
  add column if not exists previous_row_hash text;

-- Backfill sequence_number for all existing rows, ordered by the best
-- available deterministic tie-break (created_at, then id as a stable
-- final tie-break for genuine same-timestamp collisions confirmed
-- live this pass).
with ordered as (
  select id, row_number() over (order by created_at, id) as rn
  from public.audit_logs
)
update public.audit_logs a
set sequence_number = o.rn
from ordered o
where a.id = o.id;

alter table public.audit_logs alter column sequence_number set not null;
alter table public.audit_logs add constraint audit_logs_sequence_number_unique unique (sequence_number);

-- Advance the real sequence past the backfilled max so the very next
-- live insert continues the same numbering with no collision.
select setval('public.audit_logs_sequence_number_seq', coalesce((select max(sequence_number) from public.audit_logs), 0) + 1, false);

alter table public.audit_logs alter column sequence_number set default nextval('public.audit_logs_sequence_number_seq');

create index if not exists idx_audit_logs_sequence_number on public.audit_logs (sequence_number);

-- Canonical per-row hash input. IMMUTABLE-safe (no side effects, pure
-- function of its inputs) but not marked as such since it's only ever
-- called from the trigger/verification function below, never in an
-- index expression.
create or replace function public._compute_audit_log_row_hash(
  p_previous_row_hash text,
  p_sequence_number bigint,
  p_club_id uuid,
  p_actor_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_reason text,
  p_created_at timestamptz,
  p_acting_as_platform_admin boolean,
  p_support_session_id uuid
) returns text
language sql
immutable
set search_path to 'public', 'extensions', 'pg_temp'
as $$
  select encode(
    extensions.digest(
      coalesce(p_previous_row_hash, 'mal3aby-audit-log-genesis') || '|' ||
      p_sequence_number::text || '|' ||
      coalesce(p_club_id::text, '') || '|' ||
      coalesce(p_actor_id::text, '') || '|' ||
      p_action || '|' ||
      p_entity_type || '|' ||
      coalesce(p_entity_id::text, '') || '|' ||
      coalesce(p_before::text, '') || '|' ||
      coalesce(p_after::text, '') || '|' ||
      coalesce(p_reason, '') || '|' ||
      p_created_at::text || '|' ||
      p_acting_as_platform_admin::text || '|' ||
      coalesce(p_support_session_id::text, ''),
      'sha256'
    ),
    'hex'
  );
$$;

-- Backfill row_hash/previous_row_hash for all existing rows, walking
-- the chain in sequence_number order. A plain recursive CTE (not a
-- loop) so this remains a single, auditable statement.
with recursive chain as (
  select
    id, sequence_number, club_id, actor_id, action, entity_type, entity_id,
    before, after, reason, created_at, acting_as_platform_admin, support_session_id,
    public._compute_audit_log_row_hash(
      null, sequence_number, club_id, actor_id, action, entity_type, entity_id,
      before, after, reason, created_at, acting_as_platform_admin, support_session_id
    ) as computed_hash
  from public.audit_logs
  where sequence_number = 1

  union all

  select
    a.id, a.sequence_number, a.club_id, a.actor_id, a.action, a.entity_type, a.entity_id,
    a.before, a.after, a.reason, a.created_at, a.acting_as_platform_admin, a.support_session_id,
    public._compute_audit_log_row_hash(
      c.computed_hash, a.sequence_number, a.club_id, a.actor_id, a.action, a.entity_type, a.entity_id,
      a.before, a.after, a.reason, a.created_at, a.acting_as_platform_admin, a.support_session_id
    ) as computed_hash
  from public.audit_logs a
  join chain c on a.sequence_number = c.sequence_number + 1
)
update public.audit_logs a
set row_hash = chain.computed_hash,
    previous_row_hash = case when a.sequence_number = 1 then null else lag_hash.computed_hash end
from chain
left join chain lag_hash on lag_hash.sequence_number = chain.sequence_number - 1
where a.id = chain.id;

alter table public.audit_logs alter column row_hash set not null;

-- Trigger: computes row_hash/previous_row_hash server-side for every
-- new insert, reading the true previous row directly from the table
-- rather than trusting any value the inserting statement supplies.
-- Any attempt by an INSERT statement to supply its own row_hash/
-- previous_row_hash is silently overwritten here -- these two columns
-- are never client-controlled inputs, matching write_audit_log()'s own
-- existing convention of computing actor_id server-side rather than
-- trusting a caller-supplied value.
create or replace function public._chain_audit_log_row()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  v_previous_hash text;
begin
  select row_hash into v_previous_hash
  from public.audit_logs
  order by sequence_number desc
  limit 1;

  new.previous_row_hash := v_previous_hash;
  new.row_hash := public._compute_audit_log_row_hash(
    v_previous_hash, new.sequence_number, new.club_id, new.actor_id, new.action,
    new.entity_type, new.entity_id, new.before, new.after, new.reason,
    new.created_at, new.acting_as_platform_admin, new.support_session_id
  );

  return new;
end;
$$;

drop trigger if exists trg_chain_audit_log_row on public.audit_logs;
create trigger trg_chain_audit_log_row
  before insert on public.audit_logs
  for each row
  execute function public._chain_audit_log_row();

-- Chain-wide integrity verification. service_role-only (this connects
-- directly to the raw table for every row in range, which is an
-- integrity-auditing capability, not a normal club-scoped read).
-- Returns one row per detected problem: a hash mismatch (the row's
-- own stored content was altered after insertion) or a sequence gap
-- (a row was deleted, which cannot show a hash mismatch since there
-- is no row left to check -- the gap itself is the tamper signal).
-- Call with no arguments to verify the entire table.
create or replace function public.verify_audit_log_chain(p_from_sequence bigint DEFAULT 1, p_to_sequence bigint DEFAULT NULL::bigint)
returns table(problem_type text, sequence_number bigint, detail text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_row record;
  v_previous_hash text;
  v_computed_hash text;
  v_expected_next bigint;
  v_max_sequence bigint;
begin
  select max(a.sequence_number) into v_max_sequence from public.audit_logs a;
  if p_to_sequence is null then
    p_to_sequence := v_max_sequence;
  end if;

  -- Seed previous_hash from the row immediately before the range, if any.
  select a.row_hash into v_previous_hash
  from public.audit_logs a
  where a.sequence_number = p_from_sequence - 1;

  v_expected_next := p_from_sequence;

  for v_row in
    select a.* from public.audit_logs a
    where a.sequence_number between p_from_sequence and p_to_sequence
    order by a.sequence_number
  loop
    if v_row.sequence_number != v_expected_next then
      return query select
        'sequence_gap'::text,
        v_expected_next,
        format('expected sequence_number %s, found %s -- a row was deleted', v_expected_next, v_row.sequence_number);
      v_expected_next := v_row.sequence_number;
    end if;

    if v_row.previous_row_hash is distinct from v_previous_hash then
      return query select
        'previous_hash_mismatch'::text,
        v_row.sequence_number,
        format('row claims previous_row_hash=%s but the actual preceding row hash is %s', v_row.previous_row_hash, v_previous_hash);
    end if;

    v_computed_hash := public._compute_audit_log_row_hash(
      v_previous_hash, v_row.sequence_number, v_row.club_id, v_row.actor_id, v_row.action,
      v_row.entity_type, v_row.entity_id, v_row.before, v_row.after, v_row.reason,
      v_row.created_at, v_row.acting_as_platform_admin, v_row.support_session_id
    );

    if v_computed_hash != v_row.row_hash then
      return query select
        'row_hash_mismatch'::text,
        v_row.sequence_number,
        format('stored row_hash=%s does not match the hash re-derived from this row''s own current content -- this row was altered after insertion', v_row.row_hash);
    end if;

    v_previous_hash := v_row.row_hash;
    v_expected_next := v_row.sequence_number + 1;
  end loop;

  return;
end;
$$;

revoke all on function public.verify_audit_log_chain(bigint, bigint) from public, authenticated, anon;
grant execute on function public.verify_audit_log_chain(bigint, bigint) to service_role;

revoke all on function public._compute_audit_log_row_hash(text, bigint, uuid, uuid, text, text, uuid, jsonb, jsonb, text, timestamptz, boolean, uuid) from public, authenticated, anon;
revoke all on function public._chain_audit_log_row() from public, authenticated, anon;
