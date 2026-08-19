-- Government / Ministry Collection Compliance -- RLS (directive
-- sections 33, 56, 57, 67).
--
-- Permission reuse (directive section 33: "use existing RBAC, do not
-- create a new role system"):
--   payment.create -> enter/create a receipt (same permission that
--                     already gates record_payment()).
--   payment.refund -> reverse a receipt (closest existing semantic
--                     match to "undo a financial collection").
--   club.update    -> change the government compliance policy itself
--                     (same permission that already gates other
--                     club-level settings changes) -- directive
--                     section 34/59: an ordinary collection-recording
--                     staff member must NOT be able to touch this.

begin;

alter table public.government_collection_policies enable row level security;
alter table public.official_collection_receipts enable row level security;

-- Government Collection Policies: club staff with club.update can read
-- and write their own club's policy rows (any scope level). Platform
-- owner has full read for cross-tenant compliance oversight (directive
-- section 45/46), never write (policy changes are the club's own
-- decision, not the platform's).
create policy gcp_select_club_staff on public.government_collection_policies
  for select
  using (club_id in (select public.user_club_ids()) and public.has_permission('club.update', club_id));

create policy gcp_write_club_staff on public.government_collection_policies
  for all
  using (club_id in (select public.user_club_ids()) and public.has_permission('club.update', club_id))
  with check (club_id in (select public.user_club_ids()) and public.has_permission('club.update', club_id));

create policy gcp_select_platform_owner on public.government_collection_policies
  for select
  using (public.is_platform_owner());

-- Official Collection Receipts: club staff with payment.create/view can
-- read; only payment.create can insert (mirrors payments table's own
-- pattern); reversal is handled exclusively through the
-- reverse_official_receipt() RPC (SECURITY DEFINER, not a raw UPDATE),
-- so there is no direct UPDATE policy for ordinary staff at all --
-- directive section 29: "no UI edit path", enforced at the RLS layer
-- too, not just by omitting an edit button.
create policy ocr_select_club_staff on public.official_collection_receipts
  for select
  using (club_id in (select public.user_club_ids()) and public.has_permission('payment.view', club_id));

create policy ocr_insert_club_staff on public.official_collection_receipts
  for insert
  with check (club_id in (select public.user_club_ids()) and public.has_permission('payment.create', club_id));

create policy ocr_select_platform_owner on public.official_collection_receipts
  for select
  using (public.is_platform_owner());

-- No UPDATE/DELETE policy for any role -- directive sections 29-32:
-- immutable after creation, reversal/correction go through dedicated
-- audited RPCs (SECURITY DEFINER, bypassing RLS internally the same
-- way every other platform/club write RPC in this codebase already
-- does), never a raw table write from the client.

commit;
