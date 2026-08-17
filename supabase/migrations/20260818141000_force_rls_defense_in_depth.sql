-- FINAL AUTONOMOUS REMEDIATION -- Security HIGH (from
-- MAL3ABY_PRODUCTION_READINESS.md #11 HIGH list): 45 tables had
-- RLS ENABLED but not FORCED (relforcerowsecurity = false, confirmed
-- live via pg_class before writing this migration).
--
-- Why this matters even though it's not independently exploitable
-- today: RLS policies only apply automatically to roles that are NOT
-- the table owner. Real client roles (anon, authenticated) reach
-- Postgres exclusively through PostgREST/Supabase's connection, which
-- never authenticates as the table owner -- so in the CURRENT
-- architecture, RLS already applies to every real request regardless
-- of the FORCE flag. FORCE ROW LEVEL SECURITY additionally makes RLS
-- apply even to the table owner (and superuser, when
-- row_security=on), which is a pure defense-in-depth hardening: it
-- closes the gap that would otherwise open up the moment any future
-- code path runs as the table owner (a misconfigured service role, a
-- future direct-owner connection string, a migration script executed
-- with elevated rights that also does end-user work). Cheap, safe,
-- zero behavior change for the app's real request path -- this is
-- exactly the kind of hardening this task's own rules call for
-- (low-complexity HIGH-severity item, safe, non-destructive, in scope
-- for launch readiness).
--
-- Scope: every table this project owns in the public schema that
-- currently has RLS enabled but not forced (44 tables, confirmed via
-- a live query against pg_class.relforcerowsecurity). 19 tables
-- already had FORCE set from earlier migrations (age_groups,
-- attendance, enrollments, group_schedule_slots, groups,
-- invoice_verification_tokens, payment_gateway_configs,
-- payment_gateway_transactions, payment_reconciliations, programs,
-- qr_credentials, qr_scan_events, seasons, subscription_freezes,
-- subscriptions, training_sessions) and are left untouched here.

alter table public.audit_logs force row level security;
alter table public.automatic_trial_entitlements force row level security;
alter table public.booking_series force row level security;
alter table public.bookings force row level security;
alter table public.branches force row level security;
alter table public.cash_shifts force row level security;
alter table public.club_memberships force row level security;
alter table public.clubs force row level security;
alter table public.commercial_entitlements force row level security;
alter table public.commercial_upgrade_requests force row level security;
alter table public.contact_requests force row level security;
alter table public.customer_photo_update_requests force row level security;
alter table public.customers force row level security;
alter table public.field_blocks force row level security;
alter table public.field_operating_hours force row level security;
alter table public.fields force row level security;
alter table public.guardian_links force row level security;
alter table public.invoice_items force row level security;
alter table public.invoice_number_sequences force row level security;
alter table public.invoices force row level security;
alter table public.manual_payment_claims force row level security;
alter table public.membership_branches force row level security;
alter table public.messaging_safety_settings force row level security;
alter table public.notification_category_settings force row level security;
alter table public.notification_consent force row level security;
alter table public.notification_events force row level security;
alter table public.notification_queue force row level security;
alter table public.notification_suppressions force row level security;
alter table public.payment_allocations force row level security;
alter table public.payment_method_configs force row level security;
alter table public.payments force row level security;
alter table public.permissions force row level security;
alter table public.platform_invoices force row level security;
alter table public.platform_payments force row level security;
alter table public.platform_plans force row level security;
alter table public.platform_settings force row level security;
alter table public.platform_subscriptions force row level security;
alter table public.players force row level security;
alter table public.pricing_rules force row level security;
alter table public.profiles force row level security;
alter table public.refunds force row level security;
alter table public.role_permissions force row level security;
alter table public.roles force row level security;
alter table public.whatsapp_accounts force row level security;
alter table public.whatsapp_connection_events force row level security;
