-- DEL-1 (owner brief, live QA 2026-09-19/20): investigated fresh, no
-- claim trusted from this session's own compacted memory without
-- verification (the same discipline already proven necessary for
-- CAMP-1's assumed-merged PR #48 and WA-1's stale "hide WhatsApp"
-- claim). scripts/disc1-cleanup-foreign-leads.sql's own comment is the
-- only real prior reference to "DEL-1" in this codebase: "A genuine
-- bulk-archive capability is DEL-1's own scope (soft archive for
-- leads/campaigns)."
--
-- Investigation found TWO separate things, not one:
--
-- 1. sales_leads: already correctly append-only by design.
--    sales_leads_update's own RLS policy has NO delete policy at all
--    (20260904090100_sales_intelligence_rls_and_permissions.sql's own
--    comment: "leads are never hard-deleted (status='lost'/
--    'do_not_contact' instead)"). This is already correct and is NOT
--    touched here -- a lead with real outreach/conversion history
--    (which AUD-1 just made tamper-evident via the hash-chained audit
--    log) must never be hard-deletable, even by the Owner; the existing
--    sales_change_lead_status(..., 'lost', p_reason) RPC already IS the
--    "archive a lead" action this brief's own decision rules call for
--    -- no new RPC needed, it already exists and already requires a
--    reason for exactly this transition (20260910100000). Building a
--    second, redundant "archive lead" RPC on top of it would be
--    unjustified scope-creep, not a real fix.
--
-- 2. sales_campaigns: a REAL, LIVE, currently-exploitable security gap,
--    confirmed directly against production via information_schema.
--    role_table_grants before writing this migration:
--    sales_campaigns_write's RLS policy is `for all` (SELECT/INSERT/
--    UPDATE/DELETE all in one policy), and unlike every sales_* table
--    that revokes anon/public but was never audited for `authenticated`
--    table-level grants staying at their Supabase-default breadth,
--    `authenticated` genuinely holds raw DELETE/INSERT/UPDATE/TRUNCATE
--    grants on sales_campaigns AND sales_campaign_leads today. A
--    Platform Owner (or any future staff member ever granted
--    platform.sales.manage_campaigns, a narrower permission than
--    platform-owner-only) could delete a campaign directly via
--    supabase.from('sales_campaigns').delete() with ZERO audit trail
--    (write_audit_log is deliberately never grantable to authenticated
--    -- a raw client DELETE never passes through it) and silently
--    cascade-wipe sales_campaign_leads (on delete cascade). This is a
--    strictly worse posture than every other privileged-delete surface
--    in this codebase (archive_club_membership_plan/
--    restore_club_membership_plan, delete_platform_custom_role,
--    delete_field_block -- all RPC-gated, permission-checked, audited,
--    the last two also reason-threaded). sales_campaigns.status already
--    has 'archived' in its own CHECK constraint (unused until now) --
--    the schema itself already signaled soft-archive, not hard delete,
--    was the intended shape.
--
-- Fix, matching archive_club_membership_plan/restore_club_membership_
-- plan's exact established convention: close the unguarded RLS/grant
-- hole (narrow sales_campaigns_write to UPDATE only, drop DELETE
-- entirely, revoke the raw authenticated table grants this migration's
-- own predecessor never explicitly touched), add a genuinely NEW,
-- dedicated platform.sales.archive permission (mirroring
-- platform.role.delete's own precedent: destructive actions get their
-- own permission, not reuse of the broader manage_campaigns key), and
-- two guarded, audited RPCs: sales_archive_campaign/
-- sales_restore_campaign.

-- ============================================================
-- New dedicated permission key -- destructive action, separate from
-- ordinary campaign management (matches platform.role.delete's own
-- precedent of a dedicated delete/archive permission distinct from
-- edit/manage).
-- ============================================================
insert into public.platform_permissions (key, group_key) values
  ('platform.sales.archive', 'sales')
on conflict (key) do nothing;

insert into public.platform_role_permissions (platform_role_id, platform_permission_id)
select r.id, p.id from public.platform_roles r cross join public.platform_permissions p
where r.key = 'platform_owner' and p.key = 'platform.sales.archive'
on conflict do nothing;

insert into public.platform_role_permissions (platform_role_id, platform_permission_id)
select r.id, p.id from public.platform_roles r join public.platform_permissions p
  on p.key = 'platform.sales.archive'
where r.key = 'platform_admin'
on conflict do nothing;

