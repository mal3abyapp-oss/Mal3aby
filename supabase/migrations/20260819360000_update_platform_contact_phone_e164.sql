-- P0 Phone Identity directive: platform contact number also becomes
-- canonical E.164 (section 28). Additive param with a default so
-- existing frontend callers keep working until the settings page is
-- updated to pass it.
create or replace function public.update_platform_contact(p_platform_phone text, p_platform_email text, p_platform_phone_e164 text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_before record;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_platform_phone is null or length(trim(p_platform_phone)) = 0 then
    raise exception 'platform phone is required';
  end if;
  if p_platform_email is null or length(trim(p_platform_email)) = 0 then
    raise exception 'platform email is required';
  end if;
  if p_platform_phone_e164 is not null and p_platform_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'invalid phone number';
  end if;

  select platform_phone, platform_email into v_before from public.platform_settings where id = true;

  update public.platform_settings
  set platform_phone = p_platform_phone, platform_email = p_platform_email,
      platform_phone_e164 = coalesce(p_platform_phone_e164, platform_phone_e164), updated_at = now()
  where id = true;

  perform public.write_audit_log(
    null, 'update_platform_contact', 'platform_settings', null,
    jsonb_build_object('platform_phone', v_before.platform_phone, 'platform_email', v_before.platform_email),
    jsonb_build_object('platform_phone', p_platform_phone, 'platform_email', p_platform_email),
    null
  );
end;
$function$;

drop function if exists public.update_platform_contact(text, text);

revoke all on function public.update_platform_contact(text, text, text) from public;
revoke all on function public.update_platform_contact(text, text, text) from anon;
grant execute on function public.update_platform_contact(text, text, text) to authenticated;
