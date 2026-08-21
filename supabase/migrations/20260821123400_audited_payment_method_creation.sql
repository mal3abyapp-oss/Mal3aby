-- Complete the payment-method lifecycle by routing creation through the same
-- audited, server-authorized boundary already used for edits/status changes.

create or replace function public.create_payment_method_config(
  p_club_id uuid,
  p_underlying_method text,
  p_provider text,
  p_name_ar text,
  p_name_en text,
  p_instructions_ar text,
  p_instructions_en text,
  p_details jsonb,
  p_customer_visible boolean,
  p_reason text default null
)
returns public.payment_method_configs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_after public.payment_method_configs;
  v_display_order integer;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED'; end if;
  if not exists (select 1 from public.clubs where id = p_club_id) then raise exception 'CLUB_NOT_FOUND'; end if;
  if not public.has_permission('payment.methods.manage', p_club_id) then raise exception 'FORBIDDEN'; end if;
  if p_underlying_method not in ('cash','card','bank_transfer','wallet','other') then
    raise exception 'PAYMENT_METHOD_TYPE_INVALID';
  end if;
  if nullif(btrim(p_name_ar), '') is null or nullif(btrim(p_name_en), '') is null then
    raise exception 'PAYMENT_METHOD_NAME_REQUIRED';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    raise exception 'PAYMENT_METHOD_DETAILS_INVALID';
  end if;

  -- Serialize ordering per tenant so concurrent creates cannot choose the
  -- same next display position.
  perform 1 from public.clubs where id = p_club_id for update;
  select coalesce(max(display_order), -1) + 1 into v_display_order
  from public.payment_method_configs where club_id = p_club_id;

  insert into public.payment_method_configs(
    club_id, underlying_method, provider, name_ar, name_en,
    instructions_ar, instructions_en, details, customer_visible,
    display_order, created_by
  ) values (
    p_club_id, p_underlying_method, nullif(btrim(p_provider), ''),
    btrim(p_name_ar), btrim(p_name_en), nullif(btrim(p_instructions_ar), ''),
    nullif(btrim(p_instructions_en), ''), p_details, p_customer_visible,
    v_display_order, auth.uid()
  ) returning * into v_after;

  perform public.write_audit_log(p_club_id, 'payment_method.created',
    'payment_method_config', v_after.id, null, to_jsonb(v_after),
    nullif(btrim(p_reason), ''));
  return v_after;
end;
$$;

revoke all on function public.create_payment_method_config(uuid,text,text,text,text,text,text,jsonb,boolean,text) from public, anon;
grant execute on function public.create_payment_method_config(uuid,text,text,text,text,text,text,jsonb,boolean,text) to authenticated;

-- Reads remain table-backed. Mutations must use the audited RPCs above.
revoke insert, update, delete on public.payment_method_configs from authenticated;

