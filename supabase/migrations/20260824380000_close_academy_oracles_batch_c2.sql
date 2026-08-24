-- SYSTEMIC CROSS-TENANT EXISTENCE-ORACLE CLOSURE -- Batch C2
-- (Player/guardian): update_academy_membership, update_player,
-- link_guardian_to_player, unlink_guardian_from_player,
-- set_primary_guardian. Same class as batches A/B/C1.
--
-- LIVE-PROVEN before this fix (real Coach account, member of exactly
-- one club, real foreign-existing-id vs real-nonexistent-id pairs):
--   update_player: 'not authorized' vs 'player not found' -- DISTINGUISHABLE
--   update_academy_membership: 'FORBIDDEN' vs 'ACADEMY_MEMBERSHIP_NOT_FOUND' -- DISTINGUISHABLE
--   unlink_guardian_from_player: 'not authorized' vs 'guardian relationship not found' -- DISTINGUISHABLE
--   set_primary_guardian: 'not authorized' vs 'player not found' -- DISTINGUISHABLE
--   link_guardian_to_player: THREE distinguishable pre-auth branches --
--     'customer not found' (customer id doesn't exist anywhere),
--     'player not found' (player id doesn't exist anywhere), and
--     'player and customer must belong to the same club' (both real,
--     different clubs) -- letting a caller probe cross-tenant
--     existence of BOTH players and customers, and learn their
--     club-membership relationship, all before any permission check.
--
-- FIX: collapse lookup + club/permission check into one WHERE clause
-- per function. link_guardian_to_player is fixed by folding the
-- has_permission check into the player lookup FIRST (so an unrelated
-- caller gets the exact same "not found" message regardless of
-- whether the player is real), THEN checking the customer against
-- that already-authorized club (so a wrong-club customer produces the
-- same generic message too, no separate "different club" signal).
-- All downstream business logic (relationship-type validation,
-- duplicate-link check, medical-notes sub-permission, primary-
-- guardian reassignment, enrollment.guardian_id sync) preserved
-- verbatim from the current live definitions (re-read via
-- pg_get_functiondef immediately before writing this migration).

create or replace function public.update_player(
  p_player_id uuid, p_full_name text default null::text, p_date_of_birth date default null::date,
  p_gender text default null::text, p_status text default null::text, p_medical_notes text default null::text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id into v_club_id
  from public.players
  where id = p_player_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('player.update', club_id);

  if v_club_id is null then
    raise exception 'player not found or you do not have permission to update it';
  end if;

  if p_status is not null and p_status not in ('active', 'inactive') then
    raise exception 'invalid status';
  end if;

  if p_medical_notes is not null and not public.has_permission('player.medical_notes.update', v_club_id) then
    raise exception 'not authorized to update medical notes';
  end if;

  update public.players
  set full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
      date_of_birth = case when p_date_of_birth is not null then p_date_of_birth else date_of_birth end,
      gender = coalesce(p_gender, gender),
      status = coalesce(p_status, status),
      medical_notes = case when p_medical_notes is not null then p_medical_notes else medical_notes end,
      updated_at = now()
  where id = p_player_id;

  perform public.write_audit_log(v_club_id, 'player.update', 'players', p_player_id, null,
    jsonb_build_object('full_name', p_full_name, 'status', p_status), null);
end;
$$;

create or replace function public.update_academy_membership(
  p_group_id uuid, p_name text, p_capacity integer, p_subscription_price numeric, p_status text, p_reason text default null::text
)
returns groups
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.groups;
  v_after public.groups;
begin
  select * into v_before
  from public.groups
  where id = p_group_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('academy.program.manage', club_id)
  for update;

  if v_before.id is null then raise exception 'ACADEMY_MEMBERSHIP_NOT_FOUND_OR_NOT_AUTHORIZED'; end if;
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
$$;

create or replace function public.unlink_guardian_from_player(p_guardian_link_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_player_id uuid;
  v_customer_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select p.club_id, gl.player_id, gl.customer_id into v_club_id, v_player_id, v_customer_id
  from public.guardian_links gl
  join public.players p on p.id = gl.player_id
  where gl.id = p_guardian_link_id
    and p.club_id in (select public.user_club_ids())
    and public.has_permission('player.update', p.club_id)
    and public.has_permission('customer.update', p.club_id);

  if v_club_id is null then
    raise exception 'guardian relationship not found or you do not have permission to remove it';
  end if;

  delete from public.guardian_links where id = p_guardian_link_id;

  perform public.write_audit_log(v_club_id, 'guardian_link.remove', 'guardian_links', p_guardian_link_id,
    jsonb_build_object('player_id', v_player_id, 'customer_id', v_customer_id), null, null);
end;
$$;

create or replace function public.set_primary_guardian(p_player_id uuid, p_customer_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id into v_club_id
  from public.players
  where id = p_player_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('player.update', club_id)
    and public.has_permission('customer.update', club_id);

  if v_club_id is null then
    raise exception 'player not found or you do not have permission to update it';
  end if;

  if not exists (select 1 from public.guardian_links where player_id = p_player_id and customer_id = p_customer_id) then
    raise exception 'this customer is not a linked guardian of this player';
  end if;

  perform 1 from public.guardian_links where player_id = p_player_id for update;

  update public.guardian_links set is_primary = false
  where player_id = p_player_id and is_primary = true and customer_id != p_customer_id;

  update public.guardian_links set is_primary = true
  where player_id = p_player_id and customer_id = p_customer_id;

  update public.enrollments
  set guardian_id = p_customer_id
  where player_id = p_player_id and status = 'active';

  perform public.write_audit_log(v_club_id, 'guardian_link.set_primary', 'players', p_player_id, null,
    jsonb_build_object('new_primary_customer_id', p_customer_id), null);
end;
$$;

create or replace function public.link_guardian_to_player(
  p_player_id uuid, p_customer_id uuid, p_relationship text default 'guardian'::text, p_is_primary boolean default false
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_player_club uuid;
  v_link_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- Player lookup is now the SOLE existence-revealing branch, and it
  -- is fully authorization-scoped: an unrelated caller gets the exact
  -- same message whether p_player_id is real-but-foreign or entirely
  -- fictitious. The customer is then checked ONLY against this
  -- already-authorized club (never revealing whether p_customer_id
  -- exists in some OTHER club), collapsing what was previously three
  -- distinguishable pre-auth branches into one generic message.
  select club_id into v_player_club
  from public.players
  where id = p_player_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('player.update', club_id)
    and public.has_permission('customer.update', club_id);

  if v_player_club is null then
    raise exception 'player not found or you do not have permission to link a guardian to it';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = v_player_club) then
    raise exception 'customer not found in this club';
  end if;

  if p_relationship not in ('father', 'mother', 'guardian', 'other') then
    raise exception 'invalid relationship type';
  end if;

  if exists (select 1 from public.guardian_links where customer_id = p_customer_id and player_id = p_player_id) then
    raise exception 'this guardian is already linked to this player';
  end if;

  insert into public.guardian_links (customer_id, player_id, relationship, is_primary)
  values (p_customer_id, p_player_id, p_relationship, p_is_primary)
  returning id into v_link_id;

  perform public.write_audit_log(v_player_club, 'guardian_link.create', 'guardian_links', v_link_id, null,
    jsonb_build_object('player_id', p_player_id, 'customer_id', p_customer_id, 'relationship', p_relationship, 'is_primary', p_is_primary), null);

  return v_link_id;
end;
$$;

-- All 5 signatures unchanged -- in-place replace, grants untouched.
