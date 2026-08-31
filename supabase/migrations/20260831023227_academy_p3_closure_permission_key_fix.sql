-- CUSTOMER/PARENT EXPERIENCE DIRECTIVE, Section 2B: closes the second
-- (and final) remaining Academy P3 finding -- the
-- academy.program.manage vs academy.group.manage permission-key
-- inconsistency in update_academy_membership().
--
-- Investigated the intended boundary from the authoritative source:
-- the permissions catalog itself (public.permissions.description),
-- which the frontend's own permission catalog (src/lib/domain/
-- permissionCatalog.ts) mirrors identically:
--   academy.program.manage = "Create/update programs, seasons, age
--     groups" -- the organizational metadata tier.
--   academy.group.manage   = "Create/update groups and their weekly
--     schedule" -- the actual billable "Membership" unit (the
--     `groups` table).
--
-- update_academy_membership() edits a `groups` row (name, capacity,
-- subscription_price, status) -- unambiguously a GROUP operation by
-- the catalog's own definition, not a program/season/age-group
-- operation. Confirmed academy.program.manage is otherwise entirely
-- UNUSED as an RPC gate anywhere in this codebase (grepped every
-- function body -- update_academy_membership was the only hit), while
-- academy.group.manage already governs this exact table's RLS INSERT/
-- UPDATE policies (`groups_insert`/`groups_update`) -- meaning this
-- RPC's own permission check has always disagreed with the RLS
-- already sitting behind it on the same table.
--
-- Currently benign in practice ONLY because every seeded system role
-- (club_owner, club_manager, branch_manager, academy_manager) holds
-- both permissions identically -- but per the directive, that is
-- explicitly NOT sufficient proof of correctness. A custom club role
-- granted only academy.group.manage (the semantically correct,
-- narrower permission for editing a group) would have been
-- incorrectly denied by this RPC despite RLS itself considering them
-- authorized -- an unintended, overly-restrictive contradiction
-- between the RPC and the RLS policy governing the same table. This
-- migration fixes it -- it does NOT broaden any privilege: it makes
-- the RPC agree with the RLS boundary that already existed.
create or replace function public.update_academy_membership(p_group_id uuid, p_name text, p_capacity integer, p_subscription_price numeric, p_status text, p_reason text DEFAULT NULL::text)
 returns groups
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_before public.groups;
  v_after public.groups;
begin
  select * into v_before
  from public.groups
  where id = p_group_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('academy.group.manage', club_id)
  for update;

  if v_before.id is null then raise exception 'ACADEMY_MEMBERSHIP_NOT_FOUND_OR_NOT_AUTHORIZED'; end if;

  if not public.user_has_branch_access(v_before.club_id, v_before.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if nullif(btrim(p_name), '') is null then raise exception 'MEMBERSHIP_NAME_REQUIRED'; end if;
  if p_capacity < 1 then raise exception 'MEMBERSHIP_CAPACITY_INVALID'; end if;
  if p_subscription_price is null or p_subscription_price < 0 then
    raise exception 'MEMBERSHIP_PRICE_INVALID';
  end if;
  if p_status not in ('active', 'closed') then raise exception 'MEMBERSHIP_STATUS_INVALID'; end if;

  update public.groups
  set name = btrim(p_name), capacity = p_capacity,
      subscription_price = p_subscription_price, status = p_status
  where id = p_group_id
  returning * into v_after;

  perform public.write_audit_log(v_before.club_id, 'academy_membership.updated',
    'academy_membership', v_before.id, to_jsonb(v_before), to_jsonb(v_after),
    nullif(btrim(p_reason), ''));
  return v_after;
end;
$function$;
