-- Regression guard for the get_official_receipts_report() return-shape bug.
--
-- Context: 20260819200008_official_receipts_report_rpc.sql originally
-- defined get_official_receipts_report() as
-- `RETURNS TABLE(receipts jsonb, total_count bigint, ...)` -- a
-- set-returning function (pg_proc.proretset = true), which PostgREST
-- serializes as a JSON ARRAY of row objects. The report's client
-- component (ReportOfficialReceiptsContent in
-- src/features/reports/ReportOfficialReceiptsPage.tsx) reads the RPC
-- result as a single object (`data.receipts.length`, `data.total_count`,
-- etc, not `data[0].receipts.length`), so the array shape crashed the
-- Official Receipts report with "Cannot read properties of undefined
-- (reading 'length')" for every club, in every environment.
--
-- 20260820190000_fix_official_receipts_report_return_shape.sql fixed
-- this by switching the function to `RETURNS jsonb` (a scalar,
-- proretset = false), matching what the client has always expected.
-- That fix is correct and already in place -- this migration does not
-- change the function's behavior or signature at all.
--
-- What this migration adds: a build-time assertion that
-- get_official_receipts_report() is still a scalar (non-set-returning)
-- function. If a future migration ever reintroduces
-- `RETURNS TABLE(...)` here (e.g. while adding a new filter column),
-- `proretset` flips back to true and this DO block raises an exception,
-- failing that migration immediately instead of silently reintroducing
-- the exact crash described above. This is a read-only check (a single
-- pg_proc lookup) -- it does not touch any table, row, or the function
-- itself, so it is safe to run against any environment.
do $$
declare
  v_proretset boolean;
  v_prorettype regtype;
begin
  select p.proretset, p.prorettype::regtype
  into v_proretset, v_prorettype
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'get_official_receipts_report'
  limit 1;

  if v_proretset is null then
    raise exception 'get_official_receipts_report() not found in public schema -- guard cannot verify its return shape';
  end if;

  if v_proretset then
    raise exception 'get_official_receipts_report() regressed to a set-returning function (RETURNS TABLE/SETOF). PostgREST serializes that as a JSON array, but ReportOfficialReceiptsContent (src/features/reports/ReportOfficialReceiptsPage.tsx) reads the RPC result as a single object (data.receipts, data.total_count, ...). This exact mismatch previously crashed /app/reports/official-receipts and the Finance > Invoices & Receipts > Official receipts tab for every club. Return a single `jsonb` object via jsonb_build_object(...) instead, as fixed in 20260820190000_fix_official_receipts_report_return_shape.sql.';
  end if;

  if v_prorettype <> 'jsonb'::regtype then
    raise exception 'get_official_receipts_report() no longer returns jsonb (found %). The client (ReportOfficialReceiptsContent) expects a single jsonb object with receipts/total_count/active_count/reversed_count/total_collected_amount keys.', v_prorettype;
  end if;
end $$;
