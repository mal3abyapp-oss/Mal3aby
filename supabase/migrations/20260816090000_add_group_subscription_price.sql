-- V1 Operational Product Rebuild -- Locked Pricing Rule compliance
-- (2026-08-16): the enrollment wizard let an employee freely type any
-- subscription price with no server-side approved source, violating
-- the newly-locked rule ("employee selects service -> system resolves
-- approved price automatically -- never manually typed"). The locked
-- schema had no price field anywhere for academy (groups/programs),
-- unlike field bookings which have pricing_rules. User-approved fix:
-- add a single nullable approved price to groups (the natural billable
-- unit -- one group = one subscription plan), which the enrollment
-- wizard now resolves and displays read-only; base price is never
-- free-typed, only the existing (already-permission-gated) discount
-- field remains editable.
alter table public.groups add column subscription_price numeric(10, 2);

comment on column public.groups.subscription_price is
  'Approved monthly subscription price for this group, set by club_owner/club_manager/academy_manager. The enrollment flow resolves this automatically -- it must never be freely typed by the enrolling employee.';
