-- Audited master-data lifecycle for branches and fields. Historical rows are
-- never deleted, and a field cannot be moved between branches after creation.

create or replace function public.manage_branch(
  p_branch_id uuid,
  p_club_id uuid,
  p_name text,
  p_branch_code text,
  p_address text,
  p_phone text,
  p_phone_e164 text,
  p_status text default 'active',
  p_reason text default null
)
returns public.branches
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_before public.branches; v_after public.branches;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED'; end if;
  if p_status not in ('active', 'inactive') then raise exception 'BRANCH_STATUS_INVALID'; end if;
  if nullif(btrim(p_name), '') is null or nullif(btrim(p_branch_code), '') is null then
    raise exception 'BRANCH_NAME_AND_CODE_REQUIRED';
  end if;

  if p_branch_id is null then
    if not public.has_permission('branch.create', p_club_id) then raise exception 'FORBIDDEN'; end if;
    insert into public.branches (club_id, name, branch_code, address, phone, phone_e164, status)
    values (p_club_id, btrim(p_name), upper(btrim(p_branch_code)), nullif(btrim(p_address), ''),
      nullif(btrim(p_phone), ''), nullif(btrim(p_phone_e164), ''), p_status)
    returning * into v_after;
    perform public.write_audit_log(p_club_id, 'branch.created', 'branch', v_after.id,
      null, to_jsonb(v_after), nullif(btrim(p_reason), ''));
  else
    select * into v_before from public.branches where id = p_branch_id for update;
    if v_before.id is null or v_before.club_id <> p_club_id then raise exception 'BRANCH_NOT_FOUND'; end if;
    if not public.has_permission('branch.update', p_club_id)
       or not public.user_has_branch_access(p_club_id, p_branch_id) then raise exception 'FORBIDDEN'; end if;
    if p_status = 'inactive' and exists (
      select 1 from public.fields where branch_id = p_branch_id and status <> 'inactive'
    ) then raise exception 'DEACTIVATE_BRANCH_FIELDS_FIRST'; end if;
    update public.branches set name=btrim(p_name), branch_code=upper(btrim(p_branch_code)),
      address=nullif(btrim(p_address), ''), phone=nullif(btrim(p_phone), ''),
      phone_e164=nullif(btrim(p_phone_e164), ''), status=p_status
    where id=p_branch_id returning * into v_after;
    perform public.write_audit_log(p_club_id, 'branch.updated', 'branch', v_after.id,
      to_jsonb(v_before), to_jsonb(v_after), nullif(btrim(p_reason), ''));
  end if;
  return v_after;
end $$;
revoke all on function public.manage_branch(uuid,uuid,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.manage_branch(uuid,uuid,text,text,text,text,text,text,text) to authenticated;

create or replace function public.manage_field(
  p_field_id uuid,
  p_club_id uuid,
  p_branch_id uuid,
  p_name text,
  p_sport text,
  p_status text default 'active',
  p_reason text default null
)
returns public.fields
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_before public.fields; v_after public.fields;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED'; end if;
  if p_status not in ('active','maintenance','inactive') then raise exception 'FIELD_STATUS_INVALID'; end if;
  if nullif(btrim(p_name),'') is null or nullif(btrim(p_sport),'') is null then
    raise exception 'FIELD_NAME_AND_SPORT_REQUIRED'; end if;
  if not exists (select 1 from public.branches where id=p_branch_id and club_id=p_club_id and status='active') then
    raise exception 'ACTIVE_BRANCH_REQUIRED'; end if;

  if p_field_id is null then
    if not public.has_permission('field.create', p_club_id)
       or not public.user_has_branch_access(p_club_id, p_branch_id) then raise exception 'FORBIDDEN'; end if;
    insert into public.fields(club_id,branch_id,name,sport,status)
    values(p_club_id,p_branch_id,btrim(p_name),btrim(p_sport),p_status) returning * into v_after;
    perform public.write_audit_log(p_club_id,'field.created','field',v_after.id,null,to_jsonb(v_after),nullif(btrim(p_reason),''));
  else
    select * into v_before from public.fields where id=p_field_id for update;
    if v_before.id is null or v_before.club_id <> p_club_id then raise exception 'FIELD_NOT_FOUND'; end if;
    if v_before.branch_id <> p_branch_id then raise exception 'FIELD_BRANCH_IS_IMMUTABLE'; end if;
    if not public.has_permission('field.update',p_club_id)
       or not public.user_has_branch_access(p_club_id,v_before.branch_id) then raise exception 'FORBIDDEN'; end if;
    update public.fields set name=btrim(p_name),sport=btrim(p_sport),status=p_status
    where id=p_field_id returning * into v_after;
    perform public.write_audit_log(p_club_id,'field.updated','field',v_after.id,to_jsonb(v_before),to_jsonb(v_after),nullif(btrim(p_reason),''));
  end if;
  return v_after;
end $$;
revoke all on function public.manage_field(uuid,uuid,uuid,text,text,text,text) from public, anon;
grant execute on function public.manage_field(uuid,uuid,uuid,text,text,text,text) to authenticated;
