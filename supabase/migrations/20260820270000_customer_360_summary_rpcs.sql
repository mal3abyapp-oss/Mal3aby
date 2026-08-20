-- Customer 360 backend, per directive points 7-8:
--   "do not store derived fields such as total_paid/outstanding/
--    total_invoiced on the customer row... compute/read from actual
--    invoices/payments/payment_allocations/refunds through a properly
--    aggregated RPC. UI TOTAL = DB AGGREGATION."
--   "Prefer a small set of paginated/aggregated RPCs... do not create
--    one huge unbounded RPC returning the customer's entire lifetime
--    history. Use pagination for history."
--
-- Six RPCs, each SECURITY DEFINER + the same tenant/permission guard
-- pattern already used everywhere else in this schema (customer.view,
-- matching the RLS policy customers_select_club_staff already uses).
-- None of them write anything to public.customers -- the customer row
-- itself gains no new derived columns; every total here is computed
-- fresh from source tables on every call (STABLE, not cached).

-- 1. Overview summary -- single lightweight call for the header/quick-
-- stats section. Every number is a live aggregate, not a stored field.
create or replace function public.get_customer_360_summary(
  p_club_id uuid,
  p_customer_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
    raise exception 'customer not found';
  end if;

  select jsonb_build_object(
    'customer', jsonb_build_object(
      'id', c.id, 'full_name', c.full_name, 'mobile_display', c.mobile_display,
      'phone_e164', c.phone_e164, 'email', c.email, 'created_at', c.created_at,
      'duplicate_review_status', c.duplicate_review_status
    ),
    'bookings_count', (select count(*) from public.bookings b where b.customer_id = p_customer_id),
    'upcoming_booking', (
      select jsonb_build_object('id', b.id, 'start_at', b.start_at, 'field_name', f.name)
      from public.bookings b join public.fields f on f.id = b.field_id
      where b.customer_id = p_customer_id and b.start_at >= now() and b.status not in ('cancelled', 'no_show')
      order by b.start_at asc limit 1
    ),
    'active_players_count', (
      select count(distinct e.player_id) from public.enrollments e
      join public.guardian_links gl on gl.player_id = e.player_id
      where gl.customer_id = p_customer_id and e.status = 'active'
    ),
    'financial', (
      select jsonb_build_object(
        'total_invoiced', coalesce(sum(s.total), 0),
        'total_paid', coalesce(sum(s.paid), 0),
        'total_refunded', coalesce(sum(s.refunded), 0),
        'outstanding', coalesce(sum(s.outstanding), 0),
        'open_invoices_count', count(*) filter (where s.outstanding > 0)
      )
      from public.invoices i
      cross join lateral public.get_invoice_payment_summary(array[i.id]) s
      where i.customer_id = p_customer_id and i.status not in ('draft', 'void')
    ),
    'whatsapp_consent', (
      select jsonb_build_object('enabled', nc.enabled, 'phone_e164', nc.phone_e164, 'revoked_at', nc.revoked_at, 'consent_at', nc.consent_at)
      from public.notification_consent nc
      where nc.customer_id = p_customer_id and nc.channel = 'whatsapp'
      limit 1
    ),
    'last_payment_at', (
      select max(p.received_at) from public.payments p where p.customer_id = p_customer_id
    )
  ) into v_result
  from public.customers c
  where c.id = p_customer_id;

  return v_result;
end;
$function$;

revoke execute on function public.get_customer_360_summary(uuid, uuid) from public;
revoke execute on function public.get_customer_360_summary(uuid, uuid) from anon;
grant execute on function public.get_customer_360_summary(uuid, uuid) to authenticated;

-- 2. Bookings tab -- paginated (limit/offset), bucketed client-side by
-- start_at like the existing CustomerDetailDialog already does.
create or replace function public.get_customer_bookings(
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
  v_result jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  select jsonb_build_object(
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'start_at', b.start_at, 'end_at', b.end_at, 'status', b.status,
      'total_price', b.total_price, 'field_name', f.name, 'invoice_id', b.invoice_id
    ) order by b.start_at desc), '[]'::jsonb),
    'total_count', count(*) over ()
  ) into v_result
  from public.bookings b
  join public.fields f on f.id = b.field_id
  where b.customer_id = p_customer_id and b.club_id = p_club_id
  order by b.start_at desc
  limit p_limit offset p_offset;

  return coalesce(v_result, jsonb_build_object('rows', '[]'::jsonb, 'total_count', 0));
