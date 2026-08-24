-- Security hardening (defense-in-depth, low severity): 8 tables had RLS
-- ENABLED but not FORCED (relforcerowsecurity = false), confirmed live via
-- pg_class before writing this migration. Same owner (postgres) and same
-- RLS-enabled status as the 67 other tables in this schema that already
-- have FORCE set (see 20260818141000_force_rls_defense_in_depth.sql, which
-- forced 44 tables and documented that 19 others already had it).
--
-- Why this matters even though it is not independently exploitable today:
-- anon/authenticated (the real PostgREST client roles) are never the table
-- owner and do not have BYPASSRLS, so RLS policies already apply to every
-- real client request regardless of the FORCE flag. postgres and
-- service_role both have BYPASSRLS, so FORCE is a structural no-op against
-- them too. FORCE ROW LEVEL SECURITY is pure defense-in-depth: it closes
-- the gap that would otherwise open the moment any future connection path
-- runs as the table owner without BYPASSRLS (a misconfigured role, a
-- future direct-owner connection string, an admin script that also
-- touches end-user data). Cheap, safe, zero behavior change for the app's
-- real request path -- consistent with every other RLS-enabled table in
-- this schema.
--
-- Scope: the 8 tables added by later migrations that were never included
-- in the earlier FORCE RLS sweep --
--   employee_cash_liabilities, employee_cash_liability_ledger,
--   employee_cash_liability_settlement_keys (20260820073607)
--   government_collection_policies, official_collection_receipts
--   (20260819200000)
--   whatsapp_delivery_traces, whatsapp_incidents, whatsapp_root_cause_codes
--   (20260821010000)
-- These are ordinary application/database tables (incident logs, receipts,
-- liability ledgers) -- this migration does not touch WhatsApp transport,
-- the whatsapp-connector service, or the Cloudflare worker.

alter table public.employee_cash_liabilities force row level security;
alter table public.employee_cash_liability_ledger force row level security;
alter table public.employee_cash_liability_settlement_keys force row level security;
alter table public.government_collection_policies force row level security;
alter table public.official_collection_receipts force row level security;
alter table public.whatsapp_delivery_traces force row level security;
alter table public.whatsapp_incidents force row level security;
alter table public.whatsapp_root_cause_codes force row level security;
