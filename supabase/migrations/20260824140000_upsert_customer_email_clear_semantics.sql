-- Bug: editing a customer (CustomersPage.tsx and Customer360Page.tsx both
-- share this RPC) and clearing the email field did not clear it server-side.
--
-- Root cause: both frontend call sites send `p_email: email || undefined`,
-- so a deliberately-cleared field arrives here as SQL NULL -- indistinguishable
-- from "email not provided / no change intended". The previous version
-- collapsed both NULL and '' into NULL via `nullif(trim(p_email), '')`,
-- then the update branch did `email = coalesce(v_email, email)`, which
-- treats NULL as "keep the existing value". Net effect: clearing the email
-- field in the UI was silently a no-op on the customers row -- the old
-- email persisted in the database while the UI showed the field empty
-- until the next refetch, when the stale email reappeared.
--
-- Fix: give NULL and '' distinct meanings.
--   * p_email IS NULL      -> "no change" on update; "no email" on create
--                             (unchanged from before, preserves every
--                             existing caller that omits p_email entirely,
--                             e.g. customer-selector.tsx's create-only path)
--   * p_email = ''          -> explicit clear -> stored as NULL
--   * p_email = non-empty   -> trimmed and stored as that value
-- This is safe because Postgres already distinguishes NULL from '' at the
-- wire/RPC level (they are never conflated on the way in), so this only
-- changes how '' is interpreted -- previously identical to NULL (no-op on
-- update), now meaning "clear". No existing caller relied on '' silently
-- doing nothing, since that behavior was exactly the bug being fixed.
create or replace function public.upsert_customer(p_club_id uuid, p_full_name text, p_phone_e164 text, p_mobile_display text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_whatsapp_consent boolean DEFAULT NULL::boolean, p_customer_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(customer_id uuid, was_existing boolean, duplicate_of_customer_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- Distinguish "no email supplied" (NULL, meaning no change on update)
  -- from "email field explicitly cleared" ('', meaning set to NULL) from
  -- an actual value (trimmed and stored). Must be decided before v_email
  -- collapses '' and NULL together.
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
