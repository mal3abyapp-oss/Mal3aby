-- BOOKINGS/FIELDS PRODUCTION ACCEPTANCE, D6 (continued) + Section 32
-- gap closure (D8): two changes.
--
-- 1. create_field_block had the exact same branch-scope gap as D6
--    (create_booking/cancel_booking/mark_booking_no_show): permission
--    checked at `has_permission('field.update', v_club_id)` --
--    club-wide, no branch dimension -- while its sibling manage_field
--    (the field CRUD RPC right next to it in the product) already
--    correctly calls user_has_branch_access on create. Same fix,
--    same helper, same reasoning as D6: a branch-restricted staff
--    member should not be able to block a field outside their
--    assigned branch(es).
--
-- 2. No delete/cancel RPC existed for field_blocks at all -- needed
--    now that a real UI is being added (D8, Section 32: field
--    closures had a fully-built, audited, permission-gated create
--    RPC and zero UI anywhere in the product). Mirrors
--    create_field_block's own permission/module/branch pattern
--    exactly, plus an ownership check (a block can only be deleted
--    within the caller's own club) and a real audit log entry on
--    delete, matching every other destructive action in this
--    codebase (cancel_booking, etc.).
create or replace function public.create_field_block(
  p_field_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_type text,
  p_reason text default null
)
returns table(block_id uuid, conflicting_booking_ids uuid[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_block_id uuid;
  v_conflicts uuid[];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id, branch_id into v_club_id, v_branch_id from public.fields where id = p_field_id;
  if v_club_id is null then
    raise exception 'field not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('field.update', v_club_id)) then
    raise exception 'not authorized';
  end if;

  -- D6 (continued): same branch-scope check as manage_field already
  -- has, extended to this sibling RPC.
  if not public.user_has_branch_access(v_club_id, v_branch_id) then
    raise exception 'not authorized for this branch';
  end if;

  if not public._fields_module_active(v_club_id) then
    raise exception 'the fields module is not active for this club';
  end if;

  if p_type not in ('maintenance', 'weather', 'private_event', 'manual', 'holiday') then
    raise exception 'invalid block type';
  end if;

  select array_agg(id) into v_conflicts
  from public.bookings
  where field_id = p_field_id
    and status in ('pending_payment', 'confirmed', 'checked_in')
    and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)');

  insert into public.field_blocks (club_id, field_id, start_at, end_at, reason, type, created_by)
  values (v_club_id, p_field_id, p_start_at, p_end_at, p_reason, p_type, auth.uid())
  returning id into v_block_id;

  perform public.write_audit_log(
    v_club_id, 'field_block.create', 'field_block', v_block_id, null,
    jsonb_build_object('field_id', p_field_id, 'type', p_type, 'conflicting_booking_ids', coalesce(v_conflicts, array[]::uuid[])),
    p_reason
  );

  return query select v_block_id, coalesce(v_conflicts, array[]::uuid[]);
end;
$$;

revoke execute on function public.create_field_block(uuid, timestamptz, timestamptz, text, text) from public;
revoke execute on function public.create_field_block(uuid, timestamptz, timestamptz, text, text) from anon;
grant execute on function public.create_field_block(uuid, timestamptz, timestamptz, text, text) to authenticated;

-- New: delete_field_block. Same permission/module/branch pattern as
-- create_field_block, plus ownership verification via the join back
-- to fields (a block row carries club_id/field_id directly, so the
-- branch is re-resolved from the field the same way create does --
-- never trust a client-supplied branch/club value).
create or replace function public.delete_field_block(p_block_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_block record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select fb.*, f.branch_id as field_branch_id
    into v_block
  from public.field_blocks fb
  join public.fields f on f.id = fb.field_id
  where fb.id = p_block_id;

  if v_block.id is null then
    raise exception 'block not found';
  end if;

  v_club_id := v_block.club_id;
  v_branch_id := v_block.field_branch_id;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('field.update', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.user_has_branch_access(v_club_id, v_branch_id) then
    raise exception 'not authorized for this branch';
  end if;

  if not public._fields_module_active(v_club_id) then
    raise exception 'the fields module is not active for this club';
  end if;

  delete from public.field_blocks where id = p_block_id;

  perform public.write_audit_log(
    v_club_id, 'field_block.delete', 'field_block', p_block_id,
    jsonb_build_object('field_id', v_block.field_id, 'start_at', v_block.start_at, 'end_at', v_block.end_at, 'type', v_block.type, 'reason', v_block.reason),
    null,
    p_reason
  );
end;
$$;

revoke execute on function public.delete_field_block(uuid, text) from public;
revoke execute on function public.delete_field_block(uuid, text) from anon;
grant execute on function public.delete_field_block(uuid, text) to authenticated;
