-- Academy Player/Guardian/Customer integrity closure.
--
-- ROOT CAUSE (confirmed by direct audit, not assumed): the Guardian=Customer
-- model is already correct at the database level -- guardian_links has both
-- required invariants (unique (customer_id, player_id); a partial unique
-- index enforcing max-one-primary-guardian-per-player). The real gaps are:
--   1. No dedicated player create/edit RPC -- players are created via two
--      independent client-side .insert() calls (players, then
--      guardian_links) with no transaction. A failure between them leaves
--      an orphan player with zero guardians, which later hard-fails billing
--      (create_enrollment_with_subscription requires a resolvable payer).
--   2. No RPC to link/unlink a guardian, or to change the primary guardian
--      atomically -- any of this today would have to be raw table writes
--      from the frontend, bypassing the one-primary-per-player invariant's
--      only real protection (the partial unique index itself, which is
--      correct but gives an ugly constraint-violation error, not a clean
--      "swap primary" operation).
--   3. No aggregation RPC for a Player 360 view (mirroring
--      get_customer_360_summary's shape) -- this migration adds one.
--
-- Design: Guardian is NOT a new identity -- every RPC below takes a
-- customer_id, never guardian name/phone/email fields. Player remains a
-- distinct entity. This migration does not touch the customers or
-- guardian_links schema (both are already correct); it only adds the
-- missing RPC surface and closes the transactional-safety gap.

-- ============================================================
-- create_player_with_guardian: the transactional replacement for the
-- unsafe two-call client-side sequence. Guardian is OPTIONAL (rule 7 of
-- the directive: do not require a guardian for every player without a
-- real business rule) -- p_customer_id may be NULL, in which case a
-- player is created with zero guardians. If a customer_id IS given, the
-- guardian_links row is created in the SAME transaction, so a player can
-- never exist with a guardian that failed to attach.
-- ============================================================
create or replace function public.create_player_with_guardian(
  p_club_id uuid,
  p_full_name text,
  p_date_of_birth date default null,
  p_gender text default null,
  p_customer_id uuid default null,
  p_relationship text default 'guardian',
  p_is_primary boolean default true
)
returns table(player_id uuid, guardian_link_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_player_id uuid;
  v_link_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('player.create', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception 'player name is required';
  end if;

  if p_customer_id is not null then
    if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
      raise exception 'guardian customer not found in this club';
    end if;
    if not public.has_permission('customer.update', p_club_id) then
      raise exception 'not authorized to link a guardian';
    end if;
    if p_relationship not in ('father', 'mother', 'guardian', 'other') then
      raise exception 'invalid relationship type';
    end if;
  end if;

  insert into public.players (club_id, full_name, date_of_birth, gender, status, created_by)
  values (p_club_id, trim(p_full_name), p_date_of_birth, p_gender, 'active', auth.uid())
  returning id into v_player_id;

  if p_customer_id is not null then
    insert into public.guardian_links (customer_id, player_id, relationship, is_primary)
    values (p_customer_id, v_player_id, p_relationship, p_is_primary)
    returning id into v_link_id;
  end if;

  perform public.write_audit_log(p_club_id, 'player.create', 'players', v_player_id, null,
    jsonb_build_object('full_name', p_full_name, 'guardian_customer_id', p_customer_id), null);

  return query select v_player_id, v_link_id;
end;
$function$;

revoke execute on function public.create_player_with_guardian(uuid, text, date, text, uuid, text, boolean) from public;
revoke execute on function public.create_player_with_guardian(uuid, text, date, text, uuid, text, boolean) from anon;
grant execute on function public.create_player_with_guardian(uuid, text, date, text, uuid, text, boolean) to authenticated;

-- ============================================================
-- update_player: edits non-financial player data only. Explicitly does
-- NOT touch subscriptions, invoices, payments, or attendance -- directive
-- rule 12/51: player edits must never rewrite financial/history rows.
-- ============================================================
create or replace function public.update_player(
  p_player_id uuid,
  p_full_name text default null,
  p_date_of_birth date default null,
  p_gender text default null,
  p_status text default null,
  p_medical_notes text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id into v_club_id from public.players where id = p_player_id;
  if v_club_id is null then
    raise exception 'player not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('player.update', v_club_id)) then
    raise exception 'not authorized';
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
$function$;

revoke execute on function public.update_player(uuid, text, date, text, text, text) from public;
revoke execute on function public.update_player(uuid, text, date, text, text, text) from anon;
grant execute on function public.update_player(uuid, text, date, text, text, text) to authenticated;

-- ============================================================
-- link_guardian_to_player: "Add Guardian" from Player 360, and "Link
-- Existing Player" from Customer 360 (same underlying operation from
-- either direction). The unique (customer_id, player_id) constraint
-- already blocks a duplicate link at the DB level -- this RPC turns that
-- into a clean error instead of a raw constraint violation.
-- ============================================================
create or replace function public.link_guardian_to_player(
  p_player_id uuid,
  p_customer_id uuid,
  p_relationship text default 'guardian',
  p_is_primary boolean default false
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_player_club uuid;
  v_customer_club uuid;
  v_link_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id into v_player_club from public.players where id = p_player_id;
  if v_player_club is null then
    raise exception 'player not found';
  end if;

  select club_id into v_customer_club from public.customers where id = p_customer_id;
  if v_customer_club is null then
    raise exception 'customer not found';
  end if;

  if v_player_club != v_customer_club then
    raise exception 'player and customer must belong to the same club';
  end if;

  if not (v_player_club in (select public.user_club_ids())
          and public.has_permission('player.update', v_player_club)
          and public.has_permission('customer.update', v_player_club)) then
    raise exception 'not authorized';
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
$function$;

revoke execute on function public.link_guardian_to_player(uuid, uuid, text, boolean) from public;
revoke execute on function public.link_guardian_to_player(uuid, uuid, text, boolean) from anon;
grant execute on function public.link_guardian_to_player(uuid, uuid, text, boolean) to authenticated;

-- ============================================================
-- unlink_guardian_from_player: removes ONLY the relationship row. Never
-- deletes the customer, the player, or any history (directive rule 18).
-- ============================================================
create or replace function public.unlink_guardian_from_player(p_guardian_link_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
  where gl.id = p_guardian_link_id;

  if v_club_id is null then
    raise exception 'guardian relationship not found';
  end if;

  if not (v_club_id in (select public.user_club_ids())
          and public.has_permission('player.update', v_club_id)
          and public.has_permission('customer.update', v_club_id)) then
    raise exception 'not authorized';
  end if;

  delete from public.guardian_links where id = p_guardian_link_id;

  perform public.write_audit_log(v_club_id, 'guardian_link.remove', 'guardian_links', p_guardian_link_id,
    jsonb_build_object('player_id', v_player_id, 'customer_id', v_customer_id), null, null);
end;
$function$;

revoke execute on function public.unlink_guardian_from_player(uuid) from public;
revoke execute on function public.unlink_guardian_from_player(uuid) from anon;
grant execute on function public.unlink_guardian_from_player(uuid) to authenticated;

-- ============================================================
-- set_primary_guardian: atomic swap (directive rule 48 -- "never briefly
-- leave two primaries due race"). Clears every other primary flag for
-- this player and sets the target in the SAME statement/transaction; the
-- partial unique index still backstops this at the DB level even if two
-- concurrent calls raced, since only one UPDATE can win the constraint.
-- ============================================================
create or replace function public.set_primary_guardian(p_player_id uuid, p_customer_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id into v_club_id from public.players where id = p_player_id;
  if v_club_id is null then
    raise exception 'player not found';
  end if;

  if not (v_club_id in (select public.user_club_ids())
          and public.has_permission('player.update', v_club_id)
          and public.has_permission('customer.update', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.guardian_links where player_id = p_player_id and customer_id = p_customer_id) then
    raise exception 'this customer is not a linked guardian of this player';
  end if;

  -- Lock every guardian_links row for this player first so a concurrent
  -- set_primary_guardian call for the same player serializes behind this
  -- one rather than racing on the two updates below.
  perform 1 from public.guardian_links where player_id = p_player_id for update;

  update public.guardian_links set is_primary = false
  where player_id = p_player_id and is_primary = true and customer_id != p_customer_id;

  update public.guardian_links set is_primary = true
  where player_id = p_player_id and customer_id = p_customer_id;

  perform public.write_audit_log(v_club_id, 'guardian_link.set_primary', 'players', p_player_id, null,
    jsonb_build_object('new_primary_customer_id', p_customer_id), null);
end;
$function$;

revoke execute on function public.set_primary_guardian(uuid, uuid) from public;
revoke execute on function public.set_primary_guardian(uuid, uuid) from anon;
grant execute on function public.set_primary_guardian(uuid, uuid) to authenticated;

-- ============================================================
-- get_player_360_summary: the Player 360 overview aggregation, mirroring
-- get_customer_360_summary's shape/authorization pattern.
-- ============================================================
create or replace function public.get_player_360_summary(p_club_id uuid, p_player_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_guardians jsonb;
  v_current_enrollment record;
  v_current_subscription record;
  v_financial jsonb;
  v_attendance_rate numeric;
  v_current_membership jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('player.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.players where id = p_player_id and club_id = p_club_id) then
    raise exception 'player not found';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'guardian_link_id', gl.id,
    'customer_id', c.id,
    'full_name', c.full_name,
    'phone_e164', c.phone_e164,
    'relationship', gl.relationship,
    'is_primary', gl.is_primary
  ) order by gl.is_primary desc, c.full_name), '[]'::jsonb)
  into v_guardians
  from public.guardian_links gl
  join public.customers c on c.id = gl.customer_id
  where gl.player_id = p_player_id;

  select e.*, g.name as group_name, g.subscription_price as group_price
  into v_current_enrollment
  from public.enrollments e
  join public.groups g on g.id = e.group_id
  where e.player_id = p_player_id and e.status = 'active'
  order by e.enrolled_at desc limit 1;

  if v_current_enrollment.id is not null then
    select s.* into v_current_subscription
    from public.subscriptions s
    where s.enrollment_id = v_current_enrollment.id
    order by s.created_at desc limit 1;

    if v_current_subscription.invoice_id is not null then
      select jsonb_build_object(
        'total', fin.total, 'paid', fin.paid, 'outstanding', fin.outstanding, 'payment_status', fin.payment_status
      ) into v_financial
      from public.get_invoice_payment_summary(array[v_current_subscription.invoice_id]) fin;
    end if;

    v_current_membership := jsonb_build_object(
      'enrollment_id', v_current_enrollment.id,
      'group_name', v_current_enrollment.group_name,
      'subscription_id', v_current_subscription.id,
      'subscription_status', v_current_subscription.status,
      'plan_type', v_current_subscription.plan_type,
      'start_date', v_current_subscription.start_date,
      'end_date', v_current_subscription.end_date,
      'price', v_current_subscription.price
    );
  end if;

  select case when count(*) = 0 then null else round(100.0 * count(*) filter (where status = 'present') / count(*), 0) end
  into v_attendance_rate
  from public.attendance ar
  where ar.player_id = p_player_id;

  select jsonb_build_object(
    'player', jsonb_build_object(
      'id', p.id, 'full_name', p.full_name, 'date_of_birth', p.date_of_birth,
      'gender', p.gender, 'photo_url', p.photo_url, 'status', p.status,
      'created_at', p.created_at
    ),
    'guardians', v_guardians,
    'primary_guardian', (select g from jsonb_array_elements(v_guardians) g where (g->>'is_primary')::boolean = true limit 1),
    'current_membership', v_current_membership,
    'financial', v_financial,
    'attendance_rate', v_attendance_rate
  )
  into v_result
  from public.players p
  where p.id = p_player_id;

  return v_result;
end;
$function$;

revoke execute on function public.get_player_360_summary(uuid, uuid) from public;
revoke execute on function public.get_player_360_summary(uuid, uuid) from anon;
grant execute on function public.get_player_360_summary(uuid, uuid) to authenticated;

-- ============================================================
-- Historical price safety (directive rule 11/26/74/75): confirmed real
-- gap. subscriptions.price was write-time-locked to the group's live
-- price only on INSERT (trg_subscriptions_enforce_membership_price is
-- BEFORE INSERT only) -- but the subscriptions_update RLS policy allows
-- any staff member with subscription.update to UPDATE a subscription
-- row directly via PostgREST, including its price/enrollment_id/
-- plan_type/start_date columns, with zero server-side protection against
-- rewriting a settled historical price. No existing RPC needs to write
-- these columns on UPDATE (confirmed: freeze/cancel/unfreeze/expire/
-- activate-internal all only touch status/end_date-adjacent fields,
-- never price) -- renew_academy_subscription creates a brand-new row via
-- INSERT rather than mutating the old one, so it is unaffected by this
-- guard. Follows the same silently-revert-to-old-value pattern already
-- established by protect_tenant_id_immutable().
-- ============================================================
create or replace function public.protect_subscription_price_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.price is distinct from old.price then
    new.price := old.price;
  end if;
  if new.discount is distinct from old.discount then
    new.discount := old.discount;
  end if;
  if new.enrollment_id is distinct from old.enrollment_id then
    new.enrollment_id := old.enrollment_id;
  end if;
  if new.plan_type is distinct from old.plan_type then
    new.plan_type := old.plan_type;
  end if;
  if new.start_date is distinct from old.start_date then
    new.start_date := old.start_date;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_protect_subscription_price_immutable on public.subscriptions;
create trigger trg_protect_subscription_price_immutable
  before update on public.subscriptions
  for each row execute function public.protect_subscription_price_immutable();