-- ============================================================
-- Close the unguarded delete hole: sales_campaigns_write narrowed to
-- UPDATE only (archive/restore go through status changes, never a raw
-- DELETE); a fresh, explicit INSERT policy replaces the old `for all`
-- (unchanged behavior for create, since sales_create_campaign already
-- only ever INSERTs); DELETE dropped entirely -- no client path to hard
-- delete a campaign exists after this migration, matching sales_leads'
-- own no-delete-policy convention.
-- ============================================================
drop policy if exists sales_campaigns_write on public.sales_campaigns;

create policy sales_campaigns_insert on public.sales_campaigns
  for insert with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_campaigns'));

create policy sales_campaigns_update on public.sales_campaigns
  for update
  using (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_campaigns') or public.has_platform_permission('platform.sales.archive'))
  with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_campaigns') or public.has_platform_permission('platform.sales.archive'));

drop policy if exists sales_campaign_leads_write on public.sales_campaign_leads;

create policy sales_campaign_leads_insert on public.sales_campaign_leads
  for insert with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_campaigns'));

-- No update/delete policy on sales_campaign_leads at all -- membership
-- rows are add-only via sales_add_leads_to_campaign (CAMP-1); removing
-- a lead from a campaign or wiping a whole campaign's membership is
-- explicitly out of THIS migration's scope (DEL-1's own evidence only
-- covers the exposed delete hole and the archive/restore lifecycle, not
-- a new "remove one lead from a campaign" feature -- flagged separately
-- below, not silently bundled in).

-- Table-level grants: revoke the raw DELETE/TRUNCATE grants from
-- authenticated on both tables (confirmed live via information_schema.
-- role_table_grants before writing this migration: authenticated held
-- DELETE/INSERT/UPDATE/TRUNCATE on both). RLS's FORCE already blocks
-- row access regardless of table grants, but this closes the grant
-- layer too, defense in depth, matching this schema's own established
-- double-lock convention (its RLS migration's own comment, lines
-- 231-239 of 20260904090100).
revoke delete, truncate on table public.sales_campaigns from authenticated;
-- sales_campaign_leads has no UPDATE policy either (membership rows are
-- add-only, per this migration's own comment above) -- revoke that raw
-- grant too, not just delete/truncate, for full defense-in-depth
-- consistency with the RLS layer.
revoke delete, truncate, update on table public.sales_campaign_leads from authenticated;

-- ============================================================
-- sales_archive_campaign() / sales_restore_campaign(): the actual
-- archive lifecycle, matching archive_club_membership_plan/
-- restore_club_membership_plan's exact shape -- guarded, reversible,
-- audited, idempotency-checked (cannot archive an already-archived
-- campaign or restore a non-archived one).
-- ============================================================
create or replace function public.sales_archive_campaign(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_campaign public.sales_campaigns%rowtype;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.archive')) then
    raise exception 'not authorized';
  end if;

  select * into v_campaign from public.sales_campaigns where id = p_campaign_id for update;
  if v_campaign.id is null then
    raise exception 'campaign not found';
  end if;

  if v_campaign.status = 'archived' then
    raise exception 'campaign is already archived';
  end if;

  update public.sales_campaigns set status = 'archived', updated_at = now() where id = p_campaign_id;

  perform public.write_audit_log(
    null, 'sales.campaign_archived', 'sales_campaigns', p_campaign_id,
    jsonb_build_object('status', v_campaign.status),
    jsonb_build_object('status', 'archived'),
    null
  );
end;
$$;

revoke all on function public.sales_archive_campaign(uuid) from public, anon;
grant execute on function public.sales_archive_campaign(uuid) to authenticated;

create or replace function public.sales_restore_campaign(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_campaign public.sales_campaigns%rowtype;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.archive')) then
    raise exception 'not authorized';
  end if;

  select * into v_campaign from public.sales_campaigns where id = p_campaign_id for update;
  if v_campaign.id is null then
    raise exception 'campaign not found';
  end if;

  if v_campaign.status <> 'archived' then
    raise exception 'campaign is not archived';
  end if;

  -- Restored campaigns come back as 'active', not whatever status they
  -- held before archiving -- this codebase's own convention
  -- (restore_club_membership_plan's own comment: "plan starts inactive
  -- on restore, staff must explicitly reactivate") is that a restore is
  -- a deliberate, re-reviewed re-entry, not a blind undo. A campaign
  -- has no other meaningful non-active state today (paused/completed
  -- are schema-only, unused, same as archived was before this
  -- migration), so 'active' is the only sensible destination.
  update public.sales_campaigns set status = 'active', updated_at = now() where id = p_campaign_id;

  perform public.write_audit_log(
    null, 'sales.campaign_restored', 'sales_campaigns', p_campaign_id, null, null, null
  );
end;
$$;

revoke all on function public.sales_restore_campaign(uuid) from public, anon;
grant execute on function public.sales_restore_campaign(uuid) to authenticated;
