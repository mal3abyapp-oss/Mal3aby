-- CONTACT-1 fix, part 2 (2026-09-19/20, owner brief): "There is no way
-- to edit a lead afterwards." Confirmed real -- zero lead-update RPC
-- existed anywhere in this codebase before this migration. This
-- matters directly because of CONTACT-1's own root cause (part 1,
-- fixed in the frontend commit alongside this migration): a lead
-- created through the old single-field manual-entry form could have
-- had an email typed into what was actually the phone column, with no
-- way to correct that mistake short of the lead staying wrong forever
-- or being recreated from scratch.
--
-- sales_update_lead_contact() is scoped deliberately narrow -- the
-- fields this bug actually concerns (business_name, public_phone,
-- public_email, website, country, city) -- not a full field-by-field
-- CRM editor. Score/status/signals/etc. all already have their own
-- dedicated, purpose-built update paths elsewhere (sales_change_lead_
-- status, sales_compute_lead_score, ...) and are intentionally left
-- alone here. Same permission gate as every other lead-mutating RPC in
-- this domain (sales_change_lead_status's own pattern).
--
-- Every field is optional (NULL = "don't touch this field") so the
-- frontend can send a partial edit without re-sending the whole
-- record and risking clobbering a value it never displayed.

create or replace function public.sales_update_lead_contact(
  p_lead_id uuid,
  p_business_name text DEFAULT NULL::text,
  p_public_phone text DEFAULT NULL::text,
  p_clear_public_phone boolean DEFAULT false,
  p_public_email text DEFAULT NULL::text,
  p_clear_public_email boolean DEFAULT false,
  p_website text DEFAULT NULL::text,
  p_country text DEFAULT NULL::text,
  p_city text DEFAULT NULL::text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead record;
begin
  if not (
    auth.uid() is null
    or public.is_platform_owner()
    or public.has_platform_permission('platform.sales.edit')
  ) then
    raise exception 'not authorized';
  end if;

  select * into v_lead from public.sales_leads where id = p_lead_id for update;
  if v_lead.id is null then
    raise exception 'lead not found';
  end if;

  if p_business_name is not null and length(trim(p_business_name)) = 0 then
    raise exception 'business name cannot be blank';
  end if;

  update public.sales_leads
  set
    business_name = coalesce(nullif(trim(p_business_name), ''), business_name),
    normalized_name = case when p_business_name is not null and length(trim(p_business_name)) > 0
                            then public.sales_normalize_name(p_business_name) else normalized_name end,
    public_phone = case when p_clear_public_phone then null
                         when p_public_phone is not null then nullif(trim(p_public_phone), '')
                         else public_phone end,
    public_email = case when p_clear_public_email then null
                         when p_public_email is not null then nullif(trim(p_public_email), '')
                         else public_email end,
    website = coalesce(nullif(trim(p_website), ''), website),
    country = coalesce(nullif(trim(p_country), ''), country),
    city = coalesce(nullif(trim(p_city), ''), city),
    updated_at = now()
  where id = p_lead_id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'contact_details_edited', jsonb_build_object(
    'business_name_changed', p_business_name is not null,
    'phone_changed', p_public_phone is not null or p_clear_public_phone,
    'email_changed', p_public_email is not null or p_clear_public_email,
    'website_changed', p_website is not null,
    'location_changed', p_country is not null or p_city is not null
  ), auth.uid());
end;
$$;

revoke all on function public.sales_update_lead_contact(uuid, text, text, boolean, text, boolean, text, text, text) from public;
revoke all on function public.sales_update_lead_contact(uuid, text, text, boolean, text, boolean, text, text, text) from anon;
grant execute on function public.sales_update_lead_contact(uuid, text, text, boolean, text, boolean, text, text, text) to authenticated;
grant execute on function public.sales_update_lead_contact(uuid, text, text, boolean, text, boolean, text, text, text) to service_role;
