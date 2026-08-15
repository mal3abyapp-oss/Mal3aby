-- Recovered during Final Pre-Release Verification (2026-08-15): applied to
-- the remote Mala3by Supabase project (recorded in
-- supabase_migrations.schema_migrations as version 20260815122512, name
-- enable_btree_gist -- the real apply-time timestamp) but had no
-- corresponding local file. Content is byte-accurate to the
-- remote-recorded statement.
--
-- Filed here under a local timestamp (20260815135000, after
-- 20260815130000_phase3_staff_permissions.sql and before
-- 20260815140000_phase3b_platform_billing.sql) rather than its literal
-- remote timestamp, for the same synthetic-ordering reason documented in
-- 20260815125000_phase2_lockdown_function_execute_grants.sql -- this is
-- the original btree_gist install, installed into `public`; a later fix
-- (bundled into 20260815140000_phase3b_platform_billing.sql) re-installs
-- it into the `extensions` schema, which is what the live database now
-- reflects (create extension if not exists is idempotent, so both having
-- run is harmless and matches remote history exactly).

create extension if not exists btree_gist;
