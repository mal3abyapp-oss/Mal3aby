-- Platform Owner directive, Phase H (H2/H3): platform_phone/platform_email
-- were already confirmed as the correct single source of truth (read via
-- the existing public get_platform_contact() RPC, shown on the public
-- marketing footer) -- but there was no UI anywhere on the Platform Owner
-- console to CHANGE them, only a direct database edit could. Same
-- is_platform_owner()-gated + audited pattern as update_platform_settings.
create or replace function public.update_platform_contact(
  p_platform_phone text,
  p_platform_email text
)
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

  select platform_phone, platform_email into v_before from public.platform_settings where id = true;

  update public.platform_settings
  set platform_phone = p_platform_phone, platform_email = p_platform_email, updated_at = now()
  where id = true;

  perform public.write_audit_log(
    null, 'update_platform_contact', 'platform_settings', null,
    jsonb_build_object('platform_phone', v_before.platform_phone, 'platform_email', v_before.platform_email),
    jsonb_build_object('platform_phone', p_platform_phone, 'platform_email', p_platform_email),
    null
  );
end;
$function$;

revoke all on function public.update_platform_contact(text, text) from public;
revoke all on function public.update_platform_contact(text, text) from anon;
grant execute on function public.update_platform_contact(text, text) to authenticated;
