-- FINAL AUTONOMOUS REMEDIATION -- Performance (from
-- MAL3ABY_PRODUCTION_READINESS.md Performance section, 5/10): the
-- largest table in the schema by a wide margin (whatsapp_connection_events,
-- 10,745 rows at time of audit) has zero secondary index, and a few
-- frequently-filtered FK columns lack indexes. Evidence-based, not
-- speculative: this is the one table whose row count is already an
-- order of magnitude larger than any other real-data table in this
-- project (bookings=34, invoices=54, payments=41 at audit time) and
-- will keep growing linearly with every WhatsApp connection event, so
-- it's the one place indexing is a genuine near-term concern, not a
-- "might matter someday" guess.

-- whatsapp_connection_events: any per-club diagnostics/health query
-- (present or future -- see the Phase B platform-owner WhatsApp
-- health screen scoped in this same remediation pass) filters by
-- club_id and orders by recency -- this composite index serves both.
create index if not exists idx_whatsapp_connection_events_club_created
  on public.whatsapp_connection_events (club_id, created_at desc);

-- bookings.branch_id / bookings.invoice_id: confirmed unindexed FK
-- columns used in real query paths (branch-scoped booking lists,
-- invoice-to-booking lookups in record_payment()/cancel_booking()
-- and the WhatsApp template enrichment queries added earlier in this
-- project's history).
create index if not exists idx_bookings_branch_id on public.bookings (branch_id);
create index if not exists idx_bookings_invoice_id on public.bookings (invoice_id);

-- payments.branch_id: confirmed unindexed FK column, used by
-- branch-scoped collections/reconciliation reports.
create index if not exists idx_payments_branch_id on public.payments (branch_id);
