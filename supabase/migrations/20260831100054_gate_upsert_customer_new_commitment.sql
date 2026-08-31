-- PLATFORM OWNER SAAS ACCEPTANCE (2026-08-31), Section 18 (write-blocking
-- enforcement): upsert_customer() was confirmed live NOT to call
-- club_write_allowed() at all, unlike ~90+ other commitment-adjacent RPCs
-- in this codebase (create_booking, sell_club_membership,
-- create_enrollment_with_subscription, record_payment, create_refund,
-- create_shop_sale, renew_academy_subscription, renew_club_membership) --
-- confirmed by live-testing against a genuinely 'blocked' QA tenant
-- (suspended/expired-past-grace): every one of those RPCs correctly
-- rejected, but upsert_customer() still succeeded and created a real
-- customer row. The directive explicitly lists "customer create" as one
-- of its own representative critical-write examples for this check.
--
-- Fix: gate only the CREATE branch (p_customer_id is null) with
-- club_write_allowed(p_club_id, 'new_commitment') -- creating a brand new
-- customer record on a non-paying/blocked tenant is the same class of
-- "new commitment" as creating a new booking or enrollment. The UPDATE
-- branch (editing an already-existing customer's own record -- fixing a
-- typo, adding WhatsApp consent) is left ungated, matching the
-- 'operational_continuity' spirit already carved out for grace-period
-- access elsewhere in this codebase -- editing pre-existing data is not
-- itself a new commercial commitment, and blocking it would prevent even
-- basic data-hygiene corrections on an already-expired tenant with no
-- commercial upside to the platform.

create or replace function public.upsert_customer(
  p_club_id uuid,
  p_full_name text,
  p_phone_e164 text,
  p_mobile_display text default null,
  p_email text default null,
  p_whatsapp_consent boolean default null,
  p_customer_id uuid default null
)
returns table(customer_id uuid, was_existing boolean, duplicate_of_customer_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_normalized_mobile text;
  v_existing_id uuid;
  v_result_id uuid;
  v_was_existing boolean := false;
  v_email text;
  v_email_provided boolean;
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

  v_email_provided := p_email is not null;
  v_email := nullif(trim(p_email), '');

  v_normalized_mobile := case
    when p_mobile_display is not null then regexp_replace(regexp_replace(p_mobile_display, '\D', '', 'g'), '^0+', '')
    else null
  end;

  if p_customer_id is not null then
    if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.update', p_club_id)) then
      raise exception 'not authorized';
    end if;

    if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
      raise exception 'customer not found';
    end if;

    if p_phone_e164 is not null then
      select id into v_existing_id from public.customers
        where club_id = p_club_id and phone_e164 = p_phone_e164 and duplicate_review_status = 'none' and id != p_customer_id
        limit 1;
      if v_existing_id is not null then
        return query select p_customer_id, true, v_existing_id;
        return;
      end if;
    end if;

    update public.customers set
      full_name = trim(p_full_name),
      phone_e164 = coalesce(p_phone_e164, phone_e164),
      mobile_display = coalesce(p_mobile_display, mobile_display),
      normalized_mobile = coalesce(v_normalized_mobile, normalized_mobile),
      email = case when v_email_provided then v_email else email end,
      updated_at = now()
    where id = p_customer_id and club_id = p_club_id
    returning id into v_result_id;
  else
    if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.create', p_club_id)) then
      raise exception 'not authorized';
    end if;

    if not public.club_write_allowed(p_club_id, 'new_commitment') then
      raise exception 'this club is not currently accepting new customers';
    end if;

    if p_phone_e164 is not null then
      select id into v_existing_id from public.customers
        where club_id = p_club_id and phone_e164 = p_phone_e164 and duplicate_review_status = 'none'
        limit 1;
    end if;

    if v_existing_id is not null then
      v_result_id := v_existing_id;
      v_was_existing := true;
    else
      begin
        insert into public.customers (club_id, full_name, mobile_display, normalized_mobile, phone_e164, email, created_by)
        values (p_club_id, trim(p_full_name), p_mobile_display, v_normalized_mobile, p_phone_e164, v_email, auth.uid())
        returning id into v_result_id;
      exception when unique_violation then
        select id into v_result_id from public.customers
          where club_id = p_club_id and phone_e164 = p_phone_e164 and duplicate_review_status = 'none'
          limit 1;
        v_was_existing := true;
      end;
    end if;
  end if;

  if p_whatsapp_consent is not null and p_phone_e164 is not null then
    perform public.record_staff_whatsapp_consent(p_club_id, v_result_id, p_whatsapp_consent, p_mobile_display, v_normalized_mobile, p_phone_e164);
  end if;

  return query select v_result_id, v_was_existing, null::uuid;
end;
$function$;
