-- SECURITY FIX (P1, confirmed live-exploitable before this fix):
-- get_customer_communications() authorized the CALLER against p_club_id
-- (their own club) but never verified that p_customer_id actually
-- belongs to that club before reading notification_consent. The
-- notification_queue/events portion was correctly scoped
-- (nq.club_id = p_club_id), but the consent lookup had no club_id
-- filter at all -- any staff member with customer.view on their OWN
-- club could pass ANY customer_id from ANY OTHER club and receive that
-- customer's real WhatsApp phone number, consent status, and consent
-- timestamps. Confirmed exploitable live: a "Test" club staff session
-- retrieved a real QA Full Test Club customer's phone_e164 and consent
-- record by supplying p_club_id=<Test club> with p_customer_id=<QA Full
-- Test Club's customer>.
--
-- Fix: require the customer to belong to p_club_id before returning
-- anything, matching the pattern every other Customer 360 RPC already
-- uses (get_customer_360_summary, get_customer_financial_account, etc.
-- all scope their target row to the authorized club). No behavior
-- change for the correct, same-tenant case.

create or replace function public.get_customer_communications(
  p_club_id uuid,
  p_customer_id uuid,
  p_limit int default 20,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_consent jsonb;
  v_rows jsonb;
  v_total bigint;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
    raise exception 'customer not found';
  end if;

  select jsonb_build_object(
    'enabled', nc.enabled, 'phone_e164', nc.phone_e164, 'consent_source', nc.consent_source,
    'consent_at', nc.consent_at, 'revoked_at', nc.revoked_at
  ) into v_consent
  from public.notification_consent nc
  where nc.customer_id = p_customer_id and nc.club_id = p_club_id and nc.channel = 'whatsapp';

  select count(*) into v_total from public.notification_queue nq
    where nq.recipient_customer_id = p_customer_id and nq.club_id = p_club_id and nq.channel = 'whatsapp';

  with page as (
    select nq.id, nq.template_key, nq.status, nq.created_at, nq.last_attempt_at
    from public.notification_queue nq
    where nq.recipient_customer_id = p_customer_id and nq.club_id = p_club_id and nq.channel = 'whatsapp'
    order by nq.created_at desc
    limit p_limit offset p_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id, 'template_key', page.template_key, 'status', page.status,
    'created_at', page.created_at, 'last_attempt_at', page.last_attempt_at
  ) order by page.created_at desc), '[]'::jsonb) into v_rows
  from page;

  return jsonb_build_object(
    'consent', v_consent,
    'events', jsonb_build_object('rows', v_rows, 'total_count', v_total)
  );
end;
$function$;
