-- Owner-Level Review, Phase 42-43 (permission hardening): create_refund() was
-- gated on 'payment.create' -- the same low-bar permission used for routine
-- payment collection. That let receptionist (front-desk, no elevated trust)
-- independently reverse money out of the club with zero extra authorization,
-- inconsistent with the app's own pattern for other reversal/destructive
-- financial actions (void_invoice requires 'invoice.update', which
-- receptionist does NOT hold). Introduce a dedicated 'payment.refund'
-- permission, grant it only to roles that should be able to reverse money
-- (club_owner, accountant), and re-gate create_refund() on it.

insert into public.permissions (key, description)
values ('payment.refund', 'Issue refunds against completed payments')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where p.key = 'payment.refund'
  and r.key in ('club_owner', 'accountant')
on conflict do nothing;

create or replace function public.create_refund(p_payment_id uuid, p_amount numeric, p_reason text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_payment record;
  v_refunded_sum numeric;
  v_refund_id uuid;
  v_event_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_amount <= 0 then
    raise exception 'refund amount must be positive';
  end if;

  if p_reason is null or trim(p_reason) = '' then
    raise exception 'a reason is required for a refund';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'payment not found';
  end if;

  if not (v_payment.club_id in (select public.user_club_ids()) and public.has_permission('payment.refund', v_payment.club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_payment.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  select coalesce(sum(amount), 0) into v_refunded_sum
  from public.refunds
  where payment_id = p_payment_id and status = 'completed';

  if p_amount > (v_payment.amount - v_refunded_sum) then
    raise exception 'refund amount exceeds refundable balance (refundable: %)', (v_payment.amount - v_refunded_sum);
  end if;

  insert into public.refunds (payment_id, amount, reason, status, refunded_by)
  values (p_payment_id, p_amount, p_reason, 'completed', auth.uid())
  returning id into v_refund_id;

  perform public.write_audit_log(
    v_payment.club_id, 'payment.refund', 'refund', v_refund_id, null,
    jsonb_build_object('payment_id', p_payment_id, 'amount', p_amount),
    p_reason
  );

  v_event_id := public.emit_notification_event(
    v_payment.club_id, 'payment.refunded', 'refund', v_refund_id,
    jsonb_build_object('payment_id', p_payment_id, 'amount', p_amount, 'customer_id', v_payment.customer_id, 'reason', p_reason)
  );

  perform public.queue_whatsapp_notification(
    v_payment.club_id, v_event_id, v_payment.customer_id, 'payment-refunded', 'payment_confirmations',
    jsonb_build_object('amount', p_amount, 'reason', p_reason),
    'transactional', 'payment.refunded:' || v_refund_id::text
  );

  return v_refund_id;
end;
$function$;
