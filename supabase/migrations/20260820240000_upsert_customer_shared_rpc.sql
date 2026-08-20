-- Customer 360 directive section 46: "Shared New Customer flow ...
-- No module-specific create-customer forms."
--
-- Audit finding: 5 independent client-side implementations of
-- customer-creation (CustomersPage, QuickBookingSheet, Academy
-- PlayersSection's AddPlayerDialog, PublicClubBookingPage via
-- create_public_booking, and PortalProfilePage for updates only) each
-- re-derive phone normalization + duplicate-detection + consent
-- recording, and have already drifted (different dup-check UX, one
-- missing self-exclusion on edit, one with no dup-check at all). This
-- RPC is the single server-side entry point for every authenticated
-- staff surface (CustomerSelector, CustomersPage, QuickBookingSheet,
-- Academy Add Player) going forward -- public booking's own
-- create_public_booking() keeps its inline find-or-create (different
-- trust boundary: anonymous, one specific flow, already correct and
-- unchanged here) but now shares the same unique index this RPC also
-- relies on for atomicity.
--
-- Behavior:
--   - p_customer_id present -> UPDATE (must belong to caller's club).
--   - p_customer_id absent + phone matches an existing customer in
--     this club -> return that existing customer's id (never silently
--     creates a duplicate; matches directive section 10's exact
--     required UX: "show existing customer").
--   - p_customer_id absent + no match -> INSERT.
--   - p_whatsapp_consent (nullable bool) is optional -- when provided,
--     delegates to the existing record_staff_whatsapp_consent() so
--     there remains exactly one consent-writing code path.
--
-- Returns the customer row plus a boolean flag distinguishing
-- "found existing" from "created new" so callers can show the right
-- messaging (directive section 10: "show existing customer" prompt).
create or replace function public.upsert_customer(
  p_club_id uuid,
  p_full_name text,
  p_phone_e164 text,
  p_mobile_display text default null,
  p_email text default null,
  p_whatsapp_consent boolean default null,
  p_customer_id uuid default null
)
returns table(
  customer_id uuid,
  was_existing boolean,
  duplicate_of_customer_id uuid
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_normalized_mobile text;
  v_existing_id uuid;
  v_result_id uuid;
  v_was_existing boolean := false;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception 'name is required';
  end if;

  if p_phone_e164 is not null and p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'invalid phone number';
  end if;

  v_normalized_mobile := case
    when p_mobile_display is not null then regexp_replace(regexp_replace(p_mobile_display, '\D', '', 'g'), '^0+', '')
    else null
  end;

  if p_customer_id is not null then
    -- Update path: caller must already have write access to this
    -- specific customer via the normal customer.update RLS policy --
    -- this RPC does not itself re-check has_permission() so it
    -- inherits exactly the same authorization RLS already enforces,
    -- rather than duplicating that logic here.
    if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.update', p_club_id)) then
      raise exception 'not authorized';
    end if;

    if p_phone_e164 is not null then
      select id into v_existing_id from public.customers
        where club_id = p_club_id and phone_e164 = p_phone_e164 and id != p_customer_id
        limit 1;
      if v_existing_id is not null then
        -- Same "show existing customer, don't silently overwrite"
        -- rule as the create path -- return the conflict instead of
        -- raising, so the client can offer "Open Customer" exactly
        -- like directive section 10 requires, rather than parsing a
        -- generic error message.
        return query select p_customer_id, true, v_existing_id;
        return;
      end if;
    end if;

    update public.customers set
      full_name = trim(p_full_name),
      phone_e164 = coalesce(p_phone_e164, phone_e164),
      mobile_display = coalesce(p_mobile_display, mobile_display),
      normalized_mobile = coalesce(v_normalized_mobile, normalized_mobile),
      email = coalesce(p_email, email),
      updated_at = now()
    where id = p_customer_id and club_id = p_club_id
    returning id into v_result_id;

    if v_result_id is null then
      raise exception 'customer not found';
    end if;
  else
    if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.create', p_club_id)) then
      raise exception 'not authorized';
    end if;

    if p_phone_e164 is not null then
      select id into v_existing_id from public.customers
        where club_id = p_club_id and phone_e164 = p_phone_e164
        limit 1;
    end if;

    if v_existing_id is not null then
      v_result_id := v_existing_id;
      v_was_existing := true;
    else
      insert into public.customers (club_id, full_name, mobile_display, normalized_mobile, phone_e164, email, created_by)
      values (p_club_id, trim(p_full_name), p_mobile_display, v_normalized_mobile, p_phone_e164, p_email, auth.uid())
      returning id into v_result_id;
    end if;
  end if;

  if p_whatsapp_consent is not null and p_phone_e164 is not null then
    perform public.record_staff_whatsapp_consent(p_club_id, v_result_id, p_whatsapp_consent, p_mobile_display, v_normalized_mobile);
  end if;

  return query select v_result_id, v_was_existing, null::uuid;
end;
$function$;

revoke execute on function public.upsert_customer(uuid, text, text, text, text, boolean, uuid) from public;
revoke execute on function public.upsert_customer(uuid, text, text, text, text, boolean, uuid) from anon;
grant execute on function public.upsert_customer(uuid, text, text, text, text, boolean, uuid) to authenticated;