end;
$function$;

revoke execute on function public.get_customer_bookings(uuid, uuid, int, int) from public;
revoke execute on function public.get_customer_bookings(uuid, uuid, int, int) from anon;
grant execute on function public.get_customer_bookings(uuid, uuid, int, int) to authenticated;

-- 3. Financial account -- ledger (invoices with per-source label) +
-- payment history, both paginated. Every row's paid/outstanding comes
-- from get_invoice_payment_summary(), the same single source of truth
-- every other financial screen already uses -- never recomputed here.
create or replace function public.get_customer_financial_account(
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
  v_ledger jsonb;
  v_payments jsonb;
  v_summary jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  select jsonb_build_object(
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'invoice_id', i.id, 'invoice_number', i.invoice_number, 'issued_at', i.issued_at,
      'status', i.status, 'total', s.total, 'paid', s.paid, 'outstanding', s.outstanding,
      'payment_status', s.payment_status,
      'source', case
        when exists (select 1 from public.bookings b where b.invoice_id = i.id) then 'booking'
        when exists (select 1 from public.subscriptions sub where sub.invoice_id = i.id) then 'academy_subscription'
        else 'other'
      end
    ) order by i.issued_at desc nulls last), '[]'::jsonb),
    'total_count', count(*) over ()
  ) into v_ledger
  from public.invoices i
  cross join lateral public.get_invoice_payment_summary(array[i.id]) s
  where i.customer_id = p_customer_id and i.club_id = p_club_id and i.status not in ('draft', 'void')
  order by i.issued_at desc nulls last
  limit p_limit offset p_offset;

  select jsonb_build_object(
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'amount', p.amount, 'method', p.method, 'received_at', p.received_at,
      'reference', p.reference, 'received_by_name', prof.full_name,
      'official_receipt_serial', ocr.receipt_serial, 'official_receipt_status', ocr.status
    ) order by p.received_at desc), '[]'::jsonb),
    'total_count', count(*) over ()
  ) into v_payments
  from public.payments p
  left join public.profiles prof on prof.user_id = p.received_by
  left join public.official_collection_receipts ocr on ocr.payment_id = p.id
  where p.customer_id = p_customer_id and p.club_id = p_club_id
  order by p.received_at desc
  limit p_limit offset p_offset;

  select jsonb_build_object(
    'total_invoiced', coalesce(sum(s.total), 0),
    'total_paid', coalesce(sum(s.paid), 0),
    'total_refunded', coalesce(sum(s.refunded), 0),
    'outstanding', coalesce(sum(s.outstanding), 0)
  ) into v_summary
  from public.invoices i
  cross join lateral public.get_invoice_payment_summary(array[i.id]) s
  where i.customer_id = p_customer_id and i.club_id = p_club_id and i.status not in ('draft', 'void');

  return jsonb_build_object(
    'summary', coalesce(v_summary, jsonb_build_object('total_invoiced', 0, 'total_paid', 0, 'total_refunded', 0, 'outstanding', 0)),
    'ledger', coalesce(v_ledger, jsonb_build_object('rows', '[]'::jsonb, 'total_count', 0)),
    'payments', coalesce(v_payments, jsonb_build_object('rows', '[]'::jsonb, 'total_count', 0))
  );
end;
$function$;

revoke execute on function public.get_customer_financial_account(uuid, uuid, int, int) from public;
revoke execute on function public.get_customer_financial_account(uuid, uuid, int, int) from anon;
grant execute on function public.get_customer_financial_account(uuid, uuid, int, int) to authenticated;

