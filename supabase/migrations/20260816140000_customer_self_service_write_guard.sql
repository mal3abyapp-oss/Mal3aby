-- Gate 3 continued: the customers_self_service_update RLS policy from
-- the prior migration allows a self-service customer to UPDATE their
-- own row, but RLS alone is row-level, not column-level -- as written,
-- a customer could update ANY column on their own row, including
-- photo_url (the exact "user swaps their own verified photo to
-- impersonate someone" risk Doc 3 warns about), national_id, or even
-- club_id. This migration closes that gap with a BEFORE UPDATE trigger
-- that silently reverts any protected column back to its old value
-- when the actor is not acting with staff permission -- following this
-- codebase's own established pattern (see
-- protect_club_status_from_non_platform_owner).
--
-- Self-service customers may freely update: mobile_display,
-- normalized_mobile, whatsapp, email, address, emergency_contact,
-- notes (their own contact preferences). They may NOT self-service
-- change: photo_url, national_id, full_name, date_of_birth, gender,
-- club_id, user_id -- these require either staff action (who already
-- have their own UPDATE policy with customer.update permission) or, for
-- photo_url specifically, a dedicated re-approval-tracked request flow
-- (photo_update_requests, added below) so a verified photo is never
-- silently replaced without an auditable staff approval step.

create table if not exists public.customer_photo_update_requests (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  customer_id uuid references public.customers(id),
  player_id uuid references public.players(id),
  requested_by uuid not null references auth.users(id),
  old_photo_url text,
  new_photo_url text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null default now(),
  constraint customer_photo_update_requests_one_target check (
    (customer_id is not null and player_id is null) or (customer_id is null and player_id is not null)
  )
);

alter table public.customer_photo_update_requests enable row level security;

create policy "photo_requests_self_service_insert" on public.customer_photo_update_requests
  for insert with check (
    requested_by = auth.uid()
    and (
      customer_id in (select id from public.customers where user_id = auth.uid())
      or player_id in (
        select p.id from public.players p
        join public.guardian_links gl on gl.player_id = p.id
        join public.customers c on c.id = gl.customer_id
        where c.user_id = auth.uid()
      )
    )
  );

create policy "photo_requests_self_service_select" on public.customer_photo_update_requests
  for select using (requested_by = auth.uid());

create policy "photo_requests_staff_select" on public.customer_photo_update_requests
  for select using (club_id in (select public.user_club_ids()) and public.has_permission('customer.update', club_id));

create policy "photo_requests_staff_review" on public.customer_photo_update_requests
  for update using (club_id in (select public.user_club_ids()) and public.has_permission('customer.update', club_id));

comment on table public.customer_photo_update_requests is
  'Doc 3 identity-fraud protection: a verified member/customer photo is never silently replaced by a self-service edit. A change request is recorded here with full before/after + who/when, and only takes effect once staff explicitly approves it (see approve_customer_photo_request()).';

create or replace function public.request_customer_photo_update(
  p_club_id uuid,
  p_customer_id uuid,
  p_player_id uuid,
  p_new_photo_url text
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_request_id uuid;
  v_old_url text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if (p_customer_id is null) = (p_player_id is null) then
    raise exception 'exactly one of p_customer_id or p_player_id must be provided';
  end if;

  if p_customer_id is not null then
    select photo_url into v_old_url from public.customers where id = p_customer_id and user_id = auth.uid();
    if not found then
      raise exception 'customer record not found or not linked to this account';
    end if;
  else
    select photo_url into v_old_url from public.players p
      where p.id = p_player_id
        and exists (
          select 1 from public.guardian_links gl
          join public.customers c on c.id = gl.customer_id
          where gl.player_id = p.id and c.user_id = auth.uid()
        );
    if not found then
      raise exception 'player record not found or not linked to this account as a guardian';
    end if;
  end if;

  insert into public.customer_photo_update_requests (club_id, customer_id, player_id, requested_by, old_photo_url, new_photo_url)
  values (p_club_id, p_customer_id, p_player_id, auth.uid(), v_old_url, p_new_photo_url)
  returning id into v_request_id;

  return v_request_id;
end;
$$;

revoke execute on function public.request_customer_photo_update(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.request_customer_photo_update(uuid, uuid, uuid, text) to authenticated;

create or replace function public.review_customer_photo_request(
  p_request_id uuid,
  p_approve boolean,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_req record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_req from public.customer_photo_update_requests where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'request not found';
  end if;

  if not (v_req.club_id in (select public.user_club_ids()) and public.has_permission('customer.update', v_req.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_req.status != 'pending' then
    raise exception 'request has already been reviewed';
  end if;

  if p_approve then
    if v_req.customer_id is not null then
      update public.customers set photo_url = v_req.new_photo_url where id = v_req.customer_id;
    else
      update public.players set photo_url = v_req.new_photo_url where id = v_req.player_id;
    end if;
  end if;

  update public.customer_photo_update_requests
  set status = case when p_approve then 'approved' else 'rejected' end,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_reason = p_reason
  where id = p_request_id;

  perform public.write_audit_log(
    v_req.club_id,
    case when p_approve then 'customer.photo.approve' else 'customer.photo.reject' end,
    coalesce('customer', 'player'), coalesce(v_req.customer_id, v_req.player_id),
    jsonb_build_object('old_photo_url', v_req.old_photo_url),
    jsonb_build_object('new_photo_url', v_req.new_photo_url, 'reason', p_reason),
    p_reason
  );
end;
$$;

revoke execute on function public.review_customer_photo_request(uuid, boolean, text) from public, anon;
grant execute on function public.review_customer_photo_request(uuid, boolean, text) to authenticated;

-- ============================================================
-- Column write guard: a self-service customer (no customer.update
-- staff permission) may only change the "contact preference" columns
-- listed above -- photo_url, national_id, full_name, date_of_birth,
-- gender are silently reverted to their prior value if changed by a
-- non-staff actor.
-- ============================================================
create or replace function public.protect_customer_identity_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not public.has_permission('customer.update', new.club_id) then
    if new.photo_url is distinct from old.photo_url then
      new.photo_url := old.photo_url;
    end if;
    if new.national_id is distinct from old.national_id then
      new.national_id := old.national_id;
    end if;
    if new.full_name is distinct from old.full_name then
      new.full_name := old.full_name;
    end if;
    if new.date_of_birth is distinct from old.date_of_birth then
      new.date_of_birth := old.date_of_birth;
    end if;
    if new.gender is distinct from old.gender then
      new.gender := old.gender;
    end if;
    if new.club_id is distinct from old.club_id then
      new.club_id := old.club_id;
    end if;
    if new.user_id is distinct from old.user_id then
      new.user_id := old.user_id;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.protect_customer_identity_columns() from public, anon, authenticated;

drop trigger if exists trg_protect_customer_identity_columns on public.customers;
create trigger trg_protect_customer_identity_columns
  before update on public.customers
  for each row execute function public.protect_customer_identity_columns();
