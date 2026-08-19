-- Phase A directive (A5/H5): platform_settings changes were a bare table
-- .update() with zero audit trail. write_audit_log() is intentionally
-- internal-only (no authenticated/anon grant -- called via `perform` from
-- other SECURITY DEFINER functions), so a dedicated gated+audited RPC is
-- needed for the client to call instead of writing the table directly.
create or replace function public.update_platform_settings(p_default_trial_days int)
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

  if p_default_trial_days is null or p_default_trial_days < 1 then
    raise exception 'default_trial_days must be a positive integer';
  end if;

  select * into v_before from public.platform_settings where id = true;

  update public.platform_settings
  set default_trial_days = p_default_trial_days, updated_at = now()
  where id = true;

  perform public.write_audit_log(
    null, 'update_platform_settings', 'platform_settings', null,
    jsonb_build_object('default_trial_days', v_before.default_trial_days),
    jsonb_build_object('default_trial_days', p_default_trial_days),
    null
  );
end;
$function$;

revoke all on function public.update_platform_settings(int) from public;
revoke all on function public.update_platform_settings(int) from anon;
grant execute on function public.update_platform_settings(int) to authenticated;