-- 4. Academy & Players tab -- every player linked via guardian_links,
-- with their current enrollment/subscription status and per-player
-- outstanding (via the same summary function, keyed by that player's
-- own subscription invoice -- never a customer-level snapshot).
create or replace function public.get_customer_academy_players(
  p_club_id uuid,
  p_customer_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'player_id', p.id,
    'full_name', p.full_name,
    'relationship', gl.relationship,
    'is_primary', gl.is_primary,
    'membership_name', g.name,
    'enrollment_status', e.status,
    'subscription_status', s.status,
    'start_date', s.start_date,
    'end_date', s.end_date,
    'outstanding', coalesce(fin.outstanding, 0)
  )), '[]'::jsonb) into v_result
  from public.guardian_links gl
  join public.players p on p.id = gl.player_id
  left join lateral (
    select e2.* from public.enrollments e2
    where e2.player_id = p.id and e2.status = 'active'
    order by e2.enrolled_at desc limit 1
  ) e on true
  left join public.groups g on g.id = e.group_id
  left join lateral (
    select s2.* from public.subscriptions s2
    where s2.enrollment_id = e.id
    order by s2.created_at desc limit 1
  ) s on true
  left join lateral public.get_invoice_payment_summary(array[s.invoice_id]) fin on s.invoice_id is not null
  where gl.customer_id = p_customer_id and p.club_id = p_club_id;

  return v_result;
end;
$function$;

revoke execute on function public.get_customer_academy_players(uuid, uuid) from public;
revoke execute on function public.get_customer_academy_players(uuid, uuid) from anon;
grant execute on function public.get_customer_academy_players(uuid, uuid) to authenticated;

-- 5. WhatsApp & Communication tab -- consent state (read-only summary,
-- reads notification_consent directly, no snapshot) + recent
-- notification_queue events, paginated.
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
  v_events jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  select jsonb_build_object(
    'enabled', nc.enabled, 'phone_e164', nc.phone_e164, 'consent_source', nc.consent_source,
    'consent_at', nc.consent_at, 'revoked_at', nc.revoked_at
  ) into v_consent
  from public.notification_consent nc
  where nc.customer_id = p_customer_id and nc.channel = 'whatsapp';

  select jsonb_build_object(
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'id', nq.id, 'template_key', nq.template_key, 'status', nq.status,
      'created_at', nq.created_at, 'last_attempt_at', nq.last_attempt_at
    ) order by nq.created_at desc), '[]'::jsonb),
    'total_count', count(*) over ()
  ) into v_events
  from public.notification_queue nq
  where nq.recipient_customer_id = p_customer_id and nq.club_id = p_club_id and nq.channel = 'whatsapp'
  order by nq.created_at desc
  limit p_limit offset p_offset;

  return jsonb_build_object(
    'consent', v_consent,
    'events', coalesce(v_events, jsonb_build_object('rows', '[]'::jsonb, 'total_count', 0))
  );
end;
$function$;

revoke execute on function public.get_customer_communications(uuid, uuid, int, int) from public;
revoke execute on function public.get_customer_communications(uuid, uuid, int, int) from anon;
grant execute on function public.get_customer_communications(uuid, uuid, int, int) to authenticated;

-- 6. Activity & Audit tab -- reads the existing audit_logs table
-- (entity_type='customer', entity_id=p_customer_id), paginated. No
-- separate customer-activity table -- reuses the same audit trail
-- every other entity already writes to (write_audit_log(), used
-- throughout this migration and every RPC before it).
create or replace function public.get_customer_activity(
  p_club_id uuid,
  p_customer_id uuid,
  p_limit int default 30,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_limit > 100 then
    raise exception 'p_limit too large -- max 100';
  end if;

  select jsonb_build_object(
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'action', al.action, 'before', al.before, 'after', al.after,
      'created_at', al.created_at, 'actor_name', prof.full_name
    ) order by al.created_at desc), '[]'::jsonb),
    'total_count', count(*) over ()
  ) into v_result
  from public.audit_logs al
  left join public.profiles prof on prof.user_id = al.actor_id
  where al.club_id = p_club_id and al.entity_type = 'customer' and al.entity_id = p_customer_id
  order by al.created_at desc
  limit p_limit offset p_offset;

  return coalesce(v_result, jsonb_build_object('rows', '[]'::jsonb, 'total_count', 0));
end;
$function$;

revoke execute on function public.get_customer_activity(uuid, uuid, int, int) from public;
revoke execute on function public.get_customer_activity(uuid, uuid, int, int) from anon;
grant execute on function public.get_customer_activity(uuid, uuid, int, int) to authenticated;
